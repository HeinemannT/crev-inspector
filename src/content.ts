/**
 * ISOLATED world content script.
 * Renders outlined elements with corner labels and a hover tooltip on [data-rid] elements.
 * Bridges messages between MAIN world interceptor and service worker via CustomEvents.
 */

import type { BmpObject, InspectorMessage, ConnectionState, WidgetInfo, PaintPhase, EnrichMode } from './lib/types';
import { getTypeColor, getTypeAbbr, TYPES_WITH_CODE } from './lib/types';
import { getAllRidElements, extractUrlRids, scanPageWidgets, detectBmpPage, type DetectionResult } from './lib/dom-scanner';
import { h, render } from './lib/dom';
import { log } from './lib/logger';
import { OVERLAY_SYNC_DEBOUNCE, DISCOVERED_RIDS_CAP } from './lib/constants';
import { connectPort, sendToSW, onPortMessage, onReconnect } from './lib/content-port';
import { initEnvTag, updateEnvTag, destroyEnvTag } from './lib/env-tag';
import { showToast } from './lib/toast';
import { showQuickInspector, hideQuickInspector, isQuickInspectorVisible } from './lib/quick-inspector';
import { broadcast, onSync } from './lib/cross-tab';
import OVERLAY_CSS from './content-overlay.css';

declare global {
  interface Window {
    __crev_content_loaded?: boolean;
    __crev_observer?: MutationObserver;
  }
}

// ── State ───────────────────────────────────────────────────────

let inspectActive = false;
let enrichMode: EnrichMode = 'all';
let paintPhase: PaintPhase = 'off';
let paintSourceName: string | null = null;
let observer: MutationObserver | null = null;
let styleInjected = false;

// Enrichment data from server (RID → business ID / type / name)
const enrichments = new Map<string, { businessId?: string; type?: string; name?: string }>();

// Cached properties for richer technical overlay cards
const overlayProps = new Map<string, Record<string, string>>();

// WeakSet tracks which elements already have overlays attached
let badgedElements = new WeakSet<Element>();

// Dedup: RIDs we've already requested enrichment for (reset on inspect-off and URL change)
const requestedRids = new Set<string>();

// Dedup: RIDs we've already sent as OBJECTS_DISCOVERED (reset on URL change)
const discoveredRids = new Set<string>();

// Track last URL for SPA navigation detection
let lastUrl = window.location.href;

// Detection state
let lastDetection: DetectionResult | null = null;

// Tooltip hide timer
let tooltipHideTimer: ReturnType<typeof setTimeout> | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let hoveredOutlineEl: Element | null = null;

// Connection state tracking for env tag + toasts
let prevConnDisplay: string | null = null;

// Technical overlay state
let technicalOverlay = false;

// Favorites cache for quick inspector star state
let favoriteRids = new Set<string>();

// Double-click detection for quick inspector
let labelClickTimer: ReturnType<typeof setTimeout> | null = null;
let labelClickRid: string | null = null;

// Cross-tab sync guard
let fromSync = false;

// ── Service worker message handling ──────────────────────────────

