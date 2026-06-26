/**
 * ISOLATED world content script — thin boot + message dispatch layer.
 * State lives in ContentState, logic in content-overlays/paint/tooltip/observer.
 */

import type { InspectorMessage, ConnectionState, WidgetInfo, PaintPhase, PageContext } from './lib/types';
import { extractUrlRids, scanPageWidgets, detectBmpPage, findTabButton, isTabActive } from './lib/dom-scanner';
import { resolvePageContext } from './lib/page-context';
import { h } from './lib/dom';
import { log } from './lib/logger';
import { connectPort, disconnectPort, sendToSW, onPortMessage, onReconnect } from './lib/content-port';
import { dispatchBroadcast } from './lib/handler-registry';
import { initEnvTag, updateEnvTag, destroyEnvTag } from './lib/env-tag';
import { showToast } from './lib/toast';
import { hideQuickInspector, isQuickInspectorVisible } from './lib/quick-inspector';
import { broadcast, onSync, teardownCrossTab } from './lib/cross-tab';
import OVERLAY_CSS from './content-overlay.css';

import { ContentState } from './content-state';
import { syncOverlays, removeOverlays, updateLabels } from './content-overlays';
import { updatePaintCursors, flashApplyResult } from './content-paint';
import { showTooltipForElement, hideTooltip, applyTechnicalOverlay, renderOverlayCards } from './content-tooltip';
import { startObserver } from './content-observer';
import { mountFrameOverlay, teardownFrameOverlayModule } from './content-frame-overlay';
import { enableBlueprint, disableBlueprint, isBlueprintActive, onLayoutLoaded, onApplyResult } from './content-blueprint';
import { sendFireForget } from './lib/messaging';

declare global {
  interface Window {
    __crev_content_loaded?: boolean;
    __crev_observer?: MutationObserver;
    /** Teardown for the CURRENT content-script instance. A re-injection
     *  (chrome.scripting.executeScript re-runs this file in the same
     *  isolated world) calls the PREVIOUS instance's teardown — reachable
     *  only via window, since module closures don't survive the re-run —
     *  to dispose its port, observer, and listeners before booting fresh.
     *  Without this, every SW idle→reinject cycle stacks another live
     *  instance (duplicate MOUNT_FRAME → two editor windows; a stale
     *  observer/port that re-paints overlays after inspect is toggled off). */
    __crev_teardown?: () => void;
  }
}

// ── Single state instance ────────────────────────────────────────

const s = new ContentState();

// ── Inspect mode ─────────────────────────────────────────────────

// Per-tab record of whether inspect was on, so a fresh content-script instance
// can repaint borders immediately instead of waiting for the SW. sessionStorage
// survives a re-injection (same page) but not a cross-origin navigation, which
// is exactly the scope we want. Reads/writes are guarded — sessionStorage can
// throw in sandboxed frames or when storage is disabled.
const INSPECT_SS_KEY = 'crev_inspect';
function persistInspect(active: boolean): void {
  try { sessionStorage.setItem(INSPECT_SS_KEY, active ? '1' : '0'); } catch { /* sandboxed / disabled */ }
}
function wasInspecting(): boolean {
  try { return sessionStorage.getItem(INSPECT_SS_KEY) === '1'; } catch { return false; }
}

function setInspectMode(active: boolean) {
  s.inspectActive = active;
  // Persist only AUTHORITATIVE state (SW push / local toggle), not state driven
  // by a cross-tab sync. SW inspect state is per-window but the crev_sync_inspect
  // broadcast is per-origin, so a window-A toggle can flip a same-origin tab in
  // window B (whose SW says off). Persisting that would make the optimistic
  // boot-restore repaint the wrong state after a re-injection; skipping the
  // persist lets window B's SW reconcile to its real (off) state instead.
  if (!s.fromSync) persistInspect(active);
  if (active) {
    injectStyles();
    syncOverlays(s);
  } else {
    if (s.debounceTimer) { clearTimeout(s.debounceTimer); s.debounceTimer = null; }
    removeOverlays(s);
    s.requestedRids.clear();
    hideQuickInspector();
  }
}

