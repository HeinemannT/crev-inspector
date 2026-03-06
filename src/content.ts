/**
 * ISOLATED world content script.
 * Renders outlined elements with corner labels and a hover tooltip on [data-rid] elements.
 * Bridges messages between MAIN world interceptor and service worker.
 */

import type { BmpObject, InspectorMessage, InterceptorWindowMessage, WidgetInfo, PaintPhase, EnrichMode } from './lib/types';
import { getTypeColor, getTypeAbbr, TYPES_WITH_CODE } from './lib/types';
import { getAllRidElements, extractUrlRids, scanPageWidgets, detectBmpPage, type DetectionResult } from './lib/dom-scanner';
import { h, render } from './lib/dom';
import { log } from './lib/logger';
import { RECONNECT_INITIAL_DELAY, RECONNECT_MAX_DELAY, OVERLAY_SYNC_DEBOUNCE, DETECTION_DEBOUNCE } from './lib/constants';
import OVERLAY_CSS from './content-overlay.css';

declare global {
  interface Window {
    __crev_content_loaded?: boolean;
    __crev_observer?: MutationObserver;
  }
}

// ── State ───────────────────────────────────────────────────────

let inspectActive = false;
let enrichMode: EnrichMode = 'widgets';
let paintPhase: PaintPhase = 'off';
let paintSourceName: string | null = null;
let port: chrome.runtime.Port | null = null;
let observer: MutationObserver | null = null;
let styleInjected = false;

// Enrichment data from server (RID → business ID / type / name)
const enrichments = new Map<string, { businessId?: string; type?: string; name?: string }>();

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
let detectionDebounceTimer: ReturnType<typeof setTimeout> | null = null;

// Port reconnection backoff
let reconnectDelay = RECONNECT_INITIAL_DELAY;

// Pending messages queued while port is disconnected
const pendingMessages: InspectorMessage[] = [];

// Tooltip hide timer
let tooltipHideTimer: ReturnType<typeof setTimeout> | null = null;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let hoveredOutlineEl: Element | null = null;

// ── Service worker connection ───────────────────────────────────

function connectPort() {
  try {
    port = chrome.runtime.connect({ name: 'content' });
    reconnectDelay = RECONNECT_INITIAL_DELAY;
  } catch (e) {
    log.swallow('content:connectPort', e);
    return;
  }

  flushPendingMessages();
  // Re-send last detection on reconnect so SW has current state
  if (lastDetection && pendingMessages.length === 0) {
    const det = lastDetection;
    queueMicrotask(() => {
      sendToSW({ type: 'DETECTION_RESULT', confidence: det.confidence,
                 signals: det.signals, isBmp: det.isBmp });
    });
  }

  port.onMessage.addListener((msg: InspectorMessage) => {
    switch (msg.type) {
      case 'INSPECT_STATE':
        setInspectMode(msg.active);
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
    }
  });

  port.onDisconnect.addListener(() => {
    port = null;
    requestedRids.clear();
    // Only retry if extension context is still valid
    try {
      chrome.runtime.getURL('');
      setTimeout(() => {
        connectPort();
        for (const label of document.querySelectorAll<HTMLElement>('.crev-label')) {
          label.style.opacity = '0.4';
          setTimeout(() => { label.style.opacity = ''; }, 800);
        }
        if (inspectActive) syncOverlays();
      }, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_DELAY);
    } catch (e) {
      log.swallow('content:reconnectCheck', e);
    }
  });
}

function sendToSW(msg: InspectorMessage) {
  if (port) {
    try { port.postMessage(msg); return; }
    catch (e) { log.swallow('content:sendToSW', e); port = null; }
  }
  // One-shot fallback for detection (works without port)
  if (msg.type === 'DETECTION_RESULT') {
    try { chrome.runtime.sendMessage(msg).catch(e => log.swallow('content:oneShot', e)); } catch (e) { log.swallow('content:oneShotOuter', e); }
  }
  // Queue critical messages for port-based delivery on reconnect
  if (msg.type === 'DETECTION_RESULT' || msg.type === 'OBJECTS_DISCOVERED') {
    // Keep only latest detection (replace older)
    if (msg.type === 'DETECTION_RESULT') {
      const idx = pendingMessages.findIndex(m => m.type === 'DETECTION_RESULT');
      if (idx >= 0) pendingMessages.splice(idx, 1);
    }
    pendingMessages.push(msg);
    // Cap queue to prevent unbounded growth
    while (pendingMessages.length > 20) pendingMessages.shift();
  }
}