onPortMessage((msg: InspectorMessage) => {
  switch (msg.type) {
    case 'INSPECT_STATE':
      setInspectMode(msg.active);
      if (!fromSync) broadcast('crev_sync_inspect', { active: msg.active });
      break;
    case 'BADGE_ENRICHMENT':
      for (const [rid, data] of Object.entries(msg.enrichments)) {
        enrichments.set(rid, data);
      }
      if (inspectActive) updateLabels();
      break;
    case 'PAINT_STATE':
      paintPhase = msg.phase;
      paintSourceName = msg.sourceName ?? null;
      updatePaintCursors();
      if (!fromSync) broadcast('crev_sync_paint', { phase: msg.phase, sourceName: msg.sourceName });
      break;
    case 'PAINT_PREVIEW':
      showPaintPreview(msg.rid, msg.diff);
      break;
    case 'PAINT_APPLY_RESULT':
      flashApplyResult(msg.rid, msg.ok, msg.error);
      break;
    case 'ENRICH_MODE':
      if (msg.mode !== enrichMode) {
        enrichMode = msg.mode;
        if (inspectActive) {
          requestedRids.clear();
          removeOverlays();
          syncOverlays();
        }
      }
      break;
    case 'RE_ENRICH':
      requestedRids.clear();
      if (inspectActive) syncOverlays();
      break;
    case 'CONNECTION_STATE':
      handleConnectionState(msg.state);
      break;
    case 'PROFILE_SWITCHED':
      handleProfileSwitched(msg.label);
      if (!fromSync) broadcast('crev_sync_profile', { label: msg.label });
      break;
    case 'TECHNICAL_OVERLAY_STATE':
      technicalOverlay = msg.active;
      applyTechnicalOverlay();
      if (!fromSync) broadcast('crev_sync_overlay', { active: msg.active });
      break;
  }
});

onReconnect(() => {
  requestedRids.clear();
  // Re-send last detection so SW has current state
  if (lastDetection) {
    const det = lastDetection;
    queueMicrotask(() => {
      sendToSW({ type: 'DETECTION_RESULT', confidence: det.confidence,
                 signals: det.signals, isBmp: det.isBmp });
    });
  }
  if (inspectActive) syncOverlays();
});

// ── Connection state + env tag + toasts ─────────────────────────

function handleConnectionState(state: ConnectionState) {
  const prev = prevConnDisplay;
  prevConnDisplay = state.display;

  // Env tag updates
  const envState = state.display === 'connected' ? 'connected'
    : (state.display === 'not-configured' ? 'not-configured' : 'disconnected');
  const envLabel = state.profileLabel ?? 'CREV';

  if (lastDetection?.isBmp) {
    initEnvTag(envLabel, envState);
  }

  // Toasts on transitions
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
  overlayProps.clear();
  renderOverlayCards();
  if (technicalOverlay) applyTechnicalOverlay();
  if (lastDetection?.isBmp) {
    updateEnvTag(label, 'connected');
  }
}

// ── Inspect mode ────────────────────────────────────────────────

function setInspectMode(active: boolean) {
  inspectActive = active;
  if (active) {
    injectStyles();
    syncOverlays();
  } else {
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    removeOverlays();
    requestedRids.clear();
    hideQuickInspector();
  }
}

// ── Style injection ─────────────────────────────────────────────

function injectStyles() {
  if (styleInjected) return;
  const style = document.createElement('style');
  style.id = 'crev-inspector-styles';
  style.textContent = OVERLAY_CSS;
  document.head.appendChild(style);

  // Create singleton tooltip element
  const tooltip = document.createElement('div');
  tooltip.id = 'crev-tooltip';
  document.body.appendChild(tooltip);

  // Delegated hover handler for outlined elements (avoids per-element listeners)
  document.body.addEventListener('mouseover', (e) => {
    if (!inspectActive) return;
    const outline = (e.target as HTMLElement).closest?.('.crev-outline');
    if (outline === hoveredOutlineEl) return;
    hoveredOutlineEl = outline;
    if (outline) {
      const label = outline.querySelector('[data-crev-label]');
      const rid = label?.getAttribute('data-crev-label');
      if (rid) showTooltipForElement(outline as HTMLElement, rid);
    } else {
      hideTooltip();
    }
  });

  // Create paint mode banner
  const banner = h('div', { id: 'crev-paint-banner' },
    h('span', { id: 'crev-paint-text' }, 'Paint Format'),
    h('button', {
      class: 'crev-paint-close',
      id: 'crev-paint-close',
      onClick: () => sendToSW({ type: 'TOGGLE_PAINT' } as InspectorMessage),
    }, '\u2715'),
  );
  document.body.appendChild(banner);

  styleInjected = true;
}

