/**
 * Content script overlay rendering — badge creation, label updates, code buttons.
 * All functions receive ContentState explicitly instead of reading module-level vars.
 */

import type { BmpObject, InspectorMessage } from './lib/types';
import { getTypeColor, getTypeAbbr, TYPES_WITH_CODE } from './lib/types';
import { FLOW_TYPES } from './lib/widget-metadata';
import { getAllRidElements } from './lib/dom-scanner';
import { log } from './lib/logger';
import { ICON_CODE } from './lib/icons';
import { DISCOVERED_RIDS_CAP, LABEL_DBLCLICK_WINDOW } from './lib/constants';
import { resolveCopyText, getModifier } from './lib/namespace';
import { sendToSW } from './lib/content-port';
import { sendFireForget, sendRequest } from './lib/messaging';
import { showQuickInspector } from './lib/quick-inspector';
import type { ContentState } from './content-state';

/** Create the action strip below a badge (EC button for code-bearing types). Returns null if no actions. */
function createActionStrip(rid: string, enrichment: { businessId?: string; type?: string; name?: string }): HTMLSpanElement | null {
  if (!enrichment.type || !TYPES_WITH_CODE.has(enrichment.type)) return null;

  const actions = document.createElement('span');
  actions.className = 'crev-actions';

  const ecBtn = document.createElement('button');
  ecBtn.className = 'crev-ec-btn';
  ecBtn.innerHTML = ICON_CODE;
  // No native `title` — it painted a browser tooltip over the hover info card.
  // `aria-label` keeps the action discoverable to screen readers.
  ecBtn.setAttribute('aria-label', 'Open in editor');
  ecBtn.addEventListener('click', (e) => {
    e.preventDefault(); e.stopPropagation();
    sendFireForget({ type: 'OPEN_EDITOR', rid });
  });
  actions.appendChild(ecBtn);

  return actions;
}

/** Create the cascade pill that sits below a flow-bearing badge. Shows the
 *  next link in the chain (InputView → inputSet, ActionButton → actionObject)
 *  as a smaller secondary pill. Clicking it opens THAT object in the sidebar,
 *  so the user can jump straight to the form fields / transports without
 *  drilling through the main pill first. */
