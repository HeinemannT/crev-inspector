/**
 * Background service worker — thin entry point.
 * State, context, port management, boot sequence.
 * All logic delegated to focused modules.
 */

import type { InspectorMessage, InspectorSettings } from './lib/types';
import { DEFAULT_SETTINGS } from './lib/types';
import { ObjectCache } from './lib/object-cache';
import { HistoryManager } from './lib/history';
import { FavoritesManager } from './lib/favorites';
import { ScriptHistoryManager } from './lib/script-history';
import { StylePresetStore } from './lib/style-presets';
import type { SwContext } from './lib/sw-context';
import { setSwContext } from './lib/sw-context';
import { log } from './lib/logger';

// Modules
import { loadTabDetection, getTabDetection } from './lib/detection';
import { ensureConnectionMonitoring, stopHealthPolling, pollHealth } from './lib/connection';
import { restoreActivity, logActivity } from './lib/activity';
import { createSettingsReady, loadSettingsFrom, onProfileSwitch, handleSessionCookieRemoved } from './lib/settings';
import { registerTabListeners, sendPageInfoToPanel } from './lib/tab-awareness';
import { handleContentMessage, handlePanelMessage, handleOneShotMessage, toggleInspect, toggleBlueprint } from './lib/message-router';
import { setContextRid, getContextRid, deleteContextRid } from './lib/context-rid';
import { pushPaintState, paintStateMessage, cancelPaint } from './lib/paint';
import { openEditorWindow, openExtendedWindow } from './lib/editor';
import { openCodeSearchWindow } from './lib/codesearch-launcher';
import { initSiteAccess, reconcileProfileOrigins } from './lib/site-access';
import { openDiffWindow } from './lib/diff-launcher';

// ── State ───────────────────────────────────────────────────────

// Cache initialized with default profile; will be switched once settings load
const cache = new ObjectCache('_default');
const history = new HistoryManager('_default');
const favorites = new FavoritesManager('_default');
const scriptHistory = new ScriptHistoryManager('_default');
const stylePresets = new StylePresetStore('_default');
/** Per-window inspect-mode flag. Persisted to chrome.storage.session so
 *  toggling survives SW idle-suspend within a single browser session.
 *  Window IDs aren't stable across browser restarts; cleanup happens on
 *  chrome.windows.onRemoved + at boot we drop entries whose window
 *  doesn't exist anymore. */
const inspectActiveByWindow = new Map<number, boolean>();
/** Per-window blueprint-mode toggle state. On the ctx (not a handler-local Map) so it sits with the
 *  other per-window UI toggles and can be cleared on a profile switch (the loaded layout is env-bound). */
const blueprintActiveByWindow = new Map<number, boolean>();
const blueprintTabByWindow = new Map<number, number>();
let technicalOverlay = false;
let settings: InspectorSettings = { ...DEFAULT_SETTINGS };
let client: import('./lib/bmp-client').BmpClient | null = null;

const contentPorts = new Map<number, chrome.runtime.Port>();

// Side-panel ports indexed by the windowId they live in. Chrome allows one
// panel per browser window; with two windows open the user can have two
// panel instances connected simultaneously. The original singleton
// `panelPort` made the second connect silently steal the first panel's
// channel, which is the bug this Map fixes.
const panelPortByWindow = new Map<number, chrome.runtime.Port>();
// Reverse lookup so the disconnect handler can find which windowId a
// disconnecting port was attached to (Chrome doesn't give us the windowId
// in the disconnect event).
const portToWindowId = new Map<chrome.runtime.Port, number>();

const PANEL_MSG_CAP = 100;
const pendingPanelMessages: InspectorMessage[] = [];

