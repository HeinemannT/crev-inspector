/**
 * Content script injection + page info relay.
 * Extracted from tab-awareness.ts to isolate the injection/messaging/retry
 * logic from the tab listener plumbing.
 */

import type { InspectorMessage, DetectionPhase } from './types';
import { getCtx } from './sw-context';
import { getTabDetection, setTabDetection } from './detection';
import { handleContentMessage } from './message-router';
import { log } from './logger';

/** Tabs currently mid-injection. Without this map, two parallel callers
 *  (`sendPageInfoToPanel` and the `onActivated` listener used to both fire
 *  before the content port registered) each pass the `contentPorts.has`
 *  guard, each log `Injecting content script\u2026`, each call
 *  `chrome.scripting.executeScript`. Dedup at the promise level so all
 *  callers share one injection per tab. */
const inFlightInjections = new Map<number, Promise<void>>();

/** Inject content.js into the given tab if not already present. */
export function ensureContentScript(tabId: number): Promise<void> {
  if (getCtx().contentPorts.has(tabId)) return Promise.resolve();
  const existing = inFlightInjections.get(tabId);
  if (existing) return existing;
  const p = (async () => {
    try {
      getCtx().logActivity('info', 'Injecting content script\u2026');
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content.js'],
      });
    } catch (e) {
      log.swallow('tabs:injectContentScript', e);
    } finally {
      inFlightInjections.delete(tabId);
    }
  })();
  inFlightInjections.set(tabId, p);
  return p;
}

/** Query page info from the content script and forward to the right
 *  panel(s). Multi-window aware: if `tabId` is provided, the response
 *  is routed only to the panel in that tab's window — keeping other
 *  windows' panels from being jerked around by tab events that
 *  don't concern them. */
export function sendPageInfoToPanel(tabId?: number, retries = 1, panelWindowId?: number) {
  const ctx = getCtx();
  const route = (id: number, msg: InspectorMessage) => {
    if (panelWindowId != null) ctx.sendToPanelByWindow(panelWindowId, msg);
    else ctx.sendToPanelByTab(id, msg);
  };
  const doSend = (id: number) => {
    chrome.tabs.sendMessage(id, { type: 'GET_PAGE_INFO' } satisfies InspectorMessage, (response) => {
      if (chrome.runtime.lastError || !response) {
        if (retries > 0) {
          ensureContentScript(id).then(() => {
            setTimeout(() => sendPageInfoToPanel(id, retries - 1, panelWindowId), 200);
          });
        } else {
          // Out of retries — emit an empty PAGE_INFO so the panel's
          // Page tab can render its "no widgets" empty state instead
          // of waiting forever on a response that will never come.
          const entry = { phase: 'not-detected' as DetectionPhase, confidence: 0, signals: ['content-script-unreachable'] };
          setTabDetection(id, entry);
          route(id, { type: 'DETECTION_STATE', ...entry });
          route(id, { type: 'PAGE_INFO', url: '', widgets: [], detection: { confidence: 0, signals: entry.signals, isBmp: false } });
        }
        return;
      }
      route(id, response);
      if (response.detection) {
        handleContentMessage(
          {
            type: 'DETECTION_RESULT',
            confidence: response.detection.confidence,
            signals: response.detection.signals,
            isBmp: response.detection.isBmp,
          } as InspectorMessage,
          id,
        );
      }
    });
  };

  if (tabId != null) {
    doSend(tabId);
  } else if (panelWindowId != null) {
    // Panel-initiated request — query its own window's active tab,
    // not lastFocusedWindow. Two-panel setup: panel A's GET_PAGE_INFO
    // resolves window A's active BMP tab regardless of whether the
    // user touched window B more recently.
    chrome.tabs.query({ active: true, windowId: panelWindowId }, (tabs) => {
      const id = tabs[0]?.id;
      if (id != null) { doSend(id); return; }
      ctx.sendToPanelByWindow(panelWindowId, { type: 'PAGE_INFO', url: '', widgets: [], detection: { confidence: 0, signals: ['no-active-tab'], isBmp: false } });
    });
  } else {
    // No targeting context at all — best-effort against lastFocusedWindow.
    // Result broadcasts to every panel.
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
      const id = tabs[0]?.id;
      if (id != null) { doSend(id); return; }
      ctx.sendToPanel({ type: 'PAGE_INFO', url: '', widgets: [], detection: { confidence: 0, signals: ['no-active-tab'], isBmp: false } });
    });
  }
}

/** Panel requested detection state — sync from cache or trigger fresh query.
 *  `panelWindowId` (from PANEL_HELLO bookkeeping) targets the requesting
 *  panel's own window so multi-window panel setups don't cross-talk. */
export function handleGetDetection(panelWindowId?: number) {
  const ctx = getCtx();
  const query: chrome.tabs.QueryInfo = panelWindowId != null
    ? { active: true, windowId: panelWindowId }
    : { active: true, lastFocusedWindow: true };
  chrome.tabs.query(query, (tabs) => {
    const tabId = tabs[0]?.id;
    if (!tabId) return;
    const route = (msg: InspectorMessage) => {
      if (panelWindowId != null) ctx.sendToPanelByWindow(panelWindowId, msg);
      else ctx.sendToPanelByTab(tabId, msg);
    };
    const det = getTabDetection(tabId);
    if (det) {
      route({ type: 'DETECTION_STATE', ...det });
      return;
    }
    route({ type: 'DETECTION_STATE', phase: 'checking' as DetectionPhase, confidence: 0, signals: [] });
    const tab = tabs[0];
    if (tab?.url && /^(chrome|chrome-extension|about|edge|brave):/.test(tab.url)) {
      const entry = { phase: 'not-detected' as DetectionPhase, confidence: 0, signals: ['non-injectable'] };
      setTabDetection(tabId, entry);
      route({ type: 'DETECTION_STATE', ...entry });
      route({ type: 'PAGE_INFO', url: tab.url, widgets: [], detection: { confidence: 0, signals: entry.signals, isBmp: false } });
      return;
    }
    sendPageInfoToPanel(tabId, 1, panelWindowId);
  });
}
