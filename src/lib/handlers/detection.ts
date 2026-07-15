/**
 * BMP detection and page info handlers.
 */

import { register } from '../handler-registry';
import { getCtx } from '../sw-context';
import { getTabDetection, setTabDetection, updateBadge } from '../detection';
import { sendPageInfoToPanel, handleGetDetection } from '../tab-awareness';
import { clearContextRid, getPageContext, setPageContext, deleteContextRid } from '../context-rid';
import { resolvePanelContextForTab, sendPanelContextForTab } from '../panel-context-sync';
import type { DetectionPhase } from '../types';

register('DETECTION_RESULT', (msg, respond, meta) => {
  const ctx = getCtx();
  const phase: DetectionPhase = msg.isBmp ? 'detected' : 'not-detected';
  const senderTabId = meta.senderTabId;

  // Only log when detection state actually changes
  const prevDet = senderTabId != null ? getTabDetection(senderTabId) : undefined;
  if (!prevDet || prevDet.phase !== phase) {
    const pct = Math.round(msg.confidence * 100);
    ctx.logActivity(msg.isBmp ? 'success' : 'info', msg.isBmp ? `Detection: BMP page (${pct}%)` : `Detection: not BMP (${pct}%)`);
  }
  if (senderTabId != null) {
    setTabDetection(senderTabId, { phase, confidence: msg.confidence, signals: msg.signals });
    updateBadge(senderTabId, msg.isBmp);
  }
  // Route the DETECTION_STATE to the panel in the SAME window as the
  // tab that fired the result — and only if the tab is the active tab
  // of that window. Other windows' panels stay quiet.
  if (senderTabId == null) return;
  chrome.tabs.get(senderTabId, (tab) => {
    if (chrome.runtime.lastError || !tab?.windowId) return;
    chrome.tabs.query({ active: true, windowId: tab.windowId }, (actives) => {
      if (actives[0]?.id !== senderTabId) return;
      ctx.sendToPanelByWindow(tab.windowId!, { type: 'DETECTION_STATE', phase, confidence: msg.confidence, signals: msg.signals });
    });
  });
});

register('GET_PAGE_INFO', (_msg, _respond, meta) => {
  sendPageInfoToPanel(undefined, 1, meta.panelWindowId);
});

// SPA navigation in BMP — content-observer.ts fires this when the URL flips
// without a real navigation. Refresh the panel's widget list from the active
// tab so the Page tab doesn't get stuck on stale grey "?" badges.
//
// Active-tab guard: a user with multiple BMP tabs open shouldn't have the
// panel's widget list jerked by background-tab navigation. We only refresh
// when the change is in the tab the panel is currently representing.
//
// SW-startup edge case: the active-tab map is empty between SW spawn
// and the first `chrome.tabs.onActivated` fire (~immediate on real use but
// not synchronous). If we don't know the active tab yet, query Chrome
// directly instead of dropping the signal — MV3 service workers respawn
// after ~30 s idle so this race actually matters every time the user
// triggers a panel action after a coffee break.
register('BMP_URL_CHANGED', (_msg, _respond, meta) => {
  const tabId = meta.senderTabId;
  if (tabId == null) return;
  // Per-window active-tab gate: only refresh if the navigating tab is
  // the active tab of its OWN window. Previously a global activeTabId
  // singleton was used, which broke when the user had BMP tabs in two
  // windows — navigating window B's tab would do nothing because
  // window A's tab id was the global "active". sendPageInfoToPanel
  // routes the response to the panel in the navigating tab's window
  // via sendToPanelByTab, so other windows' panels stay quiet.
  // SPA navigation changed the bound object. Drop BOTH the old page cache and
  // any object the user selected on that page; the new page becomes context as
  // soon as its URL/fiber signal resolves.
  deleteContextRid(tabId);
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab?.windowId) return;
    chrome.tabs.query({ active: true, windowId: tab.windowId }, (actives) => {
      if (actives[0]?.id === tabId) {
        sendPageInfoToPanel(tabId);
        void sendPanelContextForTab(tabId);
      }
    });
  });
});

// React render/tab change without a page-owner change. Refresh the visible
// widget/context snapshot, but deliberately keep contextRid: a render is not
// navigation and must not erase the object the user explicitly selected.
register('BMP_PAGE_RENDER_CHANGED', (_msg, _respond, meta) => {
  const tabId = meta.senderTabId;
  if (tabId == null) return;
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab?.windowId) return;
    chrome.tabs.query({ active: true, windowId: tab.windowId }, (actives) => {
      if (actives[0]?.id === tabId) {
        sendPageInfoToPanel(tabId);
        void sendPanelContextForTab(tabId);
      }
    });
  });
});

// Fiber-derived page context from the content script (the bound object + active
// tab). Cache it per tab for the footer (GET_CONTEXT_RID) and the editor's EC
// `this` (getCurrentPageRid), then refresh the panel that represents this tab.
register('PAGE_CONTEXT', (msg, _respond, meta) => {
  const tabId = meta.senderTabId;
  if (tabId == null) return;
  const prev = getPageContext(tabId);
  if (prev?.rid === msg.rid && prev?.tabRid === msg.tabRid) return; // no change
  // A fiber-only route can change pages without changing the URL. An explicit
  // object selection belongs to the old page and must not survive that switch.
  if (prev?.rid && prev.rid !== msg.rid) clearContextRid(tabId);
  setPageContext(tabId, { rid: msg.rid, tabRid: msg.tabRid });
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab?.windowId) return;
    chrome.tabs.query({ active: true, windowId: tab.windowId }, (actives) => {
      if (actives[0]?.id !== tabId) return; // only the active tab's panel
      sendPageInfoToPanel(tabId); // Page tab + Workshop
      // Footer + AI chip use the same cache-first/live-fallback identity as the
      // Extended window, with a post-lookup race check inside the helper.
      void sendPanelContextForTab(tabId);
    });
  });
});

register('GET_DETECTION', (_msg, _respond, meta) => {
  handleGetDetection(meta.panelWindowId);
});

register('GET_CONTEXT_RID', async (_msg, respond, meta) => {
  const ctx = getCtx();
  // Resolution order:
  //   1. Active tab of the requesting panel's window (multi-window aware).
  //   2. lastFocusedWindow fallback for non-panel callers.
  const tabId = meta.panelWindowId != null
    ? (await chrome.tabs.query({ active: true, windowId: meta.panelWindowId }))[0]?.id
    : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id;
  // Two sources, in priority order:
  //   1. contextRidMap — set when the user right-clicks an object in BMP
  //      (most specific — that's the user's intent).
  //   2. The resolved page context (shared resolver: URL `?rid=` ⊕ the fiber
  //      page context), so a freshly-opened panel shows the bound object even
  //      on BMP's custom-routed pages where the URL is blank.
  const entry = tabId != null ? await resolvePanelContextForTab(tabId) : undefined;
  // The object type is carried via 'objectType' to avoid collision with the
  // 'type' message discriminant (duplicate key would overwrite the discriminant).
  const payload = {
    type: 'CONTEXT_RID_DATA' as const,
    rid: entry?.rid,
    name: entry?.name,
    objectType: entry?.type,
    businessId: entry?.businessId,
  };
  respond(payload);
  if (meta.panelWindowId != null) ctx.sendToPanelByWindow(meta.panelWindowId, payload);
  else ctx.sendToPanel(payload);
});