function broadcastToPanels(msg: InspectorMessage) {
  if (panelPortByWindow.size === 0) {
    // No panels open — queue with the same dedup semantics as the legacy
    // singleton path so the first panel that opens after the SW starts
    // gets fresh state without duplicates.
    const DEDUP_TYPES = new Set(['CONNECTION_STATE', 'DETECTION_STATE']);
    if (DEDUP_TYPES.has(msg.type)) {
      const idx = pendingPanelMessages.findIndex(m => m.type === msg.type);
      if (idx >= 0) pendingPanelMessages.splice(idx, 1);
    }
    pendingPanelMessages.push(msg);
    if (pendingPanelMessages.length > PANEL_MSG_CAP) {
      const dropped = pendingPanelMessages.length - PANEL_MSG_CAP;
      log.warn('sw:panelOverflow', `Panel queue overflowed, dropping ${dropped} oldest messages`);
      pendingPanelMessages.splice(0, dropped);
    }
    return;
  }
  for (const port of panelPortByWindow.values()) {
    try { port.postMessage(msg); }
    catch (e) { log.swallow('sw:broadcastToPanels', e); }
  }
}

function sendToPanelByWindow(windowId: number, msg: InspectorMessage) {
  const port = panelPortByWindow.get(windowId);
  if (port) {
    try { port.postMessage(msg); }
    catch (e) { log.swallow('sw:sendToPanelByWindow', e); }
  }
}

function sendToPanelByTab(tabId: number, msg: InspectorMessage) {
  // Look up the tab's windowId then route. Cheap call (Chrome cache);
  // fire-and-forget — if the tab is gone, no panel needs the message.
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab?.windowId) return;
    sendToPanelByWindow(tab.windowId, msg);
  });
}

// ── Context ─────────────────────────────────────────────────────

const { settingsReady, resolveSettings } = createSettingsReady();

const ctx: SwContext = {
  get client() { return client; },
  set client(v) { client = v; },
  get hasPanel() { return panelPortByWindow.size > 0; },
  panelPortByWindow,
  contentPorts,
  cache,
  history,
  favorites,
  stylePresets,
  scriptHistory,
  get settings() { return settings; },
  set settings(v) { settings = v; },
  inspectActiveByWindow,
  blueprintActiveByWindow,
  blueprintTabByWindow,
  isInspectActive(windowId: number | undefined): boolean {
    return windowId != null && inspectActiveByWindow.get(windowId) === true;
  },
  setInspectActive(windowId: number, active: boolean): void {
    if (active) inspectActiveByWindow.set(windowId, true);
    else inspectActiveByWindow.delete(windowId);
    persistInspectState();
  },
  persistBlueprintState,
  get technicalOverlay() { return technicalOverlay; },
  set technicalOverlay(v) { technicalOverlay = v; },
  settingsReady,
  logActivity,
  sendToPanel: broadcastToPanels,
  sendToPanelByWindow,
  sendToPanelByTab,
  broadcastToContent(msg: InspectorMessage) {
    for (const port of contentPorts.values()) {
      try { port.postMessage(msg); } catch (e) { log.swallow('sw:broadcastToContent', e); }
    }
  },
  toast(text, kind) {
    // Push the TOAST to every connected panel. Callers that ALSO want a
    // permanent record in the Log tab call ctx.logActivity() separately —
    // we don't mirror automatically so handlers that already log can't
    // accidentally double-log.
    ctx.sendToPanel({ type: 'TOAST', text, kind });
  },
};

// ── Init ─────────────────────────────────────────────────────────

setSwContext(ctx);
registerTabListeners();

// ── Boot ────────────────────────────────────────────────────────

/** Per-window inspect state restore. Runs in parallel with the other
 *  state-manager loads so it completes BEFORE settingsReady resolves —
 *  otherwise handlers gated on settingsReady could read an empty
 *  inspectActiveByWindow Map and miss the user's pre-restart toggle. */
async function restoreInspectState(): Promise<void> {
  try {
    const sess = await chrome.storage.session.get('crev_inspect_active_by_window');
    const saved = sess.crev_inspect_active_by_window as Record<string, boolean> | undefined;
    if (!saved) return;
    const liveWindows = await chrome.windows.getAll();
    const liveIds = new Set(liveWindows.map(w => w.id).filter((id): id is number => id != null));
    for (const [k, v] of Object.entries(saved)) {
      const id = Number(k);
      // Drop entries for closed windows so a future window assigned the
      // same id doesn't inherit stale state.
      if (Number.isFinite(id) && liveIds.has(id) && v === true) {
        inspectActiveByWindow.set(id, true);
      }
    }
  } catch (e) { log.swallow('sw:restoreInspect', e); }
}