// ── Label helpers ────────────────────────────────────────────────

/** Create a code button (EC / </>) for types with viewable code */
function createCodeButton(rid: string, type: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'crev-ec-btn';
  btn.textContent = type === 'CustomVisualization' ? '</>' : 'EC';
  btn.title = 'Open in editor';
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    chrome.runtime.sendMessage({ type: 'OPEN_EDITOR', rid });
  });
  return btn;
}

// ── Overlay placement — incremental sync ────────────────────────

/** Incremental overlay sync: clean stale, add new. */
function syncOverlays() {
  // 1. Clean stale labels (detached parents or elements no longer in DOM)
  for (const label of document.querySelectorAll('.crev-label')) {
    if (!label.parentElement || !document.body.contains(label.parentElement)) {
      label.remove();
    }
  }

  const includeLinks = enrichMode === 'all';
  const elements = getAllRidElements(includeLinks);
  const linkCount = includeLinks ? elements.filter(({ element }) => element.tagName === 'A').length : 0;
  log.debug('sync', `syncOverlays: ${elements.length} elements (${linkCount} links), enrichMode=${enrichMode}`);
  const ridsToEnrich: string[] = [];

  // Filter to new elements only
  const newElements = elements.filter(({ element }) => !badgedElements.has(element));

  // Write pass: apply DOM changes
  for (const { element, rid } of newElements) {
    const enrichment = enrichments.get(rid);
    const color = getTypeColor(enrichment?.type);

    element.classList.add('crev-outline');
    (element as HTMLElement).style.setProperty('--crev-color', color);

    // Create corner label (flex container: text + optional code button)
    const label = document.createElement('span');
    label.className = 'crev-label';
    if (!enrichment) label.classList.add('crev-label-loading');
    label.setAttribute('data-crev-label', rid);

    const labelText = document.createElement('span');
    labelText.className = 'crev-label-text';
    labelText.textContent = enrichment?.businessId ?? enrichment?.name ?? getTypeAbbr(enrichment?.type);
    label.appendChild(labelText);

    // Click text → paint pick/apply if in paint mode, otherwise copy (with dblclick → quick inspector)
    labelText.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      if (paintPhase === 'picking') {
        sendToSW({ type: 'PAINT_PICK', rid });
        label.classList.add('crev-label-flash-pick');
        setTimeout(() => { label.classList.remove('crev-label-flash-pick'); }, 400);
        return;
      }

      if (paintPhase === 'applying') {
        sendToSW({ type: 'PAINT_APPLY', rid });
        return;
      }

      // Double-click detection: 250ms window
      if (labelClickRid === rid && labelClickTimer) {
        // Second click → cancel copy, open quick inspector
        clearTimeout(labelClickTimer);
        labelClickTimer = null;
        labelClickRid = null;
        openQuickInspector(label, rid);
        return;
      }

      // First click → set timer for single-click (copy BID)
      labelClickRid = rid;
      labelClickTimer = setTimeout(() => {
        labelClickTimer = null;
        labelClickRid = null;
        // Execute single-click: copy business ID
        const enriched = enrichments.get(rid);
        const text = enriched?.businessId ?? rid;
        navigator.clipboard.writeText(text).then(() => {
          const original = labelText.textContent;
          labelText.textContent = '\u2713';
          label.classList.add('crev-label-flash-ok');
          setTimeout(() => {
            labelText.textContent = original;
            label.classList.remove('crev-label-flash-ok');
          }, 600);
        }).catch(e => log.swallow('content:clipboard', e));
      }, 250);
    });

    // Add code button for types with viewable code
    if (enrichment?.type && TYPES_WITH_CODE.has(enrichment.type)) {
      label.appendChild(createCodeButton(rid, enrichment.type));
    }

    element.appendChild(label);
    badgedElements.add(element);

    // Track RIDs that need enrichment (with dedup)
    if (!enrichments.has(rid) && !requestedRids.has(rid)) {
      ridsToEnrich.push(rid);
      requestedRids.add(rid);
    }
  }

  // Also check already-badged elements whose enrichment was never completed
  // (e.g. after RE_ENRICH when version detection finishes on older BMP servers)
  for (const { rid } of elements) {
    if (!enrichments.has(rid) && !requestedRids.has(rid)) {
      ridsToEnrich.push(rid);
      requestedRids.add(rid);
    }
  }

  // Request enrichment for unknown RIDs
  if (ridsToEnrich.length > 0) {
    log.debug('sync', `ENRICH_BADGES: sending ${ridsToEnrich.length} RIDs`, ridsToEnrich);
    sendToSW({ type: 'ENRICH_BADGES', rids: ridsToEnrich });
  }

  // Also discover objects for the cache (dedup: only send new RIDs)
  const now = Date.now();
  const newDiscovered: BmpObject[] = [];
  for (const { rid } of elements) {
    if (!discoveredRids.has(rid) && discoveredRids.size < DISCOVERED_RIDS_CAP) {
      discoveredRids.add(rid);
      newDiscovered.push({ rid, source: 'dom' as const, discoveredAt: now, updatedAt: now });
    }
  }
  if (newDiscovered.length > 0) {
    sendToSW({ type: 'OBJECTS_DISCOVERED', objects: newDiscovered });
  }
}

