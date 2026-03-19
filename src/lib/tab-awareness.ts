/**
 * Tab awareness — tracks active tab, injects content scripts, relays page info.
 */

import type { InspectorMessage, DetectionPhase } from './types';
import { getCtx } from './sw-context';
import { getTabDetection, setTabDetection, deleteTabDetection, updateBadge } from './detection';
import { autoDetectProfile } from './settings';
import { log } from './logger';
import { handleContentMessage } from './message-router';
import { cancelPaint } from './paint';
import { checkBmpCookie } from './cookie-gate';

export function registerTabListeners() {
  chrome.tabs.onActivated.addListener((activeInfo) => {
    const ctx = getCtx();
    cancelPaint();

    chrome.tabs.get(activeInfo.tabId, (tab) => {
      if (chrome.runtime.lastError) return;
      if (tab?.url) autoDetectProfile(tab.url);
    });
    if (ctx.panelPort) {
      const det = getTabDetection(activeInfo.tabId);
      ctx.panelPort.postMessage({
        type: 'DETECTION_STATE',
        ...(det ?? { phase: 'checking' as DetectionPhase, confidence: 0, signals: [] }),
      } satisfies InspectorMessage);
      // Only request fresh page info from content if no cached detection exists
      if (!det) {
        sendPageInfoToPanel(activeInfo.tabId);
        ensureContentScript(activeInfo.tabId);
      }
    }

    if (ctx.inspectActive) {
      const port = ctx.contentPorts.get(activeInfo.tabId);
      if (port) try { port.postMessage({ type: 'RE_ENRICH' } satisfies InspectorMessage); } catch (e) { log.swallow('tabs:reEnrichTab', e); }
    }
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    const ctx = getCtx();
    // Cancel paint on navigation or refresh (only for the active tab)
    if (changeInfo.url || changeInfo.status === 'loading') {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id === tabId) cancelPaint();
      });
    }

    // Cookie-based fast gate: early BMP detection on page load
    if (changeInfo.status === 'loading' && tab?.url && /^https?:/.test(tab.url)) {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id === tabId) {
          checkBmpCookie(tab.url!).then((hasCookie) => {
            if (hasCookie && !getTabDetection(tabId)) {
              const entry = { phase: 'detected' as DetectionPhase, confidence: 0.7, signals: ['JSESSIONID'] };
              setTabDetection(tabId, entry);
              updateBadge(tabId, true);
              ctx.sendToPanel({ type: 'DETECTION_STATE', ...entry });
            }
          });
        }
      });
    }
    if (changeInfo.url) {
      deleteTabDetection(tabId);

      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs[0]?.id === tabId) {
          autoDetectProfile(changeInfo.url!);
          ctx.sendToPanel({ type: 'DETECTION_STATE', phase: 'checking' as DetectionPhase, confidence: 0, signals: [] });
        }
      });
    }

    if (!ctx.panelPort) return;
    if (changeInfo.status !== 'complete' && !changeInfo.url) return;

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id === tabId) {
        sendPageInfoToPanel(tabId);
        const det = getTabDetection(tabId);
        if (det) {
          ctx.sendToPanel({ type: 'DETECTION_STATE', ...det });
        }
      }
    });
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    deleteTabDetection(tabId);
    getCtx().contentPorts.delete(tabId);
  });
}

export async function ensureContentScript(tabId: number): Promise<void> {
  if (getCtx().contentPorts.has(tabId)) return;
  try {
    getCtx().logActivity('info', 'Injecting content script\u2026');
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    });
  } catch (e) {
    log.swallow('tabs:injectContentScript', e);
  }
}

export function sendPageInfoToPanel(tabId?: number, retries = 1) {
  const ctx = getCtx();
  const doSend = (id: number) => {
    chrome.tabs.sendMessage(id, { type: 'GET_PAGE_INFO' } satisfies InspectorMessage, (response) => {
      if (chrome.runtime.lastError || !response) {
        if (retries > 0) {
          ensureContentScript(id).then(() => {
            setTimeout(() => sendPageInfoToPanel(id, retries - 1), 200);
          });
        } else {
          const entry = { phase: 'not-detected' as DetectionPhase, confidence: 0, signals: ['content-script-unreachable'] };
          setTabDetection(id, entry);
          ctx.sendToPanel({ type: 'DETECTION_STATE', ...entry });
        }
        return;
      }
      ctx.sendToPanel(response);
      if (response.detection) {
        handleContentMessage(
          { type: 'DETECTION_RESULT', confidence: response.detection.confidence,
            signals: response.detection.signals, isBmp: response.detection.isBmp } as InspectorMessage,
          id,
        );
      }
    });
  };

  if (tabId != null) {
    doSend(tabId);
  } else {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) doSend(tabs[0].id);
    });
  }
}

export function handleGetDetection() {
  const ctx = getCtx();
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tabId = tabs[0]?.id;
    if (!tabId) return;
    const det = getTabDetection(tabId);
    if (det) {
      ctx.sendToPanel({ type: 'DETECTION_STATE', ...det });
    } else {
      ctx.sendToPanel({ type: 'DETECTION_STATE', phase: 'checking' as DetectionPhase, confidence: 0, signals: [] });
      const tab = tabs[0];
      if (tab?.url && /^(chrome|chrome-extension|about|edge|brave):/.test(tab.url)) {
        const entry = { phase: 'not-detected' as DetectionPhase, confidence: 0, signals: ['non-injectable'] };
        setTabDetection(tabId, entry);
        ctx.sendToPanel({ type: 'DETECTION_STATE', ...entry });
        return;
      }
      sendPageInfoToPanel(tabId);
    }
  });
}