/** Per-window blueprint state restore — the mirror of restoreInspectState. Runs inside the boot
 *  Promise.all so it completes BEFORE settingsReady resolves; since every handler awaits settingsReady,
 *  the toggle/exit paths never read an empty map after an SW restart (that was the "X does nothing" bug).
 *  Entries for windows that no longer exist are dropped so a recycled window id can't inherit stale state. */
async function restoreBlueprintState(): Promise<void> {
  try {
    const sess = await chrome.storage.session.get(['crev_blueprint_active_by_window', 'crev_blueprint_tab_by_window']);
    const active = sess.crev_blueprint_active_by_window as Record<string, boolean> | undefined;
    const tabs = sess.crev_blueprint_tab_by_window as Record<string, number> | undefined;
    if (!active && !tabs) return;
    const liveWindows = await chrome.windows.getAll();
    const liveIds = new Set(liveWindows.map(w => w.id).filter((id): id is number => id != null));
    for (const [k, v] of Object.entries(active ?? {})) {
      const id = Number(k);
      if (Number.isFinite(id) && liveIds.has(id) && v === true) blueprintActiveByWindow.set(id, true);
    }
    for (const [k, v] of Object.entries(tabs ?? {})) {
      const id = Number(k);
      // Only keep the pinned tab for a window whose blueprint is (still) active — a stale tab for an
      // inactive window is noise the toggle would ignore anyway.
      if (Number.isFinite(id) && liveIds.has(id) && blueprintActiveByWindow.get(id) === true) blueprintTabByWindow.set(id, v);
    }
  } catch (e) { log.swallow('sw:restoreBlueprint', e); }
}

// Boot: load state managers independently (one failure must not block the rest)
Promise.all([
  cache.load().catch(e => log.swallow('sw:cache', e)),
  history.load().catch(e => log.swallow('sw:history', e)),
  favorites.load().catch(e => log.swallow('sw:favorites', e)),
  scriptHistory.load().catch(e => log.swallow('sw:scriptHistory', e)),
  stylePresets.load().catch(e => log.swallow('sw:stylePresets', e)),
  restoreActivity().catch(e => log.swallow('sw:activity', e)),
  loadTabDetection().catch(e => log.swallow('sw:tabDetection', e)),
  restoreInspectState().catch(e => log.swallow('sw:restoreInspect', e)),
  restoreBlueprintState().catch(e => log.swallow('sw:restoreBlueprint', e)),
]).then(async () => {
  const stored = await chrome.storage.local.get(['crev_settings']).catch(e => { log.swallow('sw:loadStorage', e); return {} as Record<string, unknown>; });
  await loadSettingsFrom((stored as Record<string, unknown>).crev_settings);

  // Drop the legacy global inspect-active key one-shot so storage stays clean.
  chrome.storage.local.remove('crev_inspect_active').catch(() => { /* fine if absent */ });
}).catch(e => {
  log.swallow('sw:init', e);
  resolveSettings(); // ensure settingsReady resolves even on catastrophic failure
});

function persistInspectState() {
  const obj: Record<string, boolean> = {};
  for (const [k, v] of inspectActiveByWindow) if (v) obj[String(k)] = true;
  chrome.storage.session.set({ crev_inspect_active_by_window: obj })
    .catch(e => log.swallow('sw:persistInspect', e));
}

/** Per-window blueprint toggle state, persisted to chrome.storage.session so it survives an MV3 SW
 *  idle-suspend within a browser session — the same treatment inspect gets above, and for the same
 *  reason: the toggle (BLUEPRINT_TOGGLE / Ctrl+Shift+B / the side-panel button) reads the in-memory map
 *  to decide on/off, and a wiped map made it flip the WRONG way (an empty map read as "off" → re-activate,
 *  so Exit appeared dead). Restored at boot BEFORE settingsReady (see restoreBlueprintState). The pinned
 *  tab rides along so a post-apply resume still targets the right tab after a restart. */