function removeOverlays() {
  for (const label of document.querySelectorAll('.crev-label')) {
    label.remove();
  }
  for (const el of document.querySelectorAll('.crev-outline')) {
    el.classList.remove('crev-outline');
    (el as HTMLElement).style.removeProperty('--crev-color');
  }
  const tooltip = document.getElementById('crev-tooltip');
  if (tooltip) tooltip.style.display = 'none';
  hoveredOutlineEl = null;
  badgedElements = new WeakSet();
  overlayProps.clear();
}

function updateLabels() {
  for (const label of document.querySelectorAll<HTMLElement>('[data-crev-label]')) {
    const rid = label.getAttribute('data-crev-label');
    if (!rid) continue;
    const enrichment = enrichments.get(rid);
    if (enrichment) {
      const textSpan = label.querySelector('.crev-label-text');
      if (textSpan) {
        textSpan.textContent = enrichment.businessId ?? enrichment.name ?? getTypeAbbr(enrichment.type);
      }
      label.classList.remove('crev-label-loading');
      const parent = label.parentElement;
      if (parent) {
        const color = getTypeColor(enrichment.type);
        parent.style.setProperty('--crev-color', color);
      }
      if (enrichment.type && TYPES_WITH_CODE.has(enrichment.type) && !label.querySelector('.crev-ec-btn')) {
        label.appendChild(createCodeButton(rid, enrichment.type));
      }
    }
  }
}

// ── Quick Inspector ─────────────────────────────────────────────

function openQuickInspector(labelEl: HTMLElement, rid: string) {
  const enrichment = enrichments.get(rid);
  // Fetch current favorites for star state
  chrome.runtime.sendMessage({ type: 'GET_FAVORITES' }, (response: any) => {
    if (response?.entries) {
      favoriteRids = new Set(response.entries.map((e: any) => e.rid));
    }
    showQuickInspector(labelEl, {
      rid,
      businessId: enrichment?.businessId,
      type: enrichment?.type,
      name: enrichment?.name,
      isFavorite: favoriteRids.has(rid),
    }, (editorRid) => {
      chrome.runtime.sendMessage({ type: 'OPEN_EDITOR', rid: editorRid });
    }, (favRid) => {
      chrome.runtime.sendMessage({ type: 'TOGGLE_FAVORITE', rid: favRid, name: enrichment?.name, objectType: enrichment?.type, businessId: enrichment?.businessId });
      // Optimistic toggle
      if (favoriteRids.has(favRid)) favoriteRids.delete(favRid);
      else favoriteRids.add(favRid);
    }, (viewRid) => {
      chrome.runtime.sendMessage({ type: 'OPEN_OBJECT_VIEW', rid: viewRid });
    });
  });
}

