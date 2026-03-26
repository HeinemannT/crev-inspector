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
import type { SwContext } from './lib/sw-context';
import { setSwContext } from './lib/sw-context';
import { log } from './lib/logger';

// Modules
import { loadTabDetection, getTabDetection } from './lib/detection';
import { startHealthPolling, runAuthTest, stopHealthPolling, pollHealth } from './lib/connection';
import { restoreActivity, logActivity } from './lib/activity';
import { createSettingsReady, loadSettingsFrom } from './lib/settings';
import { registerTabListeners, sendPageInfoToPanel } from './lib/tab-awareness';
import { handleContentMessage, handlePanelMessage, handleOneShotMessage, toggleInspect } from './lib/message-router';

// ── State ───────────────────────────────────────────────────────

// Cache initialized with default profile; will be switched once settings load
const cache = new ObjectCache('_default');
const history = new HistoryManager('_default');
const favorites = new FavoritesManager('_default');
const scriptHistory = new ScriptHistoryManager('_default');
let inspectActive = false;
let technicalOverlay = false;
let settings: InspectorSettings = { ...DEFAULT_SETTINGS };
let client: import('./lib/bmp-client').BmpClient | null = null;

const contentPorts = new Map<number, chrome.runtime.Port>();
let panelPort: chrome.runtime.Port | null = null;
const PANEL_MSG_CAP = 100;
const pendingPanelMessages: InspectorMessage[] = [];

// ── Context ─────────────────────────────────────────────────────

const { settingsReady, resolveSettings } = createSettingsReady();

const ctx: SwContext = {
  get client() { return client; },
  set client(v) { client = v; },
  get panelPort() { return panelPort; },
  set panelPort(v) { panelPort = v; },
  contentPorts,
  cache,
  history,
  favorites,
  scriptHistory,
  get settings() { return settings; },
  set settings(v) { settings = v; },
  get inspectActive() { return inspectActive; },
  set inspectActive(v) { inspectActive = v; },
  get technicalOverlay() { return technicalOverlay; },
  set technicalOverlay(v) { technicalOverlay = v; },
  settingsReady,
  logActivity,
  sendToPanel(msg: InspectorMessage) {
    if (panelPort) {
      panelPort.postMessage(msg);
    } else {
      // Dedup CONNECTION_STATE — only keep the latest
      if (msg.type === 'CONNECTION_STATE') {
        const idx = pendingPanelMessages.findIndex(m => m.type === 'CONNECTION_STATE');
        if (idx >= 0) pendingPanelMessages.splice(idx, 1);
      }
      pendingPanelMessages.push(msg);
      while (pendingPanelMessages.length > PANEL_MSG_CAP) pendingPanelMessages.shift();
    }
  },
  broadcastToContent(msg: InspectorMessage) {
    for (const port of contentPorts.values()) {
      try { port.postMessage(msg); } catch (e) { log.swallow('sw:broadcastToContent', e); }
    }
  },
};

// ── Init ─────────────────────────────────────────────────────────

setSwContext(ctx);
registerTabListeners();

// ── Boot ────────────────────────────────────────────────────────

// Boot: load state managers independently (one failure must not block the rest)
Promise.all([
  cache.load().catch(e => log.swallow('sw:cache', e)),
  history.load().catch(e => log.swallow('sw:history', e)),
  favorites.load().catch(e => log.swallow('sw:favorites', e)),
  scriptHistory.load().catch(e => log.swallow('sw:scriptHistory', e)),
]).then(async () => {
  const stored = await chrome.storage.local.get(['crev_settings', 'crev_inspect_active']).catch(e => { log.swallow('sw:loadStorage', e); return {} as Record<string, unknown>; });
  await loadSettingsFrom((stored as Record<string, unknown>).crev_settings);
  if ((stored as Record<string, unknown>).crev_inspect_active === true) inspectActive = true;
  await loadTabDetection();
  await restoreActivity();
}).catch(e => {
  log.swallow('sw:init', e);
  resolveSettings(); // ensure settingsReady resolves even on catastrophic failure
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(e => log.swallow('sw:sidePanel', e));

// ── Context menus ──────────────────────────────────────────────

chrome.contextMenus.removeAll(() => {
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
});

let compareRid: { rid: string; name?: string } | null = null;
const contextRidMap = new Map<number, { rid: string; name?: string; type?: string; businessId?: string }>();

// Clean up context menu state when tabs close
chrome.tabs.onRemoved.addListener((tabId) => { contextRidMap.delete(tabId); });

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const tabId = tab?.id;
  if (!tabId) return;
  const ctxRid = contextRidMap.get(tabId);
  if (!ctxRid) return;

  const menuId = typeof info.menuItemId === 'string' ? info.menuItemId : '';
  switch (menuId) {
    case 'crev-copy-rid':
      chrome.tabs.sendMessage(tabId, { type: 'COPY_TO_CLIPBOARD', text: ctxRid.rid }).catch(e => log.swallow('ctx:copyRid', e));
      break;
    case 'crev-copy-bid':
      chrome.tabs.sendMessage(tabId, { type: 'COPY_TO_CLIPBOARD', text: ctxRid.businessId ?? ctxRid.rid }).catch(e => log.swallow('ctx:copyBid', e));
      break;
    case 'crev-copy-name':
      chrome.tabs.sendMessage(tabId, { type: 'COPY_TO_CLIPBOARD', text: ctxRid.name ?? '' }).catch(e => log.swallow('ctx:copyName', e));
      break;
    case 'crev-view-props':
      if (tabId) chrome.sidePanel.open({ tabId }).catch(e => log.swallow('ctx:openPanel', e));
      ctx.sendToPanel({ type: 'SELECT_OBJECT', rid: ctxRid.rid });
      break;
    case 'crev-open-editor':
      import('./lib/editor').then(m => m.openEditorWindow(ctxRid.rid)).catch(e => log.swallow('ctx:openEditor', e));
      break;
    case 'crev-search-code':
      import('./lib/codesearch-launcher').then(m => m.openCodeSearchWindow()).catch(e => log.swallow('ctx:searchCode', e));
      break;
    case 'crev-compare':
      if (!compareRid) {
        compareRid = { rid: ctxRid.rid, name: ctxRid.name };
        chrome.contextMenus.update('crev-compare', { title: `Compare with ${ctxRid.name ?? ctxRid.rid}\u2026` });
      } else {
        import('./lib/diff-launcher').then(m => m.openDiffWindow(compareRid!.rid, ctxRid.rid)).catch(e => log.swallow('ctx:compare', e));
        compareRid = null;
        chrome.contextMenus.update('crev-compare', { title: 'Compare with\u2026' });
      }
      break;
  }
});