function persistBlueprintState() {
  const active: Record<string, boolean> = {};
  for (const [k, v] of blueprintActiveByWindow) if (v) active[String(k)] = true;
  const tabs: Record<string, number> = {};
  for (const [k, v] of blueprintTabByWindow) tabs[String(k)] = v;
  chrome.storage.session.set({ crev_blueprint_active_by_window: active, crev_blueprint_tab_by_window: tabs })
    .catch(e => log.swallow('sw:persistBlueprint', e));
}

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(e => log.swallow('sw:sidePanel', e));

// Per-site access: reconcile the dynamic content-script registrations with the granted origins at
// boot and on every grant/revoke. Nothing is injected anywhere until the user approves a site.
initSiteAccess();
// Access invariant: grants ≡ configured profile origins. The boot reconcile also serves as the
// one-time migration off the legacy `<all_urls>` grant that pre-0.5.3 installs carried over
// (it isn't a profile origin, so it gets revoked here).
void settingsReady.then(() => reconcileProfileOrigins(ctx.settings.profiles.map(p => p.bmpUrl), ctx.settings.ai?.customProvider));

chrome.windows.onRemoved.addListener((id) => {
  // Drop the closed window's inspect-mode entry; otherwise a future
  // window assigned the same ID would inherit stale state.
  if (inspectActiveByWindow.delete(id)) persistInspectState();
  // Same for blueprint (active flag + pinned tab), for the same recycled-window-id reason.
  const hadBp = blueprintActiveByWindow.delete(id);
  const hadTab = blueprintTabByWindow.delete(id);
  if (hadBp || hadTab) persistBlueprintState();
});

// ── Context menus ──────────────────────────────────────────────

async function rebuildContextMenus() {
  const items: Array<chrome.contextMenus.CreateProperties> = [
    { id: 'crev-copy-rid', title: 'Copy RID' },
    { id: 'crev-copy-bid', title: 'Copy Business ID' },
    { id: 'crev-copy-name', title: 'Copy Name' },
    { id: 'crev-sep-1', type: 'separator' },
    { id: 'crev-view-props', title: 'View Properties' },
    { id: 'crev-open-editor', title: 'Open Editor' },
    { id: 'crev-sep-2', type: 'separator' },
    { id: 'crev-compare', title: 'Compare with\u2026' },
    { id: 'crev-search-code', title: 'Search Code' },
  ];
  for (const item of items) {
    chrome.contextMenus.create({ ...item, contexts: ['all'] });
  }
  // If we have a half-completed compare from a previous SW lifetime, reflect it.
  // Pivot is now keyed per-profile, so we need the active profile id first.
  await ctx.settingsReady.catch(() => { /* boot race; pivot restore is best-effort */ });
  try {
    const pivot = await getComparePivot();
    if (pivot) void chrome.contextMenus.update('crev-compare', { title: `Compare with ${pivot.name ?? pivot.rid}\u2026` });
  } catch (e) { log.swallow('sw:restoreComparePivot', e); }
}

chrome.contextMenus.removeAll(() => { void rebuildContextMenus(); });

/** Compare pivot lives in chrome.storage.session, scoped per profile.
 *  Pinning a sbx object then alt-tabbing to dev no longer shows a stale
 *  "Compare with <sbx-rid>" \u2014 dev's pivot is independent. */
type ComparePivot = { rid: string; name?: string };

function compareKey(): string {
  const profileId = ctx.settings?.activeProfileId || '_default';
  return `crev_compare_pivot_${profileId}`;
}

async function getComparePivot(): Promise<ComparePivot | null> {
  const key = compareKey();
  const r = await chrome.storage.session.get(key);
  return (r[key] as ComparePivot | undefined) ?? null;
}
async function setComparePivot(p: ComparePivot | null): Promise<void> {
  const key = compareKey();
  if (p) await chrome.storage.session.set({ [key]: p });
  else await chrome.storage.session.remove(key);
}

// Refresh the context-menu compare title when the active profile
// switches. Without this, the menu would show "Compare with <sbx-rid>…"
// after the user alt-tabbed to dev — visually correct for sbx but
// stale for dev (which has its own per-profile pivot, possibly empty).
onProfileSwitch(() => {
  // Workspace changed — a paint source armed in the old workspace can't be
  // resolved here (RIDs + colour-bids are workspace-scoped). Cancel the brush
  // so the user re-picks in the new workspace instead of hitting a confusing
  // silent misfire. Mirrors clearAllContextRids() in the same switch paths.
  cancelPaint();

  getComparePivot().then((pivot) => {
    const title = pivot ? `Compare with ${pivot.name ?? pivot.rid}…` : 'Compare with…';
    chrome.contextMenus.update('crev-compare', { title }).catch(e => log.swallow('sw:refreshCompareMenu', e));
  }).catch(e => log.swallow('sw:refreshCompareMenuRead', e));
});

