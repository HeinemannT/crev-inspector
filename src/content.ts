/**
 * ISOLATED world content script — thin boot + message dispatch layer.
 * State lives in ContentState, logic in content-overlays/paint/tooltip/observer.
 */

import type { InspectorMessage, ConnectionState, WidgetInfo, PaintPhase } from './lib/types';
import { extractUrlRids, scanPageWidgets, detectBmpPage } from './lib/dom-scanner';
import { h } from './lib/dom';
import { log } from './lib/logger';
import { connectPort, sendToSW, onPortMessage, onReconnect } from './lib/content-port';
import { initEnvTag, updateEnvTag, destroyEnvTag } from './lib/env-tag';
import { showToast } from './lib/toast';
import { hideQuickInspector, isQuickInspectorVisible } from './lib/quick-inspector';
import { broadcast, onSync } from './lib/cross-tab';
import OVERLAY_CSS from './content-overlay.css';

import { ContentState } from './content-state';
import { syncOverlays, removeOverlays, updateLabels } from './content-overlays';
import { updatePaintCursors, flashApplyResult, showPaintPreview } from './content-paint';
import { showTooltipForElement, hideTooltip, applyTechnicalOverlay, renderOverlayCards } from './content-tooltip';
import { startObserver } from './content-observer';

declare global {
  interface Window {
    __crev_content_loaded?: boolean;
    __crev_observer?: MutationObserver;
  }
}

// ── Single state instance ────────────────────────────────────────

const s = new ContentState();

// ── Inspect mode ─────────────────────────────────────────────────

function setInspectMode(active: boolean) {
  s.inspectActive = active;
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

  // Delegated hover handler for outlined elements
  document.body.addEventListener('mouseover', (e) => {
    if (!s.inspectActive) return;
    const outline = (e.target as HTMLElement).closest?.('.crev-outline');
    if (outline === s.hoveredOutlineEl) return;
    s.hoveredOutlineEl = outline;
    if (outline) {
      const label = outline.querySelector('[data-crev-label]');
      const rid = label?.getAttribute('data-crev-label');
      if (rid) showTooltipForElement(s, outline as HTMLElement, rid);
    } else {
      hideTooltip(s);
    }
  });

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

function handlePageInfoRequest(): { url: string; rid?: string; tabRid?: string; widgets: WidgetInfo[]; detection?: { confidence: number; signals: string[]; isBmp: boolean } } {
  const urlRids = extractUrlRids();
  const det = s.lastDetection ?? detectBmpPage();
  const widgets = det.isBmp ? scanPageWidgets() : [];

  if (det.isBmp) {
    document.dispatchEvent(new CustomEvent('crev-content', { detail: { type: 'EXTRACT_FIBERS' } }));
  }

  return {
    url: window.location.href,
    rid: urlRids.rid,
    tabRid: urlRids.tabRid,
    widgets,
    detection: { confidence: det.confidence, signals: det.signals, isBmp: det.isBmp },
  };
}

// ── Service worker message handling ──────────────────────────────

onPortMessage((msg: InspectorMessage) => {
  switch (msg.type) {
    case 'INSPECT_STATE':
      setInspectMode(msg.active);
      if (!s.fromSync) broadcast('crev_sync_inspect', { active: msg.active });
      break;
    case 'BADGE_ENRICHMENT':
      for (const [rid, data] of Object.entries(msg.enrichments)) {
        s.enrichments.set(rid, data);
      }
      if (s.inspectActive) updateLabels(s);
      break;
    case 'PAINT_STATE':
      s.paintPhase = msg.phase;
      s.paintSourceName = msg.sourceName ?? null;
      updatePaintCursors(s);
      if (!s.fromSync) broadcast('crev_sync_paint', { phase: msg.phase, sourceName: msg.sourceName });
      break;
    case 'PAINT_PREVIEW':
      showPaintPreview(s, msg.rid, msg.diff);
      break;
    case 'PAINT_APPLY_RESULT':
      flashApplyResult(msg.rid, msg.ok, msg.error);
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
      try {
        chrome.runtime.sendMessage({
          type: 'SET_CONTEXT_RID',
          rid,
          name: enrichment?.name,
          objectType: enrichment?.type,
          businessId: enrichment?.businessId,
        });
      } catch (e) { log.swallow('content:contextmenu', e); }
    }
  }
}, true);

// ── Escape + click-outside dismiss quick inspector ───────────────

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isQuickInspectorVisible()) {
    hideQuickInspector();
  }
});

document.addEventListener('click', (e) => {
  if (!isQuickInspectorVisible()) return;
  const target = e.target as HTMLElement;
  if (target.closest('#crev-quick-inspector')) return;
  hideQuickInspector();
}, true);

// ── Messages from MAIN world interceptor (via CustomEvent) ───────

document.addEventListener('crev-interceptor', ((event: CustomEvent) => {
  const msg = event.detail;
  if (msg.type === 'OBJECTS_DISCOVERED') {
    sendToSW(msg);
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
}) as EventListener);

// ── One-shot message handler for side panel requests ─────────────

chrome.runtime.onMessage.addListener((msg: InspectorMessage, _sender, sendResponse) => {
  if (msg.type === 'INSPECT_STATE') {
    setInspectMode(msg.active);
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
  return false;
});

// ── Init ─────────────────────────────────────────────────────────

function resetContentState() {
  s.observer?.disconnect();
  removeOverlays(s);
  hideQuickInspector();
  destroyEnvTag();
  document.getElementById('crev-inspector-styles')?.remove();
  document.getElementById('crev-tooltip')?.remove();
  document.getElementById('crev-paint-banner')?.remove();
  document.getElementById('crev-toast-container')?.remove();
  s.styleInjected = false;
}

// Guard against double injection
if (window.__crev_content_loaded) {
  resetContentState();
}
window.__crev_content_loaded = true;

try { connectPort(); } catch (e) { log.swallow('content:init:port', e); }
try { runDetection(); } catch (e) { log.swallow('content:init:detection', e); }
try { startObserver(s, runDetection); } catch (e) { log.swallow('content:init:observer', e); }
