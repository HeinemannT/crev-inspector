/**
 * Shared sidepanel state — single mutable object, single source of truth for all tabs.
 */

import type { BmpObject, InspectorMessage, InspectorSettings, ConnectionState, WidgetInfo, PaintPhase, ActivityEntry, DetectionPhase } from '../lib/types';
import { DEFAULT_SETTINGS } from '../lib/types';
import { log } from '../lib/logger';
import { ACTIVITY_MAX } from '../lib/constants';

// ── State ───────────────────────────────────────────────────────

export const S = {
  activeTab: 'connect',
  inspectActive: false,
  cacheCount: 0,
  pageInfo: null as { url: string; rid?: string; tabRid?: string; widgets: WidgetInfo[] } | null,
  cacheObjects: [] as BmpObject[],
  cacheFilter: '',
  settings: { ...DEFAULT_SETTINGS } as InspectorSettings,
  connState: { display: 'checking', version: null, responseMs: null, profileLabel: null, user: null, workspace: null, authError: null, lastUpdate: 0 } as ConnectionState,
  detailRid: null as string | null,
  paintPhase: 'off' as PaintPhase,
  paintSourceName: null as string | null,
  editingProfile: null as { id: string | null; label: string; bmpUrl: string; bmpUser: string; bmpPass: string } | null,
  sortColumn: null as 'type' | 'name' | 'id' | null,
  sortAscending: true,
  typeFilter: null as string | null,

  // Detection — single source of truth, never null
  detection: { phase: 'unknown' as DetectionPhase, confidence: 0, signals: [] as string[] },

  // EC Console state
  ecConsoleCode: '',
  ecConsoleOutput: null as string | null,
  ecConsoleOk: true,
  ecConsoleHasWarning: false,
  ecConsoleWaiting: false,
  ecConsoleStartTime: 0,
  ecConsoleDurationMs: null as number | null,
  ecConsoleMode: null as 'preview' | 'execute' | null,
  ecConsoleExpanded: false,

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

export const port = chrome.runtime.connect({ name: 'panel' });

export function sendMessage(msg: InspectorMessage) {
  try { port.postMessage(msg); } catch (e) { log.swallow('panel:sendMessage', e); }
}

// ── Helpers ──────────────────────────────────────────────────────

export function getActivePanel(): HTMLElement | null {
  switch (S.activeTab) {
    case 'page': return document.getElementById('panel-page');
    case 'script': return document.getElementById('panel-script');
    case 'objects': return document.getElementById('panel-objects');
    case 'log': return document.getElementById('panel-log');
    case 'connect': return document.getElementById('panel-connect');
    default: return null;
  }
}