// Clean up context menu state when tabs close
chrome.tabs.onRemoved.addListener((tabId) => { deleteContextRid(tabId); });

// When a BMP session cookie disappears (logout/expiry), release any borrowed
// token chain so the extension's access tracks the user's login. The handler is
// async (it awaits settingsReady + re-probes the cookie); swallow its promise.
chrome.cookies.onChanged.addListener((info) => { void handleSessionCookieRemoved(info); });

async function handleContextMenuClick(info: chrome.contextMenus.OnClickData, tab?: chrome.tabs.Tab) {
  const tabId = tab?.id;
  if (!tabId) return;
  const ctxRid = getContextRid(tabId);
  if (!ctxRid) return;

  const menuId = typeof info.menuItemId === 'string' ? info.menuItemId : '';
  const reportFail = (action: string) => (e: unknown) => {
    ctx.logActivity('error', `${action} failed`, e instanceof Error ? e.message : String(e));
  };
  switch (menuId) {
    case 'crev-copy-rid':
      chrome.tabs.sendMessage(tabId, { type: 'COPY_TO_CLIPBOARD', text: ctxRid.rid }).catch(reportFail('Copy RID'));
      break;
    case 'crev-copy-bid':
      chrome.tabs.sendMessage(tabId, { type: 'COPY_TO_CLIPBOARD', text: ctxRid.businessId ?? ctxRid.rid }).catch(reportFail('Copy ID'));
      break;
    case 'crev-copy-name':
      chrome.tabs.sendMessage(tabId, { type: 'COPY_TO_CLIPBOARD', text: ctxRid.name ?? '' }).catch(reportFail('Copy name'));
      break;
    case 'crev-view-props':
      if (tabId) chrome.sidePanel.open({ tabId }).catch(reportFail('Open side panel'));
      ctx.sendToPanel({ type: 'SELECT_OBJECT', rid: ctxRid.rid });
      break;
    case 'crev-open-editor':
      // Context menu fires for a specific tab \u2014 mount the editor there
      // rather than on lastFocusedWindow's active tab.
      openEditorWindow(ctxRid.rid, undefined, { tabId }).catch(reportFail('Open editor'));
      break;
    case 'crev-search-code':
      void openCodeSearchWindow({ tabId });
      break;
    case 'crev-compare': {
      const pivot = await getComparePivot();
      if (!pivot) {
        await setComparePivot({ rid: ctxRid.rid, name: ctxRid.name });
        void chrome.contextMenus.update('crev-compare', { title: `Compare with ${ctxRid.name ?? ctxRid.rid}\u2026` });
      } else {
        void openDiffWindow(pivot.rid, ctxRid.rid, undefined, { tabId });
        await setComparePivot(null);
        void chrome.contextMenus.update('crev-compare', { title: 'Compare with\u2026' });
      }
      break;
    }
  }
}

chrome.contextMenus.onClicked.addListener((info, tab) => { void handleContextMenuClick(info, tab); });

// ── Port connections ────────────────────────────────────────────

/** Safe postMessage — swallows errors from disconnected ports. */
function safeSend(port: chrome.runtime.Port, msg: InspectorMessage) {
  try { port.postMessage(msg); }
  catch (e) { log.swallow('sw:safeSend', e); }
}

