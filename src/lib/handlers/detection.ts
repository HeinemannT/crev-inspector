/**
 * BMP detection and page info handlers.
 */

import { register } from '../handler-registry';
import { getCtx } from '../sw-context';
import { getTabDetection, setTabDetection, updateBadge } from '../detection';
import { sendPageInfoToPanel, handleGetDetection } from '../tab-awareness';
import { getContextRid, getPageContext, setPageContext, deletePageContext } from '../context-rid';
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
  // SPA navigation changed the bound object — drop the stale fiber page
  // context (the content script re-posts PAGE_CONTEXT for the new page).
  deletePageContext(tabId);
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab?.windowId) return;
    chrome.tabs.query({ active: true, windowId: tab.windowId }, (actives) => {
      if (actives[0]?.id === tabId) sendPageInfoToPanel(tabId);
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
  setPageContext(tabId, { rid: msg.rid, tabRid: msg.tabRid });
  const ctx = getCtx();
  chrome.tabs.get(tabId, (tab) => {
    if (chrome.runtime.lastError || !tab?.windowId) return;
    chrome.tabs.query({ active: true, windowId: tab.windowId }, (actives) => {
      if (actives[0]?.id !== tabId) return; // only the active tab's panel
      sendPageInfoToPanel(tabId); // Page tab + Workshop
      // Footer/status chip — but only when the user hasn't pinned a right-click
      // context (that's the higher-priority intent; same order as GET_CONTEXT_RID).
      if (msg.rid && !getContextRid(tabId)) {
        ctx.sendToPanelByTab(tabId, { type: 'CONTEXT_RID_DATA', rid: msg.rid });
      }
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
  //   2. ?rid=… query param on the BMP tab's URL — the scorecard the
  //      user is currently viewing. Lets a freshly-opened panel show the
  //      current scorecard's context without a prior right-click.
  let entry = tabId != null ? getContextRid(tabId) : undefined;
  if (!entry && tabId != null) {
    // Fiber-resolved page context (works on custom-routed pages where the URL
    // has no `?rid=`), then the tab URL as a last resort.
    const pc = getPageContext(tabId);
    entry = (pc?.rid ? { rid: pc.rid } : undefined) ?? await readContextFromTabUrl(tabId);
  }
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
  ctx.sendToPanel(payload);
});

async function readContextFromTabUrl(tabId: number): Promise<{ rid: string } | undefined> {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url) return undefined;
    const u = new URL(tab.url);
    const rid = u.searchParams.get('rid');
    if (rid && /^-?\d+$/.test(rid)) return { rid };
  } catch { /* tab gone / no permission */ }
  return undefined;
}
