/**
 * Background service worker — thin entry point.
 * State, context, port management, boot sequence.
 * All logic delegated to focused modules.
 */

import type { InspectorMessage, InspectorSettings } from './lib/types';
import { DEFAULT_SETTINGS } from './lib/types';
import { ObjectCache } from './lib/object-cache';
import type { SwContext } from './lib/sw-context';
import { setSwContext } from './lib/sw-context';
import { log } from './lib/logger';

// Modules
import { loadTabDetection, getTabDetection } from './lib/detection';
import { startHealthPolling, runAuthTest, stopHealthPolling } from './lib/connection';
import { restoreActivity, logActivity } from './lib/activity';
import { createSettingsReady, loadSettingsFrom } from './lib/settings';
import { registerTabListeners, sendPageInfoToPanel } from './lib/tab-awareness';
import { handleContentMessage, handlePanelMessage, handleOneShotMessage, toggleInspect } from './lib/message-router';

// ── State ───────────────────────────────────────────────────────

const cache = new ObjectCache();
let inspectActive = false;
let settings: InspectorSettings = { ...DEFAULT_SETTINGS };
let client: import('./lib/bmp-client').BmpClient | null = null;

const contentPorts = new Map<number, chrome.runtime.Port>();
let panelPort: chrome.runtime.Port | null = null;

// ── Context ─────────────────────────────────────────────────────

const { settingsReady, resolveSettings } = createSettingsReady();

const ctx: SwContext = {
  get client() { return client; },
  set client(v) { client = v; },
  get panelPort() { return panelPort; },
  set panelPort(v) { panelPort = v; },
  contentPorts,
  cache,
  get settings() { return settings; },
  set settings(v) { settings = v; },
  get inspectActive() { return inspectActive; },
  set inspectActive(v) { inspectActive = v; },
  settingsReady,
  logActivity,
  sendToPanel(msg: InspectorMessage) {
    panelPort?.postMessage(msg);
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

cache.load().then(async () => {
  const stored = await chrome.storage.local.get(['crev_settings', 'crev_inspect_active']).catch(e => { log.swallow('sw:loadStorage', e); return {} as Record<string, unknown>; });
  await loadSettingsFrom((stored as Record<string, unknown>).crev_settings);
  if ((stored as Record<string, unknown>).crev_inspect_active === true) inspectActive = true;
  await loadTabDetection();
  await restoreActivity();
}).catch(e => {
  log.swallow('sw:init', e);
  resolveSettings();
});

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(e => log.swallow('sw:sidePanel', e));

// ── Port connections ────────────────────────────────────────────

chrome.runtime.onConnect.addListener((port) => {
  if (port.name === 'content') {
    const tabId = port.sender?.tab?.id;
    if (tabId != null) {
      contentPorts.set(tabId, port);
      port.onDisconnect.addListener(() => contentPorts.delete(tabId));
    }

    port.onMessage.addListener((msg: InspectorMessage) => {
      handleContentMessage(msg, tabId ?? undefined);
    });

    port.postMessage({ type: 'INSPECT_STATE', active: inspectActive } satisfies InspectorMessage);
    settingsReady.then(() => {
      port.postMessage({ type: 'ENRICH_MODE', mode: settings.enrichMode } satisfies InspectorMessage);
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

  if (port.name === 'panel') {
    panelPort = port;
    port.onDisconnect.addListener(() => { panelPort = null; stopHealthPolling(); });
    startHealthPolling();
    runAuthTest();

    port.onMessage.addListener((msg: InspectorMessage) => {
      handlePanelMessage(msg);
    });

    port.postMessage({ type: 'INSPECT_STATE', active: inspectActive } satisfies InspectorMessage);
    port.postMessage({ type: 'CACHE_STATS', count: cache.size } satisfies InspectorMessage);
  }
});

// ── Keyboard shortcut ───────────────────────────────────────────

chrome.commands.onCommand.addListener((command) => {
  if (command === 'toggle-inspect') {
    toggleInspect();
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.sidePanel.open({ tabId: tabs[0].id }).catch(e => log.swallow('sw:openSidePanel', e));
      }
    });
  }
});

// ── One-shot message handler ────────────────────────────────────

chrome.runtime.onMessage.addListener((msg: InspectorMessage, sender, sendResponse) => {
  return handleOneShotMessage(msg, sender, sendResponse);
});
