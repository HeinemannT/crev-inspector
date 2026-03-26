/**
 * Content script overlay rendering — badge creation, label updates, code buttons.
 * All functions receive ContentState explicitly instead of reading module-level vars.
 */

import type { BmpObject, InspectorMessage, PaintPhase } from './lib/types';
import { getTypeColor, getTypeAbbr, TYPES_WITH_CODE } from './lib/types';
import { getAllRidElements } from './lib/dom-scanner';
import { log } from './lib/logger';
import { ICON_CODE, ICON_SEARCH } from './lib/icons';
import { DISCOVERED_RIDS_CAP, LABEL_DBLCLICK_WINDOW } from './lib/constants';
import { resolveCopyText, getModifier } from './lib/namespace';
import { sendToSW } from './lib/content-port';
import { showQuickInspector, hideQuickInspector } from './lib/quick-inspector';
import type { ContentState } from './content-state';

/** Create the action strip below a badge (EC button + search references) */
function createActionStrip(rid: string, enrichment: { businessId?: string; type?: string; name?: string }): HTMLSpanElement {
  const actions = document.createElement('span');
  actions.className = 'crev-actions';

  if (enrichment.type && TYPES_WITH_CODE.has(enrichment.type)) {
    const ecBtn = document.createElement('button');
    ecBtn.className = 'crev-ec-btn';
    ecBtn.innerHTML = ICON_CODE;
    ecBtn.title = 'Open in editor';
    ecBtn.setAttribute('aria-label', 'Open in editor');
    ecBtn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      chrome.runtime.sendMessage({ type: 'OPEN_EDITOR', rid });
    });
    actions.appendChild(ecBtn);
  }

  const searchBtn = document.createElement('button');
  searchBtn.className = 'crev-action-btn';
  searchBtn.innerHTML = ICON_SEARCH;
  searchBtn.title = 'Find references';
  searchBtn.setAttribute('aria-label', 'Find references');
  searchBtn.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    chrome.runtime.sendMessage({
      type: 'SEARCH_REFERENCES', rid,
      businessId: enrichment.businessId, objectType: enrichment.type, name: enrichment.name,
    });
  });
  actions.appendChild(searchBtn);

  return actions;
}

/** Incremental overlay sync: clean stale, add new badges, request enrichment. */
export function syncOverlays(s: ContentState) {
  // 1. Clean stale labels (detached parents or elements no longer in DOM)
  for (const label of document.querySelectorAll('.crev-label')) {
    if (!label.parentElement || !document.body.contains(label.parentElement)) {
      label.remove();
    }
  }

  const includeLinks = s.enrichMode === 'all';
  const elements = getAllRidElements(includeLinks);
  const linkCount = includeLinks ? elements.filter(({ element }) => element.tagName === 'A').length : 0;
  log.debug('sync', `syncOverlays: ${elements.length} elements (${linkCount} links), enrichMode=${s.enrichMode}`);
  const ridsToEnrich: string[] = [];

  // Filter to new elements only
  const newElements = elements.filter(({ element }) => !s.badgedElements.has(element));

  // Write pass: apply DOM changes
  for (const { element, rid } of newElements) {
    const enrichment = s.enrichments.get(rid);
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

      if (s.paintPhase === 'picking') {
        sendToSW({ type: 'PAINT_PICK', rid });
        label.classList.add('crev-label-flash-pick');
        setTimeout(() => { label.classList.remove('crev-label-flash-pick'); }, 400);
        return;
      }

      if (s.paintPhase === 'applying') {
        sendToSW({ type: 'PAINT_APPLY', rid });
        return;
      }

      // Double-click detection: 250ms window
      if (s.labelClickRid === rid && s.labelClickTimer) {
        // Second click → cancel copy, open quick inspector
        clearTimeout(s.labelClickTimer);
        s.labelClickTimer = null;
        s.labelClickRid = null;
        openQuickInspector(s, label, rid);
        return;
      }

      // First click → set timer for single-click (modifier determines what to copy)
      const mod = getModifier(e as MouseEvent);
      s.labelClickRid = rid;
      s.labelClickTimer = setTimeout(() => {
        s.labelClickTimer = null;
        s.labelClickRid = null;
        const enriched = s.enrichments.get(rid);
        const { text, label: copyLabel } = resolveCopyText({ rid, ...enriched }, mod);
        const flashText = copyLabel === 'ID' ? '\u2713' : `\u2713 ${copyLabel}`;
        navigator.clipboard.writeText(text).then(() => {
          const original = labelText.textContent;
          labelText.textContent = flashText;
          label.classList.add('crev-label-flash-ok');
          setTimeout(() => {
            labelText.textContent = original;
            label.classList.remove('crev-label-flash-ok');
          }, 600);
        }).catch(e => log.swallow('content:clipboard', e));
      }, LABEL_DBLCLICK_WINDOW);
    });

    element.appendChild(label);

    // Action strip below badge (EC button + search references)
    if (enrichment) {
      element.appendChild(createActionStrip(rid, enrichment));
    }
    s.badgedElements.add(element);

    // Track RIDs that need enrichment (with dedup)
    if (!s.enrichments.has(rid) && !s.requestedRids.has(rid)) {
      ridsToEnrich.push(rid);
      s.requestedRids.add(rid);
    }
  }

  // Also check already-badged elements whose enrichment was never completed
  for (const { rid } of elements) {
    if (!s.enrichments.has(rid) && !s.requestedRids.has(rid)) {
      ridsToEnrich.push(rid);
      s.requestedRids.add(rid);
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
    if (!s.discoveredRids.has(rid) && s.discoveredRids.size < DISCOVERED_RIDS_CAP) {
      s.discoveredRids.add(rid);
      newDiscovered.push({ rid, source: 'dom' as const, discoveredAt: now, updatedAt: now });
    }
  }
  if (newDiscovered.length > 0) {
    sendToSW({ type: 'OBJECTS_DISCOVERED', objects: newDiscovered });
  }
}