function flushPendingMessages() {
  while (pendingMessages.length > 0) {
    const msg = pendingMessages.shift();
    try { port?.postMessage(msg); } catch (e) { log.swallow('content:flushPending', e); break; }
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
      if (rid) showTooltip(outline as HTMLElement, rid);
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

  const elements = getAllRidElements(enrichMode === 'all');
  const ridsToEnrich: string[] = [];

  // Filter to new elements only
  const newElements = elements.filter(({ element }) => !badgedElements.has(element));

  // Pre-pass: read computed positions (batch read avoids layout thrashing)
  const needsReposition = new Set<Element>();
  for (const { element } of newElements) {
    if (window.getComputedStyle(element).position === 'static') {
      needsReposition.add(element);
    }
  }

  // Write pass: apply DOM changes
  for (const { element, rid } of newElements) {
    const enrichment = enrichments.get(rid);
    const color = getTypeColor(enrichment?.type);

    element.classList.add('crev-outline');
    (element as HTMLElement).style.setProperty('--crev-color', color);

    if (needsReposition.has(element)) {
      (element as HTMLElement).style.position = 'relative';
      element.setAttribute('data-crev-repositioned', 'true');
    }

    // Create corner label (flex container: text + optional code button)
    const label = document.createElement('span');
    label.className = 'crev-label';
    if (!enrichment) label.classList.add('crev-label-loading');
    label.setAttribute('data-crev-label', rid);

    const labelText = document.createElement('span');
    labelText.className = 'crev-label-text';
    labelText.textContent = enrichment?.businessId ?? enrichment?.name ?? getTypeAbbr(enrichment?.type);
    label.appendChild(labelText);

    // Click text → paint pick/apply if in paint mode, otherwise copy
    labelText.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();

      if (paintPhase === 'picking') {
        sendToSW({ type: 'PAINT_PICK', rid });
        // Flash orange to confirm pick
        label.classList.add('crev-label-flash-pick');
        setTimeout(() => { label.classList.remove('crev-label-flash-pick'); }, 400);
        return;
      }

      if (paintPhase === 'applying') {
        sendToSW({ type: 'PAINT_APPLY', rid });
        // Visual feedback handled by PAINT_APPLY_RESULT
        return;
      }

      // Default: copy business ID (or RID if no ID)
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

  // Request enrichment for unknown RIDs
  if (ridsToEnrich.length > 0) {
    sendToSW({ type: 'ENRICH_BADGES', rids: ridsToEnrich });
  }

  // Also discover objects for the cache (dedup: only send new RIDs)
  const now = Date.now();
  const newDiscovered: BmpObject[] = [];
  for (const { rid } of elements) {
    if (!discoveredRids.has(rid)) {
      discoveredRids.add(rid);
      newDiscovered.push({ rid, source: 'dom' as const, discoveredAt: now, updatedAt: now });
    }
  }
  if (newDiscovered.length > 0) {
    sendToSW({ type: 'OBJECTS_DISCOVERED', objects: newDiscovered });
  }
}

function removeOverlays() {
  // Remove all labels
  for (const label of document.querySelectorAll('.crev-label')) {
    label.remove();
  }
  // Remove outline class and CSS var from all elements
  for (const el of document.querySelectorAll('.crev-outline')) {
    el.classList.remove('crev-outline');
    (el as HTMLElement).style.removeProperty('--crev-color');
  }
  // Restore repositioned elements
  for (const el of document.querySelectorAll('[data-crev-repositioned]')) {
    (el as HTMLElement).style.position = '';
    el.removeAttribute('data-crev-repositioned');
  }
  // Hide tooltip
  const tooltip = document.getElementById('crev-tooltip');
  if (tooltip) tooltip.style.display = 'none';
  hoveredOutlineEl = null;
  // Reset WeakSet so overlays can be recreated on next toggle-on
  badgedElements = new WeakSet();
}

function updateLabels() {
  for (const label of document.querySelectorAll<HTMLElement>('[data-crev-label]')) {
    const rid = label.getAttribute('data-crev-label');
    if (!rid) continue;
    const enrichment = enrichments.get(rid);
    if (enrichment) {
      // Update text span
      const textSpan = label.querySelector('.crev-label-text');
      if (textSpan) {
        textSpan.textContent = enrichment.businessId ?? enrichment.name ?? getTypeAbbr(enrichment.type);
      }
      label.classList.remove('crev-label-loading');
      // Update outline color on parent
      const parent = label.parentElement;
      if (parent) {
        const color = getTypeColor(enrichment.type);
        parent.style.setProperty('--crev-color', color);
      }
      // Add code button if type has code and button doesn't exist yet
      if (enrichment.type && TYPES_WITH_CODE.has(enrichment.type) && !label.querySelector('.crev-ec-btn')) {
        label.appendChild(createCodeButton(rid, enrichment.type));
      }
    }
  }
}

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
  // Flash the label
  const label = document.querySelector<HTMLElement>(`[data-crev-label="${rid}"]`);
  if (label) {
    const flashClass = ok ? 'crev-label-flash-ok' : 'crev-label-flash-error';
    label.classList.add(flashClass);
    setTimeout(() => { label.classList.remove(flashClass); }, 600);
  }

  // Update the banner with feedback
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

function showTooltip(el: HTMLElement, rid: string) {
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
  // Position offscreen first, then measure both rects in a single layout pass
  tooltip.style.top = '-9999px';
  tooltip.style.left = '-9999px';
  tooltip.style.display = 'block';

  const rect = el.getBoundingClientRect();
  const ttRect = tooltip.getBoundingClientRect();
  let top = rect.bottom + 4;
  let left = rect.left;

  // Clamp to viewport
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

    // Check for URL change (SPA navigation)
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      requestedRids.clear();
      discoveredRids.clear();
    }

    // Overlay sync (150ms debounce, only when inspect active)
    if (inspectActive) {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => syncOverlays(), OVERLAY_SYNC_DEBOUNCE);
    }

    // Detection update (2000ms debounce, always)
    if (detectionDebounceTimer) clearTimeout(detectionDebounceTimer);
    detectionDebounceTimer = setTimeout(() => {
      const result = detectBmpPage();
      if (!lastDetection || result.confidence !== lastDetection.confidence || result.isBmp !== lastDetection.isBmp) {
        lastDetection = result;
        sendToSW({ type: 'DETECTION_RESULT', confidence: result.confidence, signals: result.signals, isBmp: result.isBmp });
      }
    }, DETECTION_DEBOUNCE);
  });

  observer.observe(document.body, { childList: true, subtree: true });
  window.__crev_observer = observer;
}

