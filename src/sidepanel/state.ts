/**
 * Shared sidepanel state — cross-tab state + port management.
 * Tab-specific state lives inside each Tab class.
 */

import type { InspectorMessage, InspectorSettings, ConnectionState, FavoriteEntry, PaintPhase } from '../lib/types';
import { DEFAULT_SETTINGS } from '../lib/types';
import { log } from '../lib/logger';
import { createReconnectingPort, type ReconnectingPort } from '../lib/reconnecting-port';
import type { PanelObjectContext } from './context-state';

// ── Shared state (readable by tabs, header, status bar) ──────────

export const S = {
  // Orchestrator
  activeTab: 'connect' as string,
  detailRid: null as string | null,

  // Shared across tabs + header
  settings: { ...DEFAULT_SETTINGS } as InspectorSettings,
  connState: { display: 'checking', version: null, responseMs: null, profileLabel: null, user: null, workspace: null, authError: null, networkOffline: false, lastUpdate: 0 } as ConnectionState,
  // Whether the ACTIVE tab is a BMP page (from per-tab detection). null = unknown/checking. The
  // connState above is a PROFILE/auth indicator (do we hold a session to the configured server) and is
  // orthogonal to "is the page I'm looking at BMP" — the header combines both so a non-BMP tab doesn't
  // read as "connected to <workspace>".
  bmpDetected: null as boolean | null,
  inspectActive: false,
  blueprintActive: false,
  paintPhase: 'off' as PaintPhase,
  paintSourceName: null as string | null,
  cacheCount: 0,
  favoriteEntries: [] as FavoriteEntry[],
  // Latest BMP-tab context — populated by CONTEXT_RID_DATA broadcasts (from
  // right-click or the Page-tab picker). Status bar chip surfaces this so
  // the user always sees "what am I working on" across tabs.
  context: null as PanelObjectContext | null,
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
const preHelloQueue: InspectorMessage[] = [];

export function onPortMessage(handler: (msg: InspectorMessage) => void): void {
  messageHandler = handler;
}

export function onReconnect(handler: () => void): void {
  reconnectHandler = handler;
}

/** Message types worth queuing while the SW port is bouncing. These are
 *  state-syncing requests; one-off actions get dropped (the user can retry). */
const QUEUE_TYPES = new Set([
  'TOGGLE_INSPECT', 'TOGGLE_PAINT', 'CONNECTION_TEST',
  'GET_CONNECTION_STATE', 'GET_SETTINGS', 'GET_CACHE',
  'GET_PAGE_INFO', 'GET_ACTIVITY', 'GET_CONTEXT_RID', 'GET_DETECTION',
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
      if (QUEUE_TYPES.has(msg.type)) preHelloQueue.push(msg);
      while (preHelloQueue.length > 20) preHelloQueue.shift();
    },
  });
  // Initial hello — once we know our windowId.
  sendPanelHello();
}

function sendPanelHello(): void {
  void windowIdReady.then(() => {
    if (panelWindowId != null) {
      portInstance?.send({ type: 'PANEL_HELLO', windowId: panelWindowId });
    }
    // Flip the gate even if windowId is null — otherwise sendMessage
    // queues forever in private-browsing / locked-down contexts where
    // chrome.windows.getCurrent didn't yield a usable id. The SW will
    // fall back to lastFocusedWindow for those messages.
    helloSent = true;
    for (const m of preHelloQueue) portInstance?.send(m);
    preHelloQueue.length = 0;
  });
}

export function sendMessage(msg: InspectorMessage): void {
  // Hold non-handshake messages until PANEL_HELLO has been sent.
  // Without this, switchTab() in the boot path could race PANEL_HELLO
  // and reach the SW first — meta.panelWindowId would be undefined and
  // the SW would route the response to lastFocusedWindow instead of
  // this panel's window.
  if (!helloSent && msg.type !== 'PANEL_HELLO') {
    preHelloQueue.push(msg);
    return;
  }
  const delivered = portInstance?.send(msg) ?? false;
  if (!delivered && !QUEUE_TYPES.has(msg.type)) {
    log.debug('panel', 'sendMessage: port is null, message dropped:', msg.type);
  }
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