// Escape key dismisses quick inspector
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && isQuickInspectorVisible()) {
    hideQuickInspector();
  }
});

// Click outside dismisses quick inspector
document.addEventListener('click', (e) => {
  if (!isQuickInspectorVisible()) return;
  const target = e.target as HTMLElement;
  if (target.closest('#crev-quick-inspector')) return;
  hideQuickInspector();
}, true);

// ── Paint Format helpers ─────────────────────────────────────

function updatePaintBanner(...content: (Node | string)[]) {
  const banner = document.getElementById('crev-paint-banner');
  const bannerText = document.getElementById('crev-paint-text');
  if (!banner || !bannerText) return;

  if (paintPhase === 'off') {
    banner.style.display = 'none';
    return;
  }

  banner.style.display = 'block';
  banner.style.background = '#ff832b';

  if (content.length > 0) {
    render(bannerText, ...content);
    return;
  }

  if (paintPhase === 'picking') {
    render(bannerText, 'Paint Format \u2014 ', h('b', null, 'click a widget to pick its style'));
  } else {
    render(bannerText, 'Paint Format from ', h('b', null, paintSourceName ?? '?'), ' \u2014 click widgets to apply');
  }
}

function updatePaintCursors() {
  const cursor = paintPhase !== 'off' ? 'crosshair' : 'pointer';
  for (const label of document.querySelectorAll<HTMLElement>('.crev-label-text')) {
    label.style.cursor = cursor;
  }
  updatePaintBanner();
}

function flashApplyResult(rid: string, ok: boolean, error?: string) {
  const label = document.querySelector<HTMLElement>(`[data-crev-label="${rid}"]`);
  if (label) {
    const flashClass = ok ? 'crev-label-flash-ok' : 'crev-label-flash-error';
    label.classList.add(flashClass);
    setTimeout(() => { label.classList.remove(flashClass); }, 600);
  }

  const banner = document.getElementById('crev-paint-banner');
  if (!banner) return;

  if (ok) {
    updatePaintBanner('Applied style \u2014 ', h('b', null, 'refresh page to see changes'));
    setTimeout(() => updatePaintBanner(), 3000);
  } else {
    banner.style.background = '#da1e28';
    const bannerText = document.getElementById('crev-paint-text');
    if (bannerText) {
      const msg = error === 'No source selected'
        ? 'Not connected \u2014 add a server in Connect tab'
        : `Error: ${error ?? 'unknown'}`;
      render(bannerText, msg);
    }
    setTimeout(() => {
      banner.style.background = '#ff832b';
      updatePaintBanner();
    }, 4000);
  }
}

function showPaintPreview(rid: string, diff: Array<{ prop: string; from: string; to: string }>) {
  const bannerText = document.getElementById('crev-paint-text');
  if (!bannerText) return;

  if (diff.length === 0) {
    render(bannerText, 'No style differences \u2014 already identical');
    setTimeout(() => updatePaintBanner(), 2000);
    return;
  }

  render(bannerText,
    h('div', { style: 'margin-bottom:3px' }, 'Style changes:'),
    ...diff.map(d =>
      h('div', { style: 'font-size:10px;font-family:monospace;margin:1px 0' },
        h('b', null, d.prop), ': ', d.from, ' \u2192 ', d.to),
    ),
    h('div', { style: 'margin-top:4px' },
      h('button', {
        class: 'crev-paint-apply-btn',
        onClick: () => {
          sendToSW({ type: 'PAINT_CONFIRM', rid } as InspectorMessage);
          render(bannerText, 'Applying\u2026');
        },
      }, 'Apply'),
      h('button', {
        class: 'crev-paint-cancel-btn',
        onClick: () => updatePaintBanner(),
      }, 'Cancel'),
    ),
  );
}

