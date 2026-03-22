/**
 * Shared sidepanel state — single mutable object, single source of truth for all tabs.
 */

import type { BmpObject, InspectorMessage, InspectorSettings, ConnectionState, WidgetInfo, ActivityEntry, DetectionPhase, HistoryEntry, FavoriteEntry, PaintPhase } from '../lib/types';
import { DEFAULT_SETTINGS } from '../lib/types';
import { log } from '../lib/logger';
import { ACTIVITY_MAX, RECONNECT_INITIAL_DELAY, RECONNECT_MAX_DELAY } from '../lib/constants';

// ── State ───────────────────────────────────────────────────────

export const S = {
  activeTab: 'connect',
  inspectActive: false,
  cacheCount: 0,
  pageInfo: null as { url: string; rid?: string; tabRid?: string; widgets: WidgetInfo[] } | null,
  cacheObjects: [] as BmpObject[],
  cacheFilter: '',
  settings: { ...DEFAULT_SETTINGS } as InspectorSettings,
  connState: { display: 'checking', version: null, responseMs: null, profileLabel: null, user: null, workspace: null, authError: null, networkOffline: false, lastUpdate: 0 } as ConnectionState,
  detailRid: null as string | null,
  editingProfile: null as { id: string | null; label: string; bmpUrl: string; bmpUser: string; bmpPass: string } | null,
  sortColumn: null as 'type' | 'name' | 'id' | null,
  sortAscending: true,
  typeFilter: null as string | null,

  // Detection — single source of truth, never null
  detection: { phase: 'unknown' as DetectionPhase, confidence: 0, signals: [] as string[] },

  // History & Favorites
  historyEntries: [] as HistoryEntry[],
  favoriteEntries: [] as FavoriteEntry[],
  historyExpanded: false,

  // Paint Format
  paintPhase: 'off' as PaintPhase,
  paintSourceName: null as string | null,

  // Activity
  activityEntries: [] as ActivityEntry[],
  latestActivityMsg: null as string | null,
  latestActivityTimer: null as ReturnType<typeof setTimeout> | null,
};

/** Push an activity entry, capping at 50 */
export function pushActivityEntry(v: ActivityEntry) {
  S.activityEntries.push(v);
  if (S.activityEntries.length > ACTIVITY_MAX) S.activityEntries.shift();
}

// ── Port + messaging ─────────────────────────────────────────────

let port: chrome.runtime.Port | null = null;
let reconnectDelay = RECONNECT_INITIAL_DELAY;
let messageHandler: ((msg: InspectorMessage) => void) | null = null;
let reconnectHandler: (() => void) | null = null;

/** Register handler for incoming SW messages (called once at init) */
export function onPortMessage(handler: (msg: InspectorMessage) => void): void {
  messageHandler = handler;
}

/** Register handler called after successful reconnect (for re-sync) */
export function onReconnect(handler: () => void): void {
  reconnectHandler = handler;
}

/** Connect (or reconnect) the panel port to the service worker */
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
    // Only retry if extension context is still valid
    try {
      chrome.runtime.getURL('');
      setTimeout(() => {
        connectPanel();
        reconnectHandler?.();
      }, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_DELAY);
    } catch (e) {
      log.swallow('panel:reconnectCheck', e);
    }
  });
}

export function sendMessage(msg: InspectorMessage) {
  if (!port) { log.debug('panel', 'sendMessage: port is null, message dropped:', msg.type); return; }
  try { port.postMessage(msg); }
  catch (e) { log.swallow('panel:sendMessage', e); port = null; }
}

// ── Helpers ──────────────────────────────────────────────────────

export function getActivePanel(): HTMLElement | null {
  switch (S.activeTab) {
    case 'page': return document.getElementById('panel-page');
    case 'objects': return document.getElementById('panel-objects');
    case 'log': return document.getElementById('panel-log');
    case 'connect': return document.getElementById('panel-connect');
    default: return null;
  }
}