// ── Style injection ──────────────────────────────────────────────

function injectStyles() {
  if (s.styleInjected) return;
  const style = document.createElement('style');
  style.id = 'crev-inspector-styles';
  style.textContent = OVERLAY_CSS;
  document.head.appendChild(style);

  const tooltip = document.createElement('div');
  tooltip.id = 'crev-tooltip';
  document.body.appendChild(tooltip);

  // Delegated hover handler for the badge pills. Hovering the pill (not the
  // whole widget) shows the info card — the widget body stays clickable for
  // BMP without summoning the tooltip. Attached with the injection-lifetime
  // AbortSignal so resetContentState() detaches it — without that, a
  // double-injection would pile up identical listeners and we'd be running
  // this on every mouse move.
  document.body.addEventListener('mouseover', (e) => {
    if (!s.inspectActive) return;
    const pill = (e.target as HTMLElement).closest?.('.crev-label') as HTMLElement | null;
    if (pill === s.hoveredLabelEl) return;
    s.hoveredLabelEl = pill;
    const rid = pill?.getAttribute('data-crev-label');
    if (pill && rid) {
      showTooltipForElement(s, pill, rid);
    } else {
      hideTooltip(s);
    }
  }, { signal: s.listenerLifetime.signal });

  // Click-to-open lives on the badge pill itself (content-overlays.ts).
  // No document-level body click handler — clicks on widget body fall
  // through to BMP's own click handling, which is what users expect.

  // Paint mode banner
  const banner = h('div', { id: 'crev-paint-banner' },
    h('span', { id: 'crev-paint-text' }, 'Paint Format'),
    h('button', {
      class: 'crev-paint-close',
      id: 'crev-paint-close',
      'aria-label': 'Close paint mode',
      onClick: () => sendToSW({ type: 'TOGGLE_PAINT' } as InspectorMessage),
    }, '\u2715'),
  );
  document.body.appendChild(banner);

  s.styleInjected = true;
}

// ── Connection state + env tag + toasts ──────────────────────────

function handleConnectionState(state: ConnectionState) {
  const prev = s.prevConnDisplay;
  s.prevConnDisplay = state.display;

  const envState = state.display === 'connected' ? 'connected'
    : (state.display === 'not-configured' ? 'not-configured' : 'disconnected');
  const envLabel = state.profileLabel ?? 'CREV';

  if (s.lastDetection?.isBmp) {
    initEnvTag(envLabel, envState);
  }

  if (prev !== null && prev !== state.display) {
    if (state.display === 'connected' && prev !== 'connected') {
      showToast(`Connected to ${state.profileLabel ?? 'server'}`, 'success');
    } else if (state.display === 'auth-failed' && prev !== 'auth-failed') {
      showToast('Auth failed', 'error');
    } else if (state.display === 'unreachable' && prev !== 'unreachable') {
      showToast('Server unreachable', 'error');
    } else if (state.display === 'server-down' && prev !== 'server-down') {
      showToast('Server down', 'error');
    }
  }
}

function handleProfileSwitched(label: string) {
  showToast(`Switched to ${label}`, 'info');
  s.overlayProps.clear();
  renderOverlayCards(s);
  if (s.technicalOverlay) applyTechnicalOverlay(s);
  if (s.lastDetection?.isBmp) {
    updateEnvTag(label, 'connected');
  }
}

// ── BMP Detection ────────────────────────────────────────────────

function runDetection() {
  const result = detectBmpPage();
  s.lastDetection = result;
  sendToSW({ type: 'DETECTION_RESULT', confidence: result.confidence, signals: result.signals, isBmp: result.isBmp });
  document.dispatchEvent(new CustomEvent('crev-content', { detail: { type: 'CHECK_BMP_SIGNALS' } }));
}

// ── Page info for side panel ─────────────────────────────────────