/** Push initial state to a newly connected content port (after settingsReady). */
function initContentPort(port: chrome.runtime.Port, tabId: number | undefined) {
  port.onMessage.addListener((msg: InspectorMessage) => {
    void handleContentMessage(msg, tabId ?? undefined);
  });

  // All initial pushes gated on settingsReady — inspect state and cache
  // are only valid after boot completes (restored from storage). Inspect
  // is per-window: this content port belongs to a tab in some window;
  // we look up that window's flag.
  void settingsReady.then(async () => {
    let inspectForWindow = false;
    if (tabId != null) {
      try {
        const tab = await chrome.tabs.get(tabId);
        inspectForWindow = inspectActiveByWindow.get(tab.windowId) === true;
      } catch { /* tab gone */ }
    }
    safeSend(port, { type: 'INSPECT_STATE', active: inspectForWindow });
    safeSend(port, { type: 'ENRICH_MODE', mode: settings.enrichMode });
    // Re-sync paint state to this (re)connected content script — its in-page
    // banner + pill-click handling read s.paintPhase, and without this push a
    // reconnect/re-injection (SW idle→wake, F5, paint's own ensureContentScript)
    // would leave the page stale ('off') while the panel stayed armed. Pushed
    // ALWAYS (even 'off') so a stale 'applying' content gets corrected too.
    safeSend(port, paintStateMessage());

    // Push cached enrichments so a fresh content script (after F5) has data immediately
    const enrichments: Record<string, { businessId?: string; type?: string; name?: string; templateBusinessId?: string }> = {};
    for (const obj of cache.getAll()) {
      if (obj.businessId || obj.type || obj.name) {
        enrichments[obj.rid] = { businessId: obj.businessId, type: obj.type, name: obj.name, templateBusinessId: obj.templateBusinessId };
      }
    }
    if (Object.keys(enrichments).length > 0) {
      safeSend(port, { type: 'BADGE_ENRICHMENT', enrichments });
    }
  });

  // Notify the panel that lives in the same window as the connecting
  // content script (if any). Previously we asked Chrome for the "active
  // tab" globally and pushed to the singleton panel; with multiple
  // windows that surfaced the wrong tab's data in the wrong panel.
  if (tabId != null && panelPortByWindow.size > 0) {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) return;
      const windowId = tab.windowId;
      if (windowId == null) return;
      // Active-tab gate per window: only push if the connecting tab is
      // the active tab of its window (background BMP tabs shouldn't
      // jerk that window's panel).
      chrome.tabs.query({ active: true, windowId }, (actives) => {
        if (actives[0]?.id !== tabId) return;
        logActivity('info', 'Content script connected');
        sendPageInfoToPanel(tabId);
        const det = getTabDetection(tabId);
        sendToPanelByWindow(windowId, {
          type: 'DETECTION_STATE',
          ...(det ?? { phase: 'checking' as import('./lib/types').DetectionPhase, confidence: 0, signals: [] }),
        } satisfies InspectorMessage);
      });
    });
  }
}

/** Push initial state to a newly connected panel port. The port is not
 *  yet registered in `panelPortByWindow` — that happens after the first
 *  PANEL_HELLO message arrives carrying the panel's windowId. */
