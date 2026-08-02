/**
 * Tab lifecycle listeners — tracks active tab, responds to tab switches and navigation.
 * Delegates content script injection + page info relay to content-script-injection.ts.
 */

import type { InspectorMessage, DetectionPhase } from './types';
import { getCtx } from './sw-context';
import { getTabDetection, setTabDetection, deleteTabDetection, updateBadge } from './detection';
import { autoDetectProfile } from './settings';
import { log } from './logger';
import { cancelPaintForTab } from './paint';
import { checkBmpCookie } from './cookie-gate';
import { deleteContextRid } from './context-rid';
import { sendPageInfoToPanel } from './content-script-injection';
import { sendPanelContextForTab } from './panel-context-sync';

// Re-export for backward compatibility with existing importers
export { ensureContentScript, ensureBlueprintScript, sendPageInfoToPanel, handleGetDetection } from './content-script-injection';

/** Per-window active-tab tracking. The previous singleton broke when
 *  the user had BMP open in two windows — onActivated in one window
 *  would overwrite the other's "active tab", causing tab-aware logic
 *  (paint cancel on navigation, BMP_URL_CHANGED gating) to fire on
 *  the wrong window. */
const activeTabIdByWindow = new Map<number, number>();
const lastUrlByTab = new Map<number, string>();

/** Page-owner identity for browser URL transitions. Presentation query params
 *  (`tabrid`, period, ytd, filters) deliberately do not participate. Fiber-only
 *  owner changes are handled by PAGE_CONTEXT in handlers/detection.ts. */
export function urlPageOwnerKey(raw?: string): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}?rid=${url.searchParams.get('rid') ?? ''}`;
  } catch { return null; }
}

function isActiveInItsWindow(tabId: number, windowId: number): boolean {
  return activeTabIdByWindow.get(windowId) === tabId;
}

export function registerTabListeners() {
  chrome.tabs.onActivated.addListener((activeInfo) => {
    const ctx = getCtx();
    activeTabIdByWindow.set(activeInfo.windowId, activeInfo.tabId);
    // NOTE: paint is intentionally NOT cancelled on a plain tab switch — a
    // source widget picked on one page can be painted onto a widget on
    // another page (same workspace), which is a valid cross-page paint.
    // Paint is cancelled only when the WORKSPACE actually changes (via the
    // onProfileSwitch hook in the SW — covers both the manual switch and the
    // autoDetectProfile below) or when the armed tab navigates/refreshes
    // (cancelPaintForTab in onUpdated). RIDs/colour-bids are workspace-scoped,
    // so a source from another workspace can't resolve in the new one.

    chrome.tabs.get(activeInfo.tabId, (tab) => {
      if (chrome.runtime.lastError) return;
      if (tab?.url && !lastUrlByTab.has(activeInfo.tabId)) lastUrlByTab.set(activeInfo.tabId, tab.url);
      const profileReady = tab?.url ? autoDetectProfile(tab.url) : Promise.resolve();
      // Context identity is workspace-scoped. Wait for auto-detection to swap
      // the active client before looking up the RID, otherwise a cross-server
      // browser-tab switch can briefly query the previous workspace.
      void profileReady.then(() => {
        if (ctx.panelPortByWindow.has(activeInfo.windowId)) {
          return sendPanelContextForTab(activeInfo.tabId);
        }
      });
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
      // Detection may already be cached, but page/context state is per tab and
      // must always follow activation. Skipping this when `det` existed was the
      // reason the side panel could keep the previous browser tab's context.
      sendPageInfoToPanel(activeInfo.tabId);
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
    let profileReady: Promise<void> = Promise.resolve();

    // Cancel paint when the PAINTED tab navigates or refreshes. Keyed on the
    // tab paint is armed for (not the active-tab map, which is empty until the
    // first tab switch — that gap left the brush stuck-armed after a refresh).
    if (changeInfo.url || changeInfo.status === 'loading') {
      cancelPaintForTab(tabId);
      // Blueprint is a per-page editing session — end it when ITS tab navigates/refreshes (keyed on the
      // recorded blueprint tab, not the active-tab map, which is empty until the first tab switch). The
      // content re-injects fresh (overlay gone), so without this the SW state + sidebar toggle would
      // stay 'on' over a now-gone overlay. (Apply's own reload already toggled off → no-op there.)
      // A URL-only update is a same-document History API navigation in BMP. The Blueprint content
      // controller deliberately survives it and reloads the model for the new RID, so keep the worker's
      // owner/state aligned. A real document load destroys the overlay and ends the session here.
      if (changeInfo.status === 'loading' && windowId != null && ctx.blueprintTabByWindow.get(windowId) === tabId) {
        ctx.blueprintActiveByWindow.set(windowId, false);
        ctx.blueprintTabByWindow.delete(windowId);
        ctx.persistBlueprintState(); // keep the session-persisted copy in step with the ended session
        ctx.sendToPanelByWindow(windowId, { type: 'BLUEPRINT_STATE', active: false });
      }
    }

    // Cookie-based fast gate: early BMP detection on page load
    if (changeInfo.status === 'loading' && tab?.url && /^https?:/.test(tab.url)) {
      if (isActiveTab) {
        void checkBmpCookie(tab.url!).then((hasCookie) => {
          if (hasCookie && !getTabDetection(tabId)) {
            const entry = { phase: 'detected' as DetectionPhase, confidence: 0.7, signals: ['JSESSIONID'] };
            setTabDetection(tabId, entry);
            void updateBadge(tabId, true);
            ctx.sendToPanelByWindow(windowId!, { type: 'DETECTION_STATE', ...entry });
          }
        });
      }
    }
    if (changeInfo.url) {
      const previousUrl = lastUrlByTab.get(tabId);
      const ownerChanged = previousUrl == null
        || urlPageOwnerKey(previousUrl) !== urlPageOwnerKey(changeInfo.url);
      lastUrlByTab.set(tabId, changeInfo.url);
      if (ownerChanged) {
        deleteTabDetection(tabId);
        deleteContextRid(tabId); // Clear stale explicit selection only for a real page-owner transition
      }

      if (isActiveTab) {
        profileReady = autoDetectProfile(changeInfo.url!);
        ctx.sendToPanelByWindow(windowId!, { type: 'DETECTION_STATE', phase: 'checking' as DetectionPhase, confidence: 0, signals: [] });
      }
    }
    if (changeInfo.status === 'complete' && tab?.url) lastUrlByTab.set(tabId, tab.url);

    if (!ctx.hasPanel) return;
    if (changeInfo.status !== 'complete' && !changeInfo.url) return;

    if (isActiveTab) {
      sendPageInfoToPanel(tabId);
      void profileReady.then(() => sendPanelContextForTab(tabId));
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
    lastUrlByTab.delete(tabId);
    getCtx().contentPorts.delete(tabId);
  });

  // Clean up the window's active-tab entry when the window itself closes.
  if (chrome.windows?.onRemoved) {
    chrome.windows.onRemoved.addListener((windowId) => {
      activeTabIdByWindow.delete(windowId);
    });
  }
}