function handlePageInfoRequest(): { url: string; rid?: string; tabRid?: string; tabName?: string; contextSource?: PageContext['source']; widgets: WidgetInfo[]; detection?: { confidence: number; signals: string[]; isBmp: boolean } } {
  const urlRids = extractUrlRids();
  const det = s.lastDetection ?? detectBmpPage();
  // Always scan widgets when there ARE data-rid elements, regardless of the
  // detection confidence score. The score is informational; a low-confidence
  // page that still has data-rid elements is worth listing rather than
  // hiding behind a detection gate. The empty state remains accurate on
  // truly non-BMP pages because scanPageWidgets returns [] in that case.
  const widgets = scanPageWidgets();

  if (det.isBmp) {
    document.dispatchEvent(new CustomEvent('crev-content', { detail: { type: 'EXTRACT_FIBERS' } }));
  }

  // Single resolution — URL ⊕ fiber. On a custom-routed page (no `?rid=`) the
  // bound object comes from the fiber context the interceptor posted; the
  // EXTRACT_FIBERS dispatch above keeps it fresh (a late PAGE_CONTEXT triggers
  // a re-query, see the PAGE_CONTEXT handler).
  const ctx = resolvePageContext(urlRids, s.fiberPageContext);

  return {
    url: window.location.href,
    rid: ctx.rid,
    tabRid: ctx.tabRid,
    tabName: ctx.tabName,
    contextSource: ctx.source,
    widgets,
    detection: { confidence: det.confidence, signals: det.signals, isBmp: det.isBmp },
  };
}

/** Fiber page context arrived from the interceptor. Cache it locally (for the
 *  next PAGE_INFO) and forward to the SW, which caches it per tab for the
 *  footer + editor EC `this` and refreshes the panel when it changes. Deduped
 *  so a re-scan that yields the same context doesn't churn the SW/panel. */
function handleFiberPageContext(rid?: string, tabRid?: string) {
  const prev = s.fiberPageContext;
  if (prev?.rid === rid && prev?.tabRid === tabRid) return;
  s.fiberPageContext = (rid || tabRid) ? { rid, tabRid } : null;
  sendToSW({ type: 'PAGE_CONTEXT', rid, tabRid });
}

// ── Service worker message handling ──────────────────────────────

onPortMessage((msg: InspectorMessage) => {
  switch (msg.type) {
    case 'INSPECT_STATE':
      setInspectMode(msg.active);
      if (!s.fromSync) broadcast('crev_sync_inspect', { active: msg.active });
      break;
    case 'BLUEPRINT_STATE':
      if (msg.active) enableBlueprint(); else disableBlueprint();
      break;
    case 'LAYOUT_LOAD_RESULT':
      if (isBlueprintActive()) onLayoutLoaded(msg);
      break;
    case 'LAYOUT_APPLY_RESULT':
      if (isBlueprintActive()) onApplyResult(msg);
      break;
    case 'BADGE_ENRICHMENT':
      // Drop the rid from `requestedRids` as soon as we get ANY
      // response — succeeded or failed. The dedup set's purpose is
      // to prevent duplicate in-flight queries, not to block
      // retries. Without this clear, a transient enrichment failure
      // would lock the rid out for the lifetime of the page.
      for (const [rid, data] of Object.entries(msg.enrichments)) {
        s.enrichments.set(rid, data);
        s.requestedRids.delete(rid);
      }
      if (s.inspectActive) updateLabels(s);
      break;
    case 'PAINT_STATE':
      s.paintPhase = msg.phase;
      s.paintSourceName = msg.sourceName ?? null;
      updatePaintCursors(s);
      if (!s.fromSync) broadcast('crev_sync_paint', { phase: msg.phase, sourceName: msg.sourceName });
      break;
    case 'PAINT_APPLY_RESULT':
      flashApplyResult(msg.rid, msg.ok, msg.error);
      // Paint stays armed (phase still 'applying' in the SW) so the user can
      // immediately click the next target — instant-apply sticky painting.
      if (s.paintPhase === 'applying') updatePaintCursors(s);
      break;
    case 'ENRICH_MODE':
      if (msg.mode !== s.enrichMode) {
        s.enrichMode = msg.mode;
        if (s.inspectActive) {
          s.requestedRids.clear();
          removeOverlays(s);
          syncOverlays(s);
        }
      }
      break;
    case 'RE_ENRICH':
      s.requestedRids.clear();
      if (s.inspectActive) syncOverlays(s);
      break;
    case 'CONNECTION_STATE':
      handleConnectionState(msg.state);
      break;
    case 'PROFILE_SWITCHED':
      handleProfileSwitched(msg.label);
      if (!s.fromSync) broadcast('crev_sync_profile', { label: msg.label });
      break;
    case 'TECHNICAL_OVERLAY_STATE':
      s.technicalOverlay = msg.active;
      applyTechnicalOverlay(s);
      if (!s.fromSync) broadcast('crev_sync_overlay', { active: msg.active });
      break;
  }
  // Broadcast subscribers run last — see handler-registry.ts. The switch
  // above stays the source of truth for content-script state mutation; new
  // feature modules wanting to observe (without joining the switch) should
  // subscribe() instead.
  dispatchBroadcast(msg);
});

