/**
 * Tab lifecycle listeners — tracks active tab, responds to tab switches and navigation.
 * Delegates content script injection + page info relay to content-script-injection.ts.
 */

import type { InspectorMessage, DetectionPhase } from './types';
import { getCtx } from './sw-context';
import { getTabDetection, setTabDetection, deleteTabDetection, updateBadge } from './detection';
import { autoDetectProfile } from './settings';
import { log } from './logger';
import { cancelPaint, cancelPaintForTab } from './paint';
import { checkBmpCookie } from './cookie-gate';
import { deleteContextRid } from './context-rid';
import { sendPageInfoToPanel } from './content-script-injection';

// Re-export for backward compatibility with existing importers
export { ensureContentScript, sendPageInfoToPanel, handleGetDetection } from './content-script-injection';

/** Per-window active-tab tracking. The previous singleton broke when
 *  the user had BMP open in two windows — onActivated in one window
 *  would overwrite the other's "active tab", causing tab-aware logic
 *  (paint cancel on navigation, BMP_URL_CHANGED gating) to fire on
 *  the wrong window. */
const activeTabIdByWindow = new Map<number, number>();

function isActiveInItsWindow(tabId: number, windowId: number): boolean {
  return activeTabIdByWindow.get(windowId) === tabId;
}

export function registerTabListeners() {
  chrome.tabs.onActivated.addListener((activeInfo) => {
    const ctx = getCtx();
    activeTabIdByWindow.set(activeInfo.windowId, activeInfo.tabId);
    cancelPaint();

    chrome.tabs.get(activeInfo.tabId, (tab) => {
      if (chrome.runtime.lastError) return;
      if (tab?.url) autoDetectProfile(tab.url);
    });
    // Push detection + page info only to the panel in THIS window —
    // a tab switch in window B shouldn't refresh window A's panel.
    const panelPort = ctx.panelPortByWindow.get(activeInfo.windowId);
    if (panelPort) {
      const det = getTabDetection(activeInfo.tabId);
      try {
        panelPort.postMessage({
          type: 'DETECTION_STATE',
          ...(det ?? { phase: 'checking' as DetectionPhase, confidence: 0, signals: [] }),
        } satisfies InspectorMessage);
      } catch (e) { log.swallow('tabs:onActivatedPanelPush', e); }
      if (!det) {
        sendPageInfoToPanel(activeInfo.tabId);
      }
    }

    // Re-enrich only if inspect is on for THIS window. Per-window
    // semantics: a tab activated in window A shouldn't be re-enriched
    // because window B has inspect on.
    if (ctx.isInspectActive(activeInfo.windowId)) {
      const port = ctx.contentPorts.get(activeInfo.tabId);
      if (port) try { port.postMessage({ type: 'RE_ENRICH' } satisfies InspectorMessage); } catch (e) { log.swallow('tabs:reEnrichTab', e); }
    }
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    const ctx = getCtx();
    const windowId = tab?.windowId;
    const isActiveTab = windowId != null && isActiveInItsWindow(tabId, windowId);

    // Cancel paint when the PAINTED tab navigates or refreshes. Keyed on the
    // tab paint is armed for (not the active-tab map, which is empty until the
    // first tab switch — that gap left the brush stuck-armed after a refresh).
    if (changeInfo.url || changeInfo.status === 'loading') {
      cancelPaintForTab(tabId);
    }

    // Cookie-based fast gate: early BMP detection on page load
    if (changeInfo.status === 'loading' && tab?.url && /^https?:/.test(tab.url)) {
      if (isActiveTab) {
        checkBmpCookie(tab.url!).then((hasCookie) => {
          if (hasCookie && !getTabDetection(tabId)) {
            const entry = { phase: 'detected' as DetectionPhase, confidence: 0.7, signals: ['JSESSIONID'] };
            setTabDetection(tabId, entry);
            updateBadge(tabId, true);
            ctx.sendToPanelByWindow(windowId!, { type: 'DETECTION_STATE', ...entry });
          }
        });
      }
    }
    if (changeInfo.url) {
      deleteTabDetection(tabId);
      deleteContextRid(tabId); // Clear stale context on navigation

      if (isActiveTab) {
        autoDetectProfile(changeInfo.url!);
        ctx.sendToPanelByWindow(windowId!, { type: 'DETECTION_STATE', phase: 'checking' as DetectionPhase, confidence: 0, signals: [] });
      }
    }

    if (!ctx.hasPanel) return;
    if (changeInfo.status !== 'complete' && !changeInfo.url) return;

    if (isActiveTab) {
      sendPageInfoToPanel(tabId);
      const det = getTabDetection(tabId);
      if (det) {
        ctx.sendToPanelByWindow(windowId!, { type: 'DETECTION_STATE', ...det });
      }
    }
  });

  chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
    if (activeTabIdByWindow.get(removeInfo.windowId) === tabId) {
      activeTabIdByWindow.delete(removeInfo.windowId);
    }
    deleteTabDetection(tabId);
    getCtx().contentPorts.delete(tabId);
  });

  // Clean up the window's active-tab entry when the window itself closes.
  if (chrome.windows?.onRemoved) {
    chrome.windows.onRemoved.addListener((windowId) => {
      activeTabIdByWindow.delete(windowId);
    });
  }
}