// ── Port connections ────────────────────────────────────────────

/** Safe postMessage — swallows errors from disconnected ports. */
function safeSend(port: chrome.runtime.Port, msg: InspectorMessage) {
  try { port.postMessage(msg); }
  catch (e) { log.swallow('sw:safeSend', e); }
}

/** Push initial state to a newly connected content port (after settingsReady). */
function initContentPort(port: chrome.runtime.Port, tabId: number | undefined) {
  port.onMessage.addListener((msg: InspectorMessage) => {
    handleContentMessage(msg, tabId ?? undefined);
  });

  // All initial pushes gated on settingsReady — inspectActive and cache
  // are only valid after boot completes (restored from storage).
  settingsReady.then(() => {
    safeSend(port, { type: 'INSPECT_STATE', active: inspectActive });
    safeSend(port, { type: 'ENRICH_MODE', mode: settings.enrichMode });

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

  if (panelPort && tabId != null) {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id === tabId) {
        logActivity('info', 'Content script connected');
        sendPageInfoToPanel(tabId);
        const det = getTabDetection(tabId);
        panelPort?.postMessage({
          type: 'DETECTION_STATE',
          ...(det ?? { phase: 'checking' as import('./lib/types').DetectionPhase, confidence: 0, signals: [] }),
        } satisfies InspectorMessage);
      }
    });
  }
}

/** Push initial state to a newly connected panel port. */
function initPanelPort(port: chrome.runtime.Port) {
  port.onMessage.addListener((msg: InspectorMessage) => {
    handlePanelMessage(msg);
  });

  startHealthPolling();
  runAuthTest();

  settingsReady.then(() => {
    safeSend(port, { type: 'INSPECT_STATE', active: inspectActive });
    safeSend(port, { type: 'CACHE_STATS', count: cache.size });

    // Flush messages queued while panel was closed
    for (const queued of pendingPanelMessages) safeSend(port, queued);
    pendingPanelMessages.length = 0;
  });

  import('./lib/paint').then(m => m.pushPaintState()).catch(e => log.swallow('sw:pushPaint', e));
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'content') {
    const tabId = port.sender?.tab?.id;
    if (tabId != null) {
      contentPorts.set(tabId, port);
      port.onDisconnect.addListener(() => contentPorts.delete(tabId));
    }
    initContentPort(port, tabId ?? undefined);
  }

  if (port.name === 'panel') {
    panelPort = port;
    port.onDisconnect.addListener(() => { panelPort = null; stopHealthPolling(); });
    initPanelPort(port);
  }
});

// ── Keyboard shortcut ───────────────────────────────────────────

function openPanelForActiveTab() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0]?.id) {
      chrome.sidePanel.open({ tabId: tabs[0].id }).catch(e => log.swallow('sw:openSidePanel', e));
    }
  });
}

chrome.commands.onCommand.addListener((command) => {
  log.info('sw:command', command);
  if (command === 'toggle-inspect') {
    toggleInspect();
  }
  if (command === 'open-extended') {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tabUrl = tabs[0]?.url;
      let pageRid: string | undefined;
      if (tabUrl) {
        try {
          const params = new URL(tabUrl).searchParams;
          pageRid = params.get('rid') ?? undefined;
        } catch { /* ignore invalid URLs */ }
      }
      import('./lib/editor').then(m => m.openExtendedWindow(pageRid)).catch(e => log.swallow('sw:openExtended', e));
    });
  }
});

// ── Network state change → immediate re-poll ────────────────────

self.addEventListener('online', () => { pollHealth(); });
self.addEventListener('offline', () => { pollHealth(); });

// ── One-shot message handler ────────────────────────────────────

chrome.runtime.onMessage.addListener((msg: InspectorMessage, sender, sendResponse) => {
  // Track last right-clicked RID per tab (from content script)
  if (msg.type === 'SET_CONTEXT_RID') {
    const tabId = sender.tab?.id;
    if (tabId != null) {
      contextRidMap.set(tabId, { rid: msg.rid, name: msg.name, type: msg.objectType, businessId: msg.businessId });
    }
    return false;
  }
  return handleOneShotMessage(msg, sender, sendResponse);
});