onReconnect(() => {
  s.requestedRids.clear();
  if (s.lastDetection) {
    const det = s.lastDetection;
    queueMicrotask(() => {
      sendToSW({ type: 'DETECTION_RESULT', confidence: det.confidence,
                 signals: det.signals, isBmp: det.isBmp });
    });
  }
  // Don't syncOverlays here — the SW sends INSPECT_STATE on port connect,
  // which triggers setInspectMode() → syncOverlays(). Calling it here
  // would race against the message and run with stale s.inspectActive.
});

// ── Cross-tab sync ───────────────────────────────────────────────

onSync('crev_sync_inspect', (data) => {
  const d = data as { active: boolean };
  if (d.active !== s.inspectActive) {
    s.fromSync = true;
    try { setInspectMode(d.active); } finally { s.fromSync = false; }
  }
});

onSync('crev_sync_paint', (data) => {
  const d = data as { phase: PaintPhase; sourceName?: string };
  s.fromSync = true;
  try {
    s.paintPhase = d.phase;
    s.paintSourceName = d.sourceName ?? null;
    updatePaintCursors(s);
  } finally { s.fromSync = false; }
});

onSync('crev_sync_overlay', (data) => {
  const d = data as { active: boolean };
  if (d.active !== s.technicalOverlay) {
    s.fromSync = true;
    try {
      s.technicalOverlay = d.active;
      applyTechnicalOverlay(s);
    } finally { s.fromSync = false; }
  }
});

onSync('crev_sync_profile', (data) => {
  const d = data as { label: string; connected?: boolean };
  s.fromSync = true;
  if (s.lastDetection?.isBmp) {
    updateEnvTag(d.label, d.connected !== false ? 'connected' : 'disconnected');
  }
  s.fromSync = false;
});

// ── Context menu RID tracking ────────────────────────────────────

document.body.addEventListener('contextmenu', (e) => {
  const ridEl = (e.target as HTMLElement).closest?.('[data-rid]');
  if (ridEl) {
    const rid = ridEl.getAttribute('data-rid');
    if (rid) {
      const enrichment = s.enrichments.get(rid);
      // Right-click promotes the widget to the user's working surface:
      // SET_CONTEXT_RID retargets Workshop's layout half and the
      // status-bar context chip; SELECT_OBJECT loads it into the
      // detail half.
      sendFireForget({
        type: 'SET_CONTEXT_RID',
        rid,
        name: enrichment?.name,
        objectType: enrichment?.type,
        businessId: enrichment?.businessId,
      });
      sendFireForget({ type: 'SELECT_OBJECT', rid });
    }
  }
}, { capture: true, signal: s.listenerLifetime.signal });

// ── Escape + click-outside dismiss quick inspector ───────────────

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (isQuickInspectorVisible()) {
    hideQuickInspector();
    return;
  }
  // Esc stops an active paint session (matches the in-page banner hint).
  if (s.paintPhase !== 'off') {
    sendToSW({ type: 'TOGGLE_PAINT' } as InspectorMessage);
  }
}, { signal: s.listenerLifetime.signal });

