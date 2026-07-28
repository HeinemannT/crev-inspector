import type { BmpClient } from './bmp-client';
import type { ObjectCache } from './object-cache';
import type { HistoryManager } from './history';
import type { FavoritesManager } from './favorites';
import type { ScriptHistoryManager } from './script-history';
import type { StylePresetStore } from './style-presets';
import type { InspectorMessage, InspectorSettings, ActivityEntry, ActivityMeta } from './types';

/** Shared mutable context passed to all service-worker modules. */
export interface SwContext {
  client: BmpClient | null;
  /** True when at least one side panel is currently connected. Code that
   *  needs to know "is the panel open at all" reads this. For routing
   *  decisions ("which panel"), use `panelPortByWindow` instead. */
  hasPanel: boolean;
  /** Side-panel ports keyed by the windowId the panel lives in. Chrome
   *  allows one side panel per browser window, so multiple windows can
   *  each have their own panel instance. */
  panelPortByWindow: Map<number, chrome.runtime.Port>;
  contentPorts: Map<number, chrome.runtime.Port>;
  cache: ObjectCache;
  history: HistoryManager;
  favorites: FavoritesManager;
  scriptHistory: ScriptHistoryManager;
  stylePresets: StylePresetStore;
  settings: InspectorSettings;
  /** Per-window inspect-mode state. Each browser window has its own
   *  toggle — a user inspecting in window A doesn't paint pills onto
   *  window B's BMP tab. Previously this was a single global boolean
   *  which surprised users who wanted "inspect this one window's BMP
   *  tab" rather than "inspect every BMP tab everywhere". */
  inspectActiveByWindow: Map<number, boolean>;
  /** Per-window blueprint-mode toggle state (see service-worker.ts). Cleared on profile switch. */
  blueprintActiveByWindow: Map<number, boolean>;
  /** The specific tab the blueprint overlay is on, per window — so a navigation/refresh of THAT tab
   *  ends the session reliably (the active-tab map is empty until the first tab switch). */
  blueprintTabByWindow: Map<number, number>;
  /** Returns whether inspect mode is active in the given window. */
  isInspectActive(windowId: number | undefined): boolean;
  /** Set inspect mode for a window and persist the change. */
  setInspectActive(windowId: number, active: boolean): void;
  /** Persist blueprintActiveByWindow + blueprintTabByWindow to chrome.storage.session so the toggle
   *  survives an MV3 SW idle-suspend. Call after any mutation to those maps (mirrors setInspectActive's
   *  persistence). Restored at boot before settingsReady — see service-worker.ts restoreBlueprintState. */
  persistBlueprintState(): void;
  technicalOverlay: boolean;
  settingsReady: Promise<void>;

  logActivity(level: ActivityEntry['level'], message: string, detail?: string, meta?: ActivityMeta): void;
  /** Broadcast to every connected panel. Use for global state updates
   *  (CONNECTION_STATE, SETTINGS_DATA, ACTIVITY_ENTRY, …) — anything
   *  that's the same across windows. */
  sendToPanel(msg: InspectorMessage): void;
  /** Send to the panel attached to a specific window. Use for replies
   *  to a panel-initiated request when you know the requesting window. */
  sendToPanelByWindow(windowId: number, msg: InspectorMessage): void;
  /** Send to whichever panel is in the same window as the given tab.
   *  Use for tab-event-driven pushes (PAGE_INFO refresh on URL change,
   *  DETECTION_STATE update on content-script connect, …) so the right
   *  panel updates even when multiple panels are open in different
   *  windows. */
  sendToPanelByTab(tabId: number, msg: InspectorMessage): void;
  broadcastToContent(msg: InspectorMessage): void;
  /** Fire an ephemeral panel toast. The activity log keeps a permanent
   *  record; toasts are for user-visible failures the user should see
   *  immediately (save failed, EC failed, server unreachable). */
  toast(text: string, kind: 'success' | 'error' | 'info'): void;
}

// ── Global context accessor ──────────────────────────────────────

let _ctx: SwContext | null = null;

/** Set the shared context (called once at SW boot). */
export function setSwContext(ctx: SwContext): void {
  _ctx = ctx;
}

/** Get the shared context. Throws if called before setSwContext(). */
export function getCtx(): SwContext {
  if (!_ctx) throw new Error('SwContext not initialized — call setSwContext() first');
  return _ctx;
}