function createCascadePill(cascade: { rid: string; businessId?: string; type?: string; name?: string }): HTMLSpanElement {
  const pill = document.createElement('span');
  pill.className = 'crev-label crev-label--cascade';
  pill.setAttribute('data-crev-cascade-rid', cascade.rid);
  const color = getTypeColor(cascade.type);
  pill.style.setProperty('--crev-color', color);

  const text = document.createElement('span');
  text.className = 'crev-label-text';
  text.textContent = cascade.businessId ?? cascade.name ?? getTypeAbbr(cascade.type);
  // No native `title` — the hover info card (content-tooltip) covers this; a
  // browser tooltip would just paint over it.
  pill.appendChild(text);

  text.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    sendToSW({ type: 'SELECT_OBJECT', rid: cascade.rid } as InspectorMessage);
  });

  return pill;
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
    // The click-modifier hints moved into the hover info card (content-tooltip)
    // \u2014 a native `title` here painted a browser tooltip over that very card.
    label.appendChild(labelText);

    // Flow-graph indicator \u2014 for widgets that have a chain to walk
    // (InputView, ActionButton, Label). Pure CSS via class; the ::after pseudo
    // draws the arrow. Tells the user at a glance "this widget has a graph."
    if (enrichment?.type && FLOW_TYPES.has(enrichment.type)) {
      label.classList.add('crev-label--flow');
    }

    // Short, inline targets (breadcrumbs, nav links) are mostly text, so the
    // top-right corner pill lands on top of that text. Tag those to overhang
    // the top edge instead of covering content (see .crev-label--edge). Tall
    // widgets keep the in-corner placement — it sits in their header padding.
    const elHeight = (element as HTMLElement).offsetHeight;
    if (element.tagName === 'A' || (elHeight > 0 && elHeight <= 26)) {
      label.classList.add('crev-label--edge');
    }

    // Pill is the affordance for "open this in the sidebar". Modifiers keep
    // the copy paths (Alt = ID, Shift = template, Ctrl = ref); double-click
    // opens the quick-inspector popup. Paint mode still owns clicks first.
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
        clearTimeout(s.labelClickTimer);
        s.labelClickTimer = null;
        s.labelClickRid = null;
        openQuickInspector(s, label, rid);
        return;
      }

      const me = e as MouseEvent;
      const mod = getModifier(me);

      // No modifier → copy business ID AND open in sidebar. Per user
      // feedback: a plain click is the configurator's "I want this
      // object" gesture, so doing both saves the round-trip to the
      // copy modifier path. Falls back gracefully when the BID isn't
      // enriched yet (still opens the sidebar, just no clipboard write).
      if (mod === 'plain') {
        s.labelClickRid = rid;
        s.labelClickTimer = setTimeout(() => {
          s.labelClickTimer = null;
          s.labelClickRid = null;
          const enriched = s.enrichments.get(rid);
          const bid = enriched?.businessId;
          if (bid) {
            navigator.clipboard.writeText(bid).then(() => {
              const originalText = labelText.textContent;
              labelText.textContent = `✓ ${bid}`;
              label.classList.add('crev-label-flash-ok');
              setTimeout(() => {
                labelText.textContent = originalText;
                label.classList.remove('crev-label-flash-ok');
              }, 600);
            }).catch(e => log.swallow('content:clipboard', e));
          }
          sendToSW({ type: 'SELECT_OBJECT', rid } as InspectorMessage);
        }, LABEL_DBLCLICK_WINDOW);
        return;
      }

      // Modifier-click → copy. Alt = RID, Shift = template, Ctrl = ref.
      // Plain Click (no modifier) opens the sidebar. The modifier set lives
      // in src/lib/namespace.ts (resolveCopyText + getModifier).
      s.labelClickRid = rid;
      s.labelClickTimer = setTimeout(() => {
        s.labelClickTimer = null;
        s.labelClickRid = null;
        const enriched = s.enrichments.get(rid);
        const { text, label: copyLabel } = resolveCopyText({ rid, ...enriched }, mod);
        if (!text) {
          const original = labelText.textContent;
          labelText.textContent = copyLabel;
          label.style.opacity = '0.5';
          setTimeout(() => { labelText.textContent = original; label.style.opacity = ''; }, 800);
          return;
        }
        const flashText = copyLabel === 'ID' ? '\u2713' : `\u2713 ${copyLabel}`;
        const originalText = labelText.textContent;
        navigator.clipboard.writeText(text).then(() => {
          labelText.textContent = flashText;
          label.classList.add('crev-label-flash-ok');
          setTimeout(() => {
            labelText.textContent = originalText;
            label.classList.remove('crev-label-flash-ok');
          }, 600);
        }).catch(e => {
          log.swallow('content:clipboard', e);
          // Visible feedback: flash red with "copy failed" text
          labelText.textContent = 'copy failed';
          label.classList.add('crev-label-flash-error');
          setTimeout(() => {
            labelText.textContent = originalText;
            label.classList.remove('crev-label-flash-error');
          }, 800);
        });
      }, LABEL_DBLCLICK_WINDOW);
    });

    element.appendChild(label);

    // Cascade pill below main pill (flow widgets only — InputView, ActionButton).
    // Shows the next link in the chain. Clicking it opens THAT object in the
    // sidebar, skipping the main-pill drill-through.
    if (enrichment?.cascade) {
      element.appendChild(createCascadePill(enrichment.cascade));
      element.classList.add('crev-has-cascade');
    }

    // Action strip below badge (EC button for code-bearing types)
    if (enrichment) {
      const strip = createActionStrip(rid, enrichment);
      if (strip) element.appendChild(strip);
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
  for (const el of document.querySelectorAll('.crev-has-cascade')) {
    el.classList.remove('crev-has-cascade');
  }
  for (const el of document.querySelectorAll('.crev-outline')) {
    el.classList.remove('crev-outline');
    (el as HTMLElement).style.removeProperty('--crev-color');
  }
  const tooltip = document.getElementById('crev-tooltip');
  if (tooltip) tooltip.style.display = 'none';
  s.hoveredLabelEl = null;
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
      // Flow-graph indicator (see syncOverlays — retroactive enrichment path).
      if (enrichment.type && FLOW_TYPES.has(enrichment.type)) {
        label.classList.add('crev-label--flow');
      }
      const parent = label.parentElement;
      if (parent) {
        const color = getTypeColor(enrichment.type);
        parent.style.setProperty('--crev-color', color);
      }
      // Add cascade pill if enrichment arrived with one and we haven't rendered
      // it yet (retroactive path mirroring syncOverlays).
      if (parent && enrichment.cascade && !parent.querySelector('.crev-label--cascade')) {
        parent.appendChild(createCascadePill(enrichment.cascade));
        parent.classList.add('crev-has-cascade');
      }
      // Add action strip if not already present (enrichment arrived after initial badge render)
      if (parent && !parent.querySelector('.crev-actions')) {
        const strip = createActionStrip(rid, enrichment);
        if (strip) parent.appendChild(strip);
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
      sendFireForget({ type: 'OPEN_EDITOR', rid: editorRid });
    }, (favRid) => {
      sendFireForget({ type: 'TOGGLE_FAVORITE', rid: favRid, name: enrichment?.name, objectType: enrichment?.type, businessId: enrichment?.businessId });
      if (s.favoriteRids.has(favRid)) s.favoriteRids.delete(favRid);
      else s.favoriteRids.add(favRid);
    }, (viewRid) => {
      sendFireForget({ type: 'OPEN_OBJECT_VIEW', rid: viewRid });
    });
  };

  sendRequest({ type: 'GET_FAVORITES' }).then(response => {
    if (response && 'entries' in response && Array.isArray(response.entries)) {
      // GET_FAVORITES always returns FavoriteEntry[] in practice, but
      // the `entries` field on the response is typed as the union of
      // every entry shape (ActivityEntry has no `rid`). Filter
      // defensively rather than asserting.
      s.favoriteRids = new Set(
        response.entries.flatMap(e => ('rid' in e && typeof e.rid === 'string' ? [e.rid] : [])),
      );
    }
    favDone = true;
    tryShow();
  });

  sendRequest({ type: 'HOVER_LOOKUP', rid }).then(response => {
    if (response && 'codePreview' in response && typeof response.codePreview === 'string') {
      codePreview = response.codePreview.split('\n').slice(0, 2).join('\n');
    }
    hoverDone = true;
    tryShow();
  });
}