document.addEventListener('click', (e) => {
  if (!isQuickInspectorVisible()) return;
  const target = e.target as HTMLElement;
  if (target.closest('#crev-quick-inspector')) return;
  hideQuickInspector();
}, { capture: true, signal: s.listenerLifetime.signal });

// ── Messages from MAIN world interceptor (via CustomEvent) ───────

document.addEventListener('crev-interceptor', ((event: CustomEvent) => {
  const msg = event.detail;
  if (msg.type === 'OBJECTS_DISCOVERED') {
    sendToSW(msg);
  }

  if (msg.type === 'PAGE_CONTEXT') {
    handleFiberPageContext(msg.rid, msg.tabRid);
  }

  if (msg.type === 'BMP_SIGNALS_RESULT') {
    const mainSignals = msg.signals ?? [];
    if (s.lastDetection && mainSignals.length > 0) {
      const allSignals = [...s.lastDetection.signals, ...mainSignals];
      const extraWeight = mainSignals.length * 0.15;
      const confidence = Math.min(1, s.lastDetection.confidence + extraWeight);
      const isBmp = confidence >= 0.5;
      sendToSW({ type: 'DETECTION_RESULT', confidence, signals: allSignals, isBmp });
    }
  }
}) as EventListener, { signal: s.listenerLifetime.signal });

// ── One-shot message handler for side panel requests ─────────────

function oneShotMessageListener(msg: InspectorMessage, _sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void): boolean {
  if (msg.type === 'INSPECT_STATE') {
    setInspectMode(msg.active);
    return false;
  }
  // Blueprint toggle arrives via chrome.tabs.sendMessage (one-shot), like INSPECT_STATE — the
  // SW's BLUEPRINT_TOGGLE handler relays here. (LAYOUT_*_RESULT come back on the port instead.)
  if (msg.type === 'BLUEPRINT_STATE') {
    if (msg.active) enableBlueprint(); else disableBlueprint();
    return false;
  }
  if (msg.type === 'GET_PAGE_INFO') {
    const info = handlePageInfoRequest();
    sendResponse({ type: 'PAGE_INFO', ...info });
    return true;
  }
  if (msg.type === 'COPY_TO_CLIPBOARD') {
    navigator.clipboard.writeText(msg.text).catch(e => log.swallow('content:clipboardWrite', e));
    return false;
  }
  if (msg.type === 'MOUNT_FRAME') {
    mountFrameOverlay({
      kind: msg.kind,
      url: msg.url,
      label: msg.label,
      defaultWidth: msg.defaultWidth,
      defaultHeight: msg.defaultHeight,
    }).catch(e => log.swallow('content:mountFrame', e));
    return false;
  }
  if (msg.type === 'BMP_GOTO') {
    // In-place BMP navigation (from the Extended Code editor's "go to this
    // object" action). Switch BMP tab by clicking the matching tab button
    // (no page reload), then scroll-and-highlight the target widget once the
    // tab body re-renders. If we're already on the right tab, skip the click.
    handleBmpGoto(msg);
    return false;
  }
  return false;
}
chrome.runtime.onMessage.addListener(oneShotMessageListener);

function handleBmpGoto(msg: { rid?: string; tabRid?: string; tabName?: string }): void {
  for (const el of document.querySelectorAll('.crev-graph-highlight')) {
    el.classList.remove('crev-graph-highlight');
  }
  let needsTabSwitch = false;
  if (msg.tabName || msg.tabRid) {
    const tabButton = findTabButton(msg.tabRid, msg.tabName);
    if (tabButton) {
      const alreadyActive = isTabActive(tabButton);
      if (!alreadyActive) {
        // Click the tab anchor — BMP intercepts this and switches the tab
        // body in place (SPA-style, no page reload). This is the "smooth
        // switch" path; the full-reload NAVIGATE_BMP is never used here.
        tabButton.click();
        needsTabSwitch = true;
      }
    } else {
      // eslint-disable-next-line no-console
      console.warn('[crev] BMP_GOTO: no tab button found for', { tabName: msg.tabName, tabRid: msg.tabRid });
    }
  }
  if (msg.rid) {
    // After a tab switch the widget DOM may not exist yet — wait one
    // frame plus a beat for BMP to re-render before scrolling.
    if (needsTabSwitch) {
      setTimeout(() => scrollAndHighlight(msg.rid!), 250);
    } else {
      scrollAndHighlight(msg.rid);
    }
  }
}