// ── Tooltip system ──────────────────────────────────────────────

function showTooltipForElement(el: HTMLElement, rid: string) {
  if (tooltipHideTimer) {
    clearTimeout(tooltipHideTimer);
    tooltipHideTimer = null;
  }

  const tooltip = document.getElementById('crev-tooltip');
  if (!tooltip) return;

  const enrichment = enrichments.get(rid);
  const color = getTypeColor(enrichment?.type);
  const typeAbbr = getTypeAbbr(enrichment?.type);
  const typeName = enrichment?.type ?? (requestedRids.has(rid) ? 'Loading\u2026' : 'Unknown');

  render(tooltip,
    h('div', { class: 'crev-tt-type', style: `background:${color}` }, typeAbbr),
    ' ',
    h('span', { style: 'color:#8d8d8d;font-size:10px' }, typeName),
    enrichment?.name && h('div', { class: 'crev-tt-name' }, enrichment.name),
    enrichment?.businessId && h('div', { class: 'crev-tt-row' }, `ID: ${enrichment.businessId}`),
    h('div', { class: 'crev-tt-row' }, `RID: ${rid}`),
  );
  tooltip.style.top = '-9999px';
  tooltip.style.left = '-9999px';
  tooltip.style.display = 'block';

  const rect = el.getBoundingClientRect();
  const ttRect = tooltip.getBoundingClientRect();
  let top = rect.bottom + 4;
  let left = rect.left;

  if (top + ttRect.height > window.innerHeight) {
    top = rect.top - ttRect.height - 4;
  }
  if (top < 4) top = 4;
  if (left + ttRect.width > window.innerWidth) {
    left = window.innerWidth - ttRect.width - 4;
  }
  if (left < 0) left = 4;

  tooltip.style.top = `${top}px`;
  tooltip.style.left = `${left}px`;
}

function hideTooltip() {
  if (tooltipHideTimer) clearTimeout(tooltipHideTimer);
  tooltipHideTimer = setTimeout(() => {
    const tooltip = document.getElementById('crev-tooltip');
    if (tooltip) tooltip.style.display = 'none';
    tooltipHideTimer = null;
  }, 50);
}

// ── Cross-tab sync ──────────────────────────────────────────────

onSync('crev_sync_inspect', (data) => {
  const d = data as { active: boolean };
  if (d.active !== inspectActive) {
    fromSync = true;
    try { setInspectMode(d.active); } finally { fromSync = false; }
  }
});

onSync('crev_sync_paint', (data) => {
  const d = data as { phase: PaintPhase; sourceName?: string };
  fromSync = true;
  try {
    paintPhase = d.phase;
    paintSourceName = d.sourceName ?? null;
    updatePaintCursors();
  } finally { fromSync = false; }
});

onSync('crev_sync_overlay', (data) => {
  const d = data as { active: boolean };
  if (d.active !== technicalOverlay) {
    fromSync = true;
    try {
      technicalOverlay = d.active;
      applyTechnicalOverlay();
    } finally { fromSync = false; }
  }
});

onSync('crev_sync_profile', (data) => {
  const d = data as { label: string; connected?: boolean };
  fromSync = true;
  if (lastDetection?.isBmp) {
    updateEnvTag(d.label, d.connected !== false ? 'connected' : 'disconnected');
  }
  fromSync = false;
});

// ── Context menu RID tracking ────────────────────────────────────

