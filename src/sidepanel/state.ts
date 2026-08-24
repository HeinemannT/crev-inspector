/**
 * Shared sidepanel state — cross-tab state + port management.
 * Tab-specific state lives inside each Tab class.
 */

import type { InspectorMessage, InspectorSettings, ConnectionState, FavoriteEntry } from '../lib/types';
import { DEFAULT_SETTINGS } from '../lib/types';
import { unknownIdentityMap } from '../lib/identity-map';
import { log } from '../lib/logger';
import { createReconnectingPort, type ReconnectingPort } from '../lib/reconnecting-port';
import type { PanelObjectContext } from './context-state';
import { workStatusForMessage, type WorkStatus } from './work-status';

// ── Shared state (readable by tabs, header, status bar) ──────────

export const S = {
  // Orchestrator
  activeTab: 'connect' as string,
  detailRid: null as string | null,

  // Shared across tabs + header
  settings: { ...DEFAULT_SETTINGS } as InspectorSettings,
  connState: { display: 'checking', identities: unknownIdentityMap(), version: null, responseMs: null, profileLabel: null, workspace: null, authError: null, networkOffline: false, lastUpdate: 0 } as ConnectionState,
  // Whether the ACTIVE tab is a BMP page (from per-tab detection). null = unknown/checking. The
  // connState above is a PROFILE/auth indicator (do we hold a session to the configured server) and is
  // orthogonal to "is the page I'm looking at BMP" — the header combines both so a non-BMP tab doesn't
  // read as "connected to <workspace>".
  bmpDetected: null as boolean | null,
  inspectActive: false,
  blueprintActive: false,
  cacheCount: 0,
  favoriteEntries: [] as FavoriteEntry[],
  // Latest BMP-tab context — populated by CONTEXT_RID_DATA broadcasts (from
  // right-click or the Page-tab picker). Status bar chip surfaces this so
  // the user always sees "what am I working on" across tabs.
  context: null as PanelObjectContext | null,
  // Live BMP page/tab context. Unlike `context`, this does not follow object
  // drill-down in Inspect; AI uses it to scope read_layout to the viewed tab.
  page: null as { rid: string; tabRid?: string; tabName?: string } | null,
  // EC round-trip latency from the last execute or preview. Health-poll
  // latency lives on connState.responseMs; this is the user-action signal
  // (real EC against the live workspace) which matters more for "is BMP
  // slow right now".
  lastEcMs: null as number | null,
};

// ── Port + messaging ─────────────────────────────────────────────

let portInstance: ReconnectingPort | null = null;
let messageHandler: ((msg: InspectorMessage) => void) | null = null;
let reconnectHandler: (() => void) | null = null;
let workStatusHandler: ((status: WorkStatus) => void) | null = null;
const panelIncarnation = typeof crypto?.randomUUID === 'function'
  ? crypto.randomUUID()
  : `${Date.now()}-${Math.random()}`;
const panelCreatedAt = typeof performance !== 'undefined'
  ? performance.timeOrigin + performance.now()
  : Date.now();
/** Window this panel is attached to. Discovered via chrome.windows.getCurrent
 *  at boot and re-asserted on every (re)connect via PANEL_HELLO so the SW
 *  can route window-scoped messages (PAGE_INFO, DETECTION_STATE, CONTEXT_RID_DATA)
 *  to the right panel when two panels are open in different windows. */
let panelWindowId: number | null = null;
/** Promise that resolves once panelWindowId is known. connectPanel() awaits
 *  this so the very first message we ever send is PANEL_HELLO with the
 *  correct windowId — no race where GET_SETTINGS arrives before the SW
 *  has registered this port. */
let windowIdReady: Promise<void> = (async () => {
  try {
    const win = await chrome.windows.getCurrent({ populate: false });
    if (win?.id != null) panelWindowId = win.id;
  } catch (e) { log.swallow('panel:windowDiscover', e); }
})();

/** True once PANEL_HELLO has been sent on the current port. sendMessage
 *  queues outbound messages while false so the SW always sees PANEL_HELLO
 *  before any window-scoped request (GET_PAGE_INFO, GET_CONTEXT_RID, etc.).
 *  Reset to false on every (re)connect; flipped to true after sendPanelHello
 *  completes. */
let helloSent = false;
/** Monotonic ownership token for async PANEL_HELLO continuations. A failed
 * send or a newer reconnect invalidates older windowIdReady callbacks. */
let helloAttempt = 0;
const preHelloQueue: InspectorMessage[] = [];

export function onPortMessage(handler: (msg: InspectorMessage) => void): void {
  messageHandler = handler;
}

export function onReconnect(handler: () => void): void {
  reconnectHandler = handler;
}

export function onWorkStatus(handler: (status: WorkStatus) => void): void {
  workStatusHandler = handler;
}

/** Message types worth queuing while the SW port is bouncing. These are
 *  state-syncing requests; one-off actions get dropped (the user can retry). */
const QUEUE_TYPES = new Set([
  'GET_CONNECTION_STATE', 'GET_SETTINGS', 'GET_CACHE',
  'GET_PAGE_INFO', 'GET_ACTIVITY', 'GET_CONTEXT_RID', 'GET_DETECTION',
  'AI_GET_EDITOR_CONTEXT',
]);