// ── BMP Detection ───────────────────────────────────────────────

function runDetection() {
  const result = detectBmpPage();
  lastDetection = result;
  sendToSW({ type: 'DETECTION_RESULT', confidence: result.confidence, signals: result.signals, isBmp: result.isBmp });
  // Request additional signals from MAIN world
  window.postMessage({ source: 'crev-content', payload: { type: 'CHECK_BMP_SIGNALS' } }, '*');
}

// ── Messages from MAIN world interceptor ────────────────────────

window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  const data = event.data as InterceptorWindowMessage;
  if (data?.source !== 'crev-interceptor') return;

  const msg = data.payload;
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
});

// ── Page info for side panel ────────────────────────────────────

function handlePageInfoRequest(): { url: string; rid?: string; tabRid?: string; widgets: WidgetInfo[]; detection?: { confidence: number; signals: string[]; isBmp: boolean } } {
  const urlRids = extractUrlRids();
  const det = lastDetection ?? detectBmpPage();
  const widgets = det.isBmp ? scanPageWidgets() : [];

  // Trigger fiber extraction in MAIN world
  if (det.isBmp) {
    window.postMessage({ source: 'crev-content', payload: { type: 'EXTRACT_FIBERS' } }, '*');
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

/** Clean up all DOM artifacts and reset state — used on double-injection and could be
 *  called for teardown. Calls removeOverlays() for the shared cleanup, then removes
 *  singleton elements (tooltip, banner, style) that removeOverlays() doesn't touch. */
function resetContentState() {
  window.__crev_observer?.disconnect();
  removeOverlays();
  document.getElementById('crev-inspector-styles')?.remove();
  document.getElementById('crev-tooltip')?.remove();
  document.getElementById('crev-paint-banner')?.remove();
  styleInjected = false;
}

// Guard against double injection (programmatic re-injection on existing tabs after
// extension reload). Clean up stale DOM artifacts from the previous instance.
// The old instance's port is dead and its MutationObserver is harmless (can't reach SW).
if (window.__crev_content_loaded) {
  resetContentState();
}
window.__crev_content_loaded = true;

try { connectPort(); } catch (e) { log.swallow('content:init:port', e); }
try { runDetection(); } catch (e) { log.swallow('content:init:detection', e); }
try { startObserver(); } catch (e) { log.swallow('content:init:observer', e); }