function initPanelPort(port: chrome.runtime.Port) {
  port.onMessage.addListener((msg: InspectorMessage) => {
    if (msg.type === 'PANEL_HELLO') {
      const { windowId } = msg;
      // A second document can exist for one window (for example a stale
      // extension page beside Chrome's real side panel). Force-disconnecting
      // the previous port is unsafe: its reconnecting client returns after
      // 200 ms, steals the slot, and disconnects this port in turn. Retire the
      // old client explicitly and let it disconnect itself without retrying.
      const prev = panelPortByWindow.get(windowId);
      if (prev && prev !== port) {
        portToWindowId.delete(prev);
        safeSend(prev, { type: 'PANEL_SUPERSEDED' });
      }
      panelPortByWindow.set(windowId, port);
      portToWindowId.set(port, windowId);

      void settingsReady.then(() => {
        // The port may have been superseded while settings were still
        // restoring. Never let its delayed startup consume queued state or
        // initialize monitoring on behalf of a retired document.
        if (panelPortByWindow.get(windowId) !== port) return;
        // Per-window inspect + blueprint — this panel only cares about its own window. Re-pushed on
        // connect so a reopened sidebar reflects the current toggle state (mirrors INSPECT_STATE).
        safeSend(port, { type: 'INSPECT_STATE', active: inspectActiveByWindow.get(windowId) === true });
        safeSend(port, { type: 'BLUEPRINT_STATE', active: blueprintActiveByWindow.get(windowId) === true });
        safeSend(port, { type: 'CACHE_STATS', count: cache.size });
        // Flush queued broadcasts to the newly-registered panel. Multiple
        // panels racing to flush would each pop the queue; only the
        // *first* panel gets the queued messages — that's intentional,
        // the queued payloads are state snapshots that are equally
        // useful to either panel and we don't want to double-fire
        // activity entries.
        for (const queued of pendingPanelMessages) safeSend(port, queued);
        pendingPanelMessages.length = 0;
        // loadSettingsFrom() may already have started monitoring when this
        // panel connected during worker boot. The helper is idempotent and
        // won't turn a verified connection back into "Reconnecting".
        ensureConnectionMonitoring();
      });
      pushPaintState();
      return;
    }
    void handlePanelMessage(msg, port);
  });

}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'content') {
    const tabId = port.sender?.tab?.id;
    if (tabId != null) {
      contentPorts.set(tabId, port);
      // Identity-guarded delete: a re-injection disconnects the old port and
      // connects a new one for the SAME tabId. If the old port's (possibly
      // out-of-order) onDisconnect deleted unconditionally, it would evict the
      // live new port — leaving contentPorts empty so ensureContentScript
      // re-injects again (loop) and toggleInspect/broadcastToContent can't
      // reach the tab. Only delete if THIS port is still the registered one.
      port.onDisconnect.addListener(() => {
        if (contentPorts.get(tabId) === port) contentPorts.delete(tabId);
      });
    }
    initContentPort(port, tabId ?? undefined);
  }

  if (port.name === 'panel') {
    port.onDisconnect.addListener(() => {
      const windowId = portToWindowId.get(port);
      portToWindowId.delete(port);
      if (windowId != null && panelPortByWindow.get(windowId) === port) {
        panelPortByWindow.delete(windowId);
      }
      // Stop health polling only when the LAST panel goes away —
      // otherwise closing one window's panel would kill the polling
      // the other window's panel still depends on.
      if (panelPortByWindow.size === 0) stopHealthPolling();
    });
    initPanelPort(port);
  }
});

// ── Keyboard shortcut ───────────────────────────────────────────

chrome.commands.onCommand.addListener((command) => {
  log.info('sw:command', command);
  if (command === 'toggle-inspect') {
    void toggleInspect();
  }
  if (command === 'toggle-blueprint') {
    void toggleBlueprint();
  }
  if (command === 'open-extended') {
    // Mount on the user's most-recently-focused window's active tab. We have no
    // panel context from a keyboard shortcut; openExtendedWindow resolves the
    // page context itself (shared resolver) from the targeted tab.
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      openExtendedWindow(undefined, { tabId: tabs[0]?.id }).catch(e => log.swallow('sw:openExtended', e));
    });
  }
});

// ── Network state change → immediate re-poll ────────────────────

self.addEventListener('online', () => { void pollHealth(true); });
self.addEventListener('offline', () => { void pollHealth(true); });

// ── One-shot message handler ────────────────────────────────────

chrome.runtime.onMessage.addListener((msg: InspectorMessage, sender, sendResponse) => {
  // Track last right-clicked RID per tab (from content script). Surface the
  // change in the activity log — the user sets context constantly and the
  // Log tab was previously blind to it.
  if (msg.type === 'SET_CONTEXT_RID') {
    const tabId = sender.tab?.id;
    if (tabId != null) {
      setContextRid(tabId, { rid: msg.rid, name: msg.name, type: msg.objectType, businessId: msg.businessId });
    }
    const label = msg.name || msg.businessId || msg.rid;
    ctx.logActivity('info', `Context: ${label}`);
    // Push the new context to the panel so the Page tab + picker refresh
    // without the user having to close/reopen the side panel. The Page tab's
    // CONTEXT_RID_DATA handler already takes care of fetching the full
    // template tree from the new rid.
    ctx.sendToPanel({
      type: 'CONTEXT_RID_DATA',
      rid: msg.rid,
      name: msg.name,
      objectType: msg.objectType,
      businessId: msg.businessId,
    });
    return false;
  }
  return handleOneShotMessage(msg, sender, sendResponse);
});