/** Remove all overlays and reset badge tracking */
export function removeOverlays(s: ContentState) {
  for (const label of document.querySelectorAll('.crev-label')) {
    label.remove();
  }
  for (const strip of document.querySelectorAll('.crev-actions')) {
    strip.remove();
  }
  for (const el of document.querySelectorAll('.crev-outline')) {
    el.classList.remove('crev-outline');
    (el as HTMLElement).style.removeProperty('--crev-color');
  }
  const tooltip = document.getElementById('crev-tooltip');
  if (tooltip) tooltip.style.display = 'none';
  s.hoveredOutlineEl = null;
  s.badgedElements = new WeakSet();
  s.overlayProps.clear();
}

/** Update badge labels from enrichment data */
export function updateLabels(s: ContentState) {
  for (const label of document.querySelectorAll<HTMLElement>('[data-crev-label]')) {
    const rid = label.getAttribute('data-crev-label');
    if (!rid) continue;
    const enrichment = s.enrichments.get(rid);
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
      // Add action strip if not already present (enrichment arrived after initial badge render)
      if (parent && !parent.querySelector('.crev-actions')) {
        parent.appendChild(createActionStrip(rid, enrichment));
      }
    }
  }
}

/** Open quick inspector popup for a badge */
function openQuickInspector(s: ContentState, labelEl: HTMLElement, rid: string) {
  const enrichment = s.enrichments.get(rid);
  // Fire both requests in parallel — favorites + code preview from cache
  let favDone = false, hoverDone = false;
  let codePreview: string | undefined;

  const tryShow = () => {
    if (!favDone || !hoverDone) return;
    showQuickInspector(labelEl, {
      rid,
      businessId: enrichment?.businessId,
      templateBusinessId: enrichment?.templateBusinessId,
      type: enrichment?.type,
      name: enrichment?.name,
      isFavorite: s.favoriteRids.has(rid),
      codePreview,
    }, (editorRid) => {
      chrome.runtime.sendMessage({ type: 'OPEN_EDITOR', rid: editorRid });
    }, (favRid) => {
      chrome.runtime.sendMessage({ type: 'TOGGLE_FAVORITE', rid: favRid, name: enrichment?.name, objectType: enrichment?.type, businessId: enrichment?.businessId });
      if (s.favoriteRids.has(favRid)) s.favoriteRids.delete(favRid);
      else s.favoriteRids.add(favRid);
    }, (viewRid) => {
      chrome.runtime.sendMessage({ type: 'OPEN_OBJECT_VIEW', rid: viewRid });
    });
  };

  chrome.runtime.sendMessage({ type: 'GET_FAVORITES' }, (response: any) => {
    if (response?.entries) {
      s.favoriteRids = new Set(response.entries.map((e: any) => e.rid));
    }
    favDone = true;
    tryShow();
  });

  chrome.runtime.sendMessage({ type: 'HOVER_LOOKUP', rid }, (response: any) => {
    if (response?.codePreview) {
      codePreview = response.codePreview.split('\n').slice(0, 2).join('\n');
    }
    hoverDone = true;
    tryShow();
  });
}