// Tab matching + active-state detection live in dom-scanner.ts (the single
// source of truth for BMP's tab DOM shape). content.ts used to carry its own
// drifted copy that matched none of BMP's real `.corpo-tabSet__tab` anchors —
// so BMP_GOTO silently found no button and tab navigation did nothing.

function scrollAndHighlight(rid: string): void {
  const escaped = rid.replace(/[^a-zA-Z0-9_-]/g, c => `\\${c}`);
  const target = document.querySelector(`[data-rid="${escaped}"], [data-object-rid="${escaped}"]`);
  if (target instanceof HTMLElement) {
    target.classList.add('crev-graph-highlight');
    target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

// ── Init ─────────────────────────────────────────────────────────

function resetContentState() {
  removeOverlays(s);
  hideQuickInspector();
  destroyEnvTag();
  teardownFrameOverlayModule();
  disableBlueprint();
  document.getElementById('crev-inspector-styles')?.remove();
  document.getElementById('crev-tooltip')?.remove();
  document.getElementById('crev-paint-banner')?.remove();
  document.getElementById('crev-toast-container')?.remove();
  // resetAll() aborts the listener lifetime (detaches mouseover + paint
  // banner click + everything attached with that signal) and arms a
  // fresh controller for the next injection.
  s.resetAll();
}

/** Fully dispose THIS content-script instance. Stored on `window` so the
 *  next injection can reach it. resetContentState() handles the DOM +
 *  ContentState + lifetime-bound document listeners; the rest tears down
 *  the module-scoped registrations that resetContentState() can't see
 *  (they live in other modules' closures): the one-shot message listener,
 *  the reconnecting port, and the cross-tab storage subscriptions. */
function teardown() {
  resetContentState();
  try { chrome.runtime.onMessage.removeListener(oneShotMessageListener); } catch (e) { log.swallow('content:teardown:onMessage', e); }
  try { disconnectPort(); } catch (e) { log.swallow('content:teardown:port', e); }
  try { teardownCrossTab(); } catch (e) { log.swallow('content:teardown:crossTab', e); }
}

// Guard against double injection. A re-injection re-runs this file in the
// same isolated world but with FRESH module closures — so we can't reach
// the previous instance's port/observer/listeners from here. The previous
// instance parked its teardown on window; run it to dispose that instance
// completely before we boot, otherwise both stay live (two MOUNT_FRAME
// handlers → duplicate editor windows; a stale observer/port that re-paints
// overlays after inspect is toggled off).
if (window.__crev_content_loaded) {
  try { window.__crev_teardown?.(); } catch (e) { log.swallow('content:init:teardownPrev', e); }
}
window.__crev_content_loaded = true;
window.__crev_teardown = teardown;

try { connectPort(); } catch (e) { log.swallow('content:init:port', e); }
try { runDetection(); } catch (e) { log.swallow('content:init:detection', e); }

// Optimistic inspect restore. If this tab was inspecting before this instance
// booted — e.g. the SW idled out and a panel/tab event re-injected content.js
// into the still-live page (the previous instance's teardown removed the
// overlays) — repaint the borders NOW from local state rather than waiting for
// the SW to reconnect and re-push INSPECT_STATE. That wait was the window where
// borders visibly disappeared "after a while". The real INSPECT_STATE reconciles
// when the port connects; enrichment refills lazily.
if (wasInspecting()) {
  try { setInspectMode(true); } catch (e) { log.swallow('content:init:restoreInspect', e); }
}
try { startObserver(s, runDetection); } catch (e) { log.swallow('content:init:observer', e); }