export function connectPanel(): void {
  if (portInstance) return; // idempotent
  portInstance = createReconnectingPort({
    name: 'panel',
    onMessage: (msg) => {
      if (msg.type === 'PANEL_SUPERSEDED') {
        // A second panel document claimed this Chrome window. Permanently
        // retire this document's port: a normal disconnect would invoke the
        // 200 ms reconnect path, reclaim the window, disconnect the other
        // panel, and make both documents ping-pong forever.
        portInstance?.destroy();
        portInstance = null;
        helloSent = false;
        preHelloQueue.length = 0;
        return;
      }
      messageHandler?.(msg);
    },
    onReconnect: () => {
      // Each (re)connect needs a fresh PANEL_HELLO. Reset the gate and
      // queue any sendMessage calls the reconnect handler issues
      // synchronously after this callback returns — they'll flush
      // once PANEL_HELLO lands at the SW.
      helloSent = false;
      sendPanelHello();
      reconnectHandler?.();
    },
    enqueueOnDisconnect: (_outerQueue, msg) => {
      // Route disconnect-period queueing through OUR preHelloQueue, not
      // the ReconnectingPort's outer queue. The outer queue would flush
      // on reconnect BEFORE our onReconnect callback fires PANEL_HELLO
      // — messages would reach the SW without panelWindowId metadata
      // and get routed to lastFocusedWindow. Routing through preHelloQueue
      // serialises the flush behind PANEL_HELLO via sendPanelHello's
      // microtask. Also reset helloSent because the port is gone — any
      // subsequent sendMessage calls should be gated too.
      helloSent = false;
      helloAttempt++;
      if (QUEUE_TYPES.has(msg.type)) preHelloQueue.push(msg);
      while (preHelloQueue.length > 20) preHelloQueue.shift();
    },
  });
  // Initial hello — once we know our windowId.
  sendPanelHello();
}

function sendPanelHello(): void {
  const attempt = ++helloAttempt;
  void windowIdReady.then(() => {
    if (attempt !== helloAttempt || !portInstance) return;
    if (panelWindowId != null) {
      const delivered = portInstance.send({
        type: 'PANEL_HELLO',
        windowId: panelWindowId,
        panelIncarnation,
        panelCreatedAt,
      });
      // send() routes through enqueueOnDisconnect on failure, which also
      // invalidates this attempt. Never open the gate unless HELLO reached
      // the concrete Port for this reconnect generation.
      if (!delivered) return;
    }
    // Flip the gate even if windowId is null — otherwise sendMessage
    // queues forever in private-browsing / locked-down contexts where
    // chrome.windows.getCurrent didn't yield a usable id. The SW will
    // fall back to lastFocusedWindow for those messages.
    helloSent = true;
    // Detach the batch before sending. A failed send is re-enqueued by the
    // disconnect hook; retain the untouched suffix here rather than clearing
    // messages that never reached the worker.
    const batch = preHelloQueue.splice(0);
    for (let i = 0; i < batch.length; i++) {
      if (attempt !== helloAttempt || !portInstance) {
        preHelloQueue.unshift(...batch.slice(i));
        return;
      }
      if (!portInstance.send(batch[i])) {
        preHelloQueue.push(...batch.slice(i + 1));
        while (preHelloQueue.length > 20) preHelloQueue.shift();
        return;
      }
    }
  });
}

export function sendMessage(msg: InspectorMessage): boolean {
  const status = workStatusForMessage(msg);

  // Hold non-handshake messages until PANEL_HELLO has been sent.
  // Without this, switchTab() in the boot path could race PANEL_HELLO
  // and reach the SW first — meta.panelWindowId would be undefined and
  // the SW would route the response to lastFocusedWindow instead of
  // this panel's window.
  if (!helloSent && msg.type !== 'PANEL_HELLO') {
    if (QUEUE_TYPES.has(msg.type)) {
      preHelloQueue.push(msg);
    } else {
      log.debug('panel', 'sendMessage: handshake pending, unsafe message dropped:', msg.type);
      if (status) workStatusHandler?.({ text: 'Connection interrupted — retry', working: false });
    }
    return false;
  }
  const delivered = portInstance?.send(msg) ?? false;
  if (delivered && status) workStatusHandler?.(status);
  if (!delivered && !QUEUE_TYPES.has(msg.type)) {
    log.debug('panel', 'sendMessage: port is null, message dropped:', msg.type);
    if (status) workStatusHandler?.({ text: 'Connection interrupted — retry', working: false });
  }
  return delivered;
}

/** DOM id for a tab's panel element. Centralized so the "panel-" prefix
 *  lives in one place — callers ask by tab name, not by hardcoded id. */
export function tabPanelId(tabName: string): string {
  return 'panel-' + tabName;
}

export function getTabPanel(tabName: string): HTMLElement | null {
  return document.getElementById(tabPanelId(tabName));
}

export function getActivePanel(): HTMLElement | null {
  return getTabPanel(S.activeTab);
}