document.body.addEventListener('contextmenu', (e) => {
  const ridEl = (e.target as HTMLElement).closest?.('[data-rid]');
  if (ridEl) {
    const rid = ridEl.getAttribute('data-rid');
    if (rid) {
      const enrichment = enrichments.get(rid);
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

// ── Technical Overlay ───────────────────────────────────────────

const OVERLAY_SKIP_PROPS = new Set(['rid', 'id', 'name', 'type', '__typename', 'typename',
  'source', 'discoveredAt', 'updatedAt', 'treePath', 'webParentRid', 'hasChildren']);
const OVERLAY_CODE_PROPS = new Set(['expression', 'html', 'javascript']);
const OVERLAY_MAX_PROP_LINES = 6;

function applyTechnicalOverlay() {
  if (technicalOverlay) {
    // Request cached properties from service worker for visible RIDs
    const visibleRids: string[] = [];
    for (const label of document.querySelectorAll<HTMLElement>('[data-crev-label]')) {
      const rid = label.getAttribute('data-crev-label');
      if (rid && !overlayProps.has(rid)) visibleRids.push(rid);
    }
    if (visibleRids.length > 0) {
      try {
        chrome.runtime.sendMessage(
          { type: 'GET_OVERLAY_PROPS', rids: visibleRids },
          (response: any) => {
            if (chrome.runtime.lastError) return;
            if (response?.type === 'OVERLAY_PROPS_DATA' && response.props) {
              for (const [rid, props] of Object.entries(response.props)) {
                overlayProps.set(rid, props as Record<string, string>);
              }
              renderOverlayCards();
            }
          },
        );
      } catch (e) { log.swallow('content:getOverlayProps', e); }
    }
  }
  renderOverlayCards();
}

function renderOverlayCards() {
  for (const label of document.querySelectorAll<HTMLElement>('[data-crev-label]')) {
    const rid = label.getAttribute('data-crev-label');
    if (!rid) continue;
    const enrichment = enrichments.get(rid);
    const textSpan = label.querySelector('.crev-label-text');
    if (!textSpan) continue;

    if (technicalOverlay) {
      label.classList.add('crev-label--card');
      const typeName = enrichment?.type ?? 'Unknown';
      const bid = enrichment?.businessId ?? '';
      const name = enrichment?.name ?? 'unnamed';
      const truncatedRid = rid.length > 12 ? rid.slice(0, 6) + '\u2026' + rid.slice(-4) : rid;
      textSpan.innerHTML = '';

      // Identity lines (existing 3 lines)
      const line1 = document.createElement('span');
      line1.className = 'crev-card-line crev-card-type';
      line1.textContent = bid ? `${typeName} | ${bid}` : typeName;
      const line2 = document.createElement('span');
      line2.className = 'crev-card-line';
      line2.textContent = name;
      const line3 = document.createElement('span');
      line3.className = 'crev-card-line crev-card-rid';
      line3.textContent = truncatedRid;
      textSpan.appendChild(line1);
      textSpan.appendChild(line2);
      textSpan.appendChild(line3);

      // Property lines (new — only if cached)
      const props = overlayProps.get(rid);
      if (props) {
        const entries = Object.entries(props).filter(([k]) => !OVERLAY_SKIP_PROPS.has(k));
        if (entries.length > 0) {
          const sep = document.createElement('span');
          sep.className = 'crev-card-sep';
          textSpan.appendChild(sep);

          let count = 0;
          for (const [key, value] of entries) {
            if (count >= OVERLAY_MAX_PROP_LINES) break;
            const line = document.createElement('span');
            line.className = 'crev-card-line crev-card-prop';
            if (OVERLAY_CODE_PROPS.has(key)) {
              const lineCount = value.split('\n').length;
              line.textContent = `${key}: ${lineCount} line${lineCount !== 1 ? 's' : ''}`;
            } else {
              const display = value.length > 30 ? value.slice(0, 27) + '\u2026' : value;
              line.textContent = `${key}: ${display}`;
            }
            textSpan.appendChild(line);
            count++;
          }
        }
      }
    } else {
      label.classList.remove('crev-label--card');
      textSpan.innerHTML = '';
      textSpan.textContent = enrichment?.businessId ?? enrichment?.name ?? getTypeAbbr(enrichment?.type);
    }
  }
}

// ── MutationObserver for SPA re-renders ─────────────────────────

function startObserver() {
  if (observer) return;

  observer = new MutationObserver((mutations) => {
    // Self-filter: skip if ALL mutations are only our own insertions
    const onlySelf = mutations.every(m => {
      if (m.type !== 'childList') return false;
      if (m.removedNodes.length > 0) return false;
      return Array.from(m.addedNodes).every(n =>
        n instanceof HTMLElement && (n.classList.contains('crev-label') || n.id === 'crev-tooltip')
      );
    });
    if (onlySelf) return;

    // Check for URL change (SPA navigation) — re-detect + reset dedup
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      requestedRids.clear();
      discoveredRids.clear();
      if (labelClickTimer) { clearTimeout(labelClickTimer); labelClickTimer = null; labelClickRid = null; }
      runDetection();
    }

    // Overlay sync (150ms debounce, only when inspect active)
    if (inspectActive) {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => syncOverlays(), OVERLAY_SYNC_DEBOUNCE);
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
  window.__crev_observer = observer;
}

// ── BMP Detection ───────────────────────────────────────────────

function runDetection() {
  const result = detectBmpPage();
  lastDetection = result;
  sendToSW({ type: 'DETECTION_RESULT', confidence: result.confidence, signals: result.signals, isBmp: result.isBmp });
  // Request additional signals from MAIN world via CustomEvent
  document.dispatchEvent(new CustomEvent('crev-content', { detail: { type: 'CHECK_BMP_SIGNALS' } }));
}

// ── Messages from MAIN world interceptor (via CustomEvent) ──────

document.addEventListener('crev-interceptor', ((event: CustomEvent) => {
  const msg = event.detail;
  if (msg.type === 'OBJECTS_DISCOVERED') {
    sendToSW(msg);
  }

  if (msg.type === 'BMP_SIGNALS_RESULT') {
    const mainSignals = msg.signals ?? [];
    if (lastDetection && mainSignals.length > 0) {
      const allSignals = [...lastDetection.signals, ...mainSignals];
      const extraWeight = mainSignals.length * 0.15;
      const confidence = Math.min(1, lastDetection.confidence + extraWeight);
      const isBmp = confidence >= 0.5;
      sendToSW({ type: 'DETECTION_RESULT', confidence, signals: allSignals, isBmp });
    }
  }
}) as EventListener);

// ── Page info for side panel ────────────────────────────────────

function handlePageInfoRequest(): { url: string; rid?: string; tabRid?: string; widgets: WidgetInfo[]; detection?: { confidence: number; signals: string[]; isBmp: boolean } } {
  const urlRids = extractUrlRids();
  const det = lastDetection ?? detectBmpPage();
  const widgets = det.isBmp ? scanPageWidgets() : [];

  // Trigger fiber extraction in MAIN world via CustomEvent
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

// ── One-shot message handler for side panel requests ────────────

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

// ── Init — always connect (port is cheap, overlays gated by inspect mode) ──

/** Clean up all DOM artifacts and reset state */
function resetContentState() {
  window.__crev_observer?.disconnect();
  removeOverlays();
  hideQuickInspector();
  destroyEnvTag();
  document.getElementById('crev-inspector-styles')?.remove();
  document.getElementById('crev-tooltip')?.remove();
  document.getElementById('crev-paint-banner')?.remove();
  document.getElementById('crev-toast-container')?.remove();
  styleInjected = false;
}

// Guard against double injection
if (window.__crev_content_loaded) {
  resetContentState();
}
window.__crev_content_loaded = true;

try { connectPort(); } catch (e) { log.swallow('content:init:port', e); }
try { runDetection(); } catch (e) { log.swallow('content:init:detection', e); }
try { startObserver(); } catch (e) { log.swallow('content:init:observer', e); }
