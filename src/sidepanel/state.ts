/**
 * Shared sidepanel state — cross-tab state + port management.
 * Tab-specific state lives inside each Tab class.
 */

import type { InspectorMessage, InspectorSettings, ConnectionState, FavoriteEntry, PaintPhase } from '../lib/types';
import { DEFAULT_SETTINGS } from '../lib/types';
import { log } from '../lib/logger';
import { RECONNECT_INITIAL_DELAY, RECONNECT_MAX_DELAY } from '../lib/constants';

// ── Shared state (readable by tabs, header, status bar) ──────────

export const S = {
  // Orchestrator
  activeTab: 'connect' as string,
  detailRid: null as string | null,

  // Shared across tabs + header
  settings: { ...DEFAULT_SETTINGS } as InspectorSettings,
  connState: { display: 'checking', version: null, responseMs: null, profileLabel: null, user: null, workspace: null, authError: null, networkOffline: false, lastUpdate: 0 } as ConnectionState,
  inspectActive: false,
  paintPhase: 'off' as PaintPhase,
  paintSourceName: null as string | null,
  cacheCount: 0,
  favoriteEntries: [] as FavoriteEntry[],
};

// ── Port + messaging ─────────────────────────────────────────────

let port: chrome.runtime.Port | null = null;
let reconnectDelay = RECONNECT_INITIAL_DELAY;
let messageHandler: ((msg: InspectorMessage) => void) | null = null;
let reconnectHandler: (() => void) | null = null;

export function onPortMessage(handler: (msg: InspectorMessage) => void): void {
  messageHandler = handler;
}

export function onReconnect(handler: () => void): void {
  reconnectHandler = handler;
}

export function connectPanel(): void {
  try {
    port = chrome.runtime.connect({ name: 'panel' });
    reconnectDelay = RECONNECT_INITIAL_DELAY;
  } catch (e) {
    log.swallow('panel:connect', e);
    return;
  }

  port.onMessage.addListener((msg: InspectorMessage) => {
    messageHandler?.(msg);
  });

  port.onDisconnect.addListener(() => {
    port = null;
    // Reconnect with backoff — no SW-alive check needed. chrome.runtime.connect()
    // will wake the SW if suspended. The old getURL() check would silently abort
    // reconnection if the SW happened to be suspended at that moment.
    setTimeout(() => {
      connectPanel();
      flushPendingMessages();
      reconnectHandler?.();
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_DELAY);
  });
}

/** Messages queued while port is disconnected (flushed on reconnect). */
const QUEUE_TYPES = new Set([
  'TOGGLE_INSPECT', 'TOGGLE_PAINT', 'CONNECTION_TEST',
  'GET_CONNECTION_STATE', 'GET_SETTINGS', 'GET_CACHE',
]);
const pendingMessages: InspectorMessage[] = [];

export function sendMessage(msg: InspectorMessage) {
  if (!port) {
    if (QUEUE_TYPES.has(msg.type)) pendingMessages.push(msg);
    else log.debug('panel', 'sendMessage: port is null, message dropped:', msg.type);
    return;
  }
  try { port.postMessage(msg); }
  catch (e) { log.swallow('panel:sendMessage', e); port = null; }
}

function flushPendingMessages() {
  while (pendingMessages.length > 0 && port) {
    const msg = pendingMessages.shift()!;
    try { port.postMessage(msg); }
    catch (e) { log.swallow('panel:flushPending', e); port = null; break; }
  }
}

export function getActivePanel(): HTMLElement | null {
  switch (S.activeTab) {
    case 'page': return document.getElementById('panel-page');
    case 'objects': return document.getElementById('panel-objects');
    case 'log': return document.getElementById('panel-log');
    case 'connect': return document.getElementById('panel-connect');
    default: return null;
  }
}
