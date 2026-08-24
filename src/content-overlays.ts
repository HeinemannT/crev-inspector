/**
 * Content script overlay rendering — badge creation, label updates, code buttons.
 * All functions receive ContentState explicitly instead of reading module-level vars.
 */

import type { BmpObject, InspectorMessage } from './lib/types';
import { getTypeColor, getTypeAbbr } from './lib/types';
import { typeAffordances } from './lib/widget-metadata';
import { hasStudio, modeForType } from './studio/studio-mode';
import { typeIcon } from './lib/type-badge';
import { isHistoricalPropertyConfigClass, isPropertyConfigClass } from './lib/property-config';
import { getAllRidElements } from './lib/dom-scanner';
import { log } from './lib/logger';
import { ICON_CODE, ICON_CHECK, ICON_ARROW_FAT_LINE, ICON_VARIABLE, ICON_PROP_HISTORY } from './lib/icons';
import { svg } from './lib/dom';
import { DISCOVERED_RIDS_CAP } from './lib/constants';
import { resolveCopyText, getModifier } from './lib/namespace';
import { sendToSW } from './lib/content-port';
import { sendFireForget } from './lib/messaging';
import { resolveDisplayIdentity } from './lib/object-identity';
import type { CascadeTarget, ContentState } from './content-state';
import {
  resolvedOverlayType,
  type OverlayPresentation,
} from './lib/overlay-presentation';

export interface AdditionalOverlayTarget extends OverlayPresentation {
  element: Element;
  rid: string;
  propertyTarget?: CascadeTarget;
}

const labelPropertyTargets = new WeakMap<HTMLElement, CascadeTarget>();

function overlayVisualType(label: Element, objectType?: string): string | undefined {
  return label instanceof HTMLElement && label.dataset.crevVisualType
    ? label.dataset.crevVisualType
    : objectType;
}

/** Is there room above `el` for an upward-overhanging edge pill (~11px), or
 *  would it be clipped? Clipping happens when the host sits flush against the
 *  top of a scroll/overflow-clipping ancestor (tab strips, header, breadcrumb
 *  bar) or the viewport. Walks ancestors checking for a clip boundary within
 *  the needed gap; returns false if any is too close. */
function hasRoomAbove(el: Element, needed = 11): boolean {
  const top = el.getBoundingClientRect().top;
  if (top < needed) return false; // viewport top
  for (let a = el.parentElement; a && a !== document.documentElement; a = a.parentElement) {
    // A vertical clip boundary slices the upward overhang. Check overflowY
    // (resolves the `overflow` shorthand). Note CSS couples the axes:
    // overflow-x:hidden/auto + overflow-y:visible computes overflow-y to
    // `auto` — but such an element IS then a scroll container that clips
    // vertically too, so counting it is correct. The `needed`-px distance
    // check keeps elements far from any boundary on the overhang variant.
    const oy = getComputedStyle(a).overflowY;
    if ((oy === 'hidden' || oy === 'clip' || oy === 'auto' || oy === 'scroll')
        && top - a.getBoundingClientRect().top < needed) return false;
  }
  return true;
}

/** The cascade jump chip — lives in the label's meta row. Shows the next link
 *  in the chain (InputView → inputSet, ActionButton → actionObject); clicking
 *  it opens THAT object in the sidebar, skipping the main-stub drill-through. */
function createCascadeChip(cascade: { rid: string; businessId?: string; type?: string; name?: string }): HTMLSpanElement {
  const chip = document.createElement('span');
  chip.className = 'crev-cascade';
  chip.setAttribute('data-crev-cascade-rid', cascade.rid);
  chip.style.background = getTypeColor(cascade.type);
  chip.textContent = cascade.businessId ?? cascade.name ?? getTypeAbbr(cascade.type);
  // The chip carries no `data-crev-label`, so the hover info card never fires
  // for it — a native `title` is safe here and is the only thing explaining
  // that this small secondary chip is a clickable link.
  const cascadeId = cascade.name ?? cascade.businessId ?? cascade.type ?? 'object';
  chip.title = `Linked ${cascade.type ?? 'object'}: ${cascadeId} (click to open)`;
  chip.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    sendToSW({ type: 'SELECT_OBJECT', rid: cascade.rid } as InspectorMessage);
  });
  return chip;
}

/**
 * Fill an inspect corner label with the approved "stub + squares" layout:
 *
 *   .crev-stub  — full-bleed type stub: colour tile (role glyph) welded to a
 *                 light identity chip (businessId / name)
 *   .crev-meta  — a row of squares UNDERNEATH, right-aligned: violet `</>`
 *                 (opens the editor / CVO studio — folds the old dark action
 *                 strip into the design), teal link (references indicator),
 *                 and the cascade jump chip when the widget has a chain.
 *
 * Idempotent: the create path and the late-enrichment path in updateLabels()
 * share this ONE implementation. The text element persists across re-renders
 * so the click handler bound in syncOverlays survives. Square presence comes
 * from the single `typeAffordances` seam, not ad-hoc type checks.
 */
function renderLabelContent(
  label: HTMLElement,
  rid: string,
  enrichment?: { type?: string; businessId?: string; templateBusinessId?: string; name?: string; cascade?: { rid: string; businessId?: string; type?: string; name?: string } },
): void {
  const type = enrichment?.type;
  const visualType = overlayVisualType(label, type);

  let stub = label.querySelector<HTMLElement>('.crev-stub');
  if (!stub) {
    stub = document.createElement('span');
    stub.className = 'crev-stub';
    const existingText = label.querySelector<HTMLElement>('.crev-label-text');
    label.prepend(stub);
    if (existingText) stub.appendChild(existingText);
  }
  const propertyType = isPropertyConfigClass(type ?? '');
  const historicalProperty = isHistoricalPropertyConfigClass(type ?? '');
  stub.classList.toggle('crev-stub--property', propertyType);
  stub.classList.toggle('crev-stub--historical', historicalProperty);

  let tile = stub.querySelector<HTMLElement>('.crev-tile');
  if (!tile) {
    tile = document.createElement('span');
    tile.className = 'crev-tile';
    stub.prepend(tile);
  }
  tile.replaceChildren(svg(typeIcon(visualType)));
  if (historicalProperty) {
    const history = document.createElement('span');
    history.className = 'crev-history-indicator';
    history.setAttribute('aria-label', 'Historical property');
    history.appendChild(svg(ICON_PROP_HISTORY));
    tile.appendChild(history);
  }

  const text = stub.querySelector<HTMLElement>('.crev-label-text');
  const display = resolveDisplayIdentity({ rid, ...enrichment });
  if (text) text.textContent = display.primary || enrichment?.name || getTypeAbbr(visualType);

  // Meta row — rebuilt every call so late enrichment can only ever add the
  // correct squares (never stale ones from a previous unknown-type render).
  label.querySelector('.crev-meta')?.remove();
  const aff = typeAffordances(type);
  const cascade = enrichment?.cascade;
  const property = labelPropertyTargets.get(label);
  if (!aff.code && !aff.flow && !cascade && !property) return;

  const meta = document.createElement('span');
  meta.className = 'crev-meta';

  if (aff.flow) {
    // Teal fat-arrow square: "this widget has a chain to walk" (replaces the
    // ⇢ that was welded onto the stub). Clicking selects the object like the
    // main pill AND surfaces the side panel when it's closed — the chain
    // lives in the panel's Flow segment, so the arrow must take you there.
    const sub = document.createElement('button');
    sub.className = 'crev-sub crev-sub--flow';
    sub.setAttribute('aria-label', 'Open the flow chain in the side panel');
    sub.appendChild(svg(ICON_ARROW_FAT_LINE));
    sub.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      sendFireForget({ type: 'SELECT_OBJECT', rid, openPanel: true });
    });
    meta.appendChild(sub);
  }

  if (aff.code) {
    // The violet code square IS the open-in-editor affordance. No native
    // `title` — it would paint a browser tooltip over the hover info card;
    // `aria-label` keeps it discoverable to screen readers.
    // (No reference square: it carried no action, and the flow ⇢ + the panel
    // sections already say "this links elsewhere" — user cut it as noise.)
    const studio = hasStudio(type);
    const btn = document.createElement('button');
    btn.className = 'crev-sub crev-sub--code';
    btn.setAttribute('aria-label', studio ? `Open in the ${modeForType(type).title}` : 'Open in the editor');
    btn.appendChild(svg(ICON_CODE));
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      sendFireForget(studio ? { type: 'OPEN_STUDIO', rid } : { type: 'OPEN_EDITOR', rid });
    });
    meta.appendChild(btn);
  }
  if (property) {
    const btn = document.createElement('button');
    btn.className = 'crev-sub crev-sub--property';
    btn.setAttribute('aria-label', `Open property ${property.businessId ?? property.name ?? ''}`.trim());
    btn.title = `Property: ${property.businessId ?? property.name ?? property.rid}`;
    btn.style.setProperty('--crev-property-color', getTypeColor(property.type));
    btn.appendChild(svg(property.type ? typeIcon(property.type) : ICON_VARIABLE));
    btn.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      sendFireForget({ type: 'SELECT_OBJECT', rid: property.rid, openPanel: true });
    });
    meta.appendChild(btn);
  }
  if (cascade) meta.appendChild(createCascadeChip(cascade));

  label.appendChild(meta);
}

/** Tiny hosts (tab links, breadcrumb chips) can't fit the full stub — it
 *  overlaps neighbours or clips against the host's overflow. Degrade to the
 *  tile-only compact form when the stub outgrows its host. */
function applyCompactMode(label: HTMLElement, host: HTMLElement): void {
  if (label.dataset.crevCompact === 'true') {
    label.classList.add('crev-label--compact');
    return;
  }
  label.classList.remove('crev-label--compact');
  const hostW = host.clientWidth;
  if (hostW > 0 && label.offsetWidth > hostW - 4) {
    label.classList.add('crev-label--compact');
  }
}

/**
 * Build one interactive identity label. Widget overlays and the synthetic page
 * header identity share this exact renderer and gesture contract; placement is
 * deliberately left to the caller.
 */
export function createIdentityLabel(
  s: ContentState,
  rid: string,
  presentation: OverlayPresentation = {},
  propertyTarget?: CascadeTarget,
): HTMLElement {
  const enrichment = s.enrichments.get(rid);
  const label = document.createElement('span');
  label.className = ['crev-label', presentation.labelClassName].filter(Boolean).join(' ');
  if (presentation.visualType) label.dataset.crevVisualType = presentation.visualType;
  if (presentation.compact) {
    label.dataset.crevCompact = 'true';
    label.classList.add('crev-label--compact');
  }
  if (presentation.placement === 'inline-start') label.classList.add('crev-label--inline-start');
  if (!enrichment) label.classList.add('crev-label-loading');
  label.setAttribute('data-crev-label', rid);

  const labelText = document.createElement('span');
  labelText.className = 'crev-label-text';
  // The click-modifier hints live in the hover info card. A native title
  // paints over that card, so the label intentionally has none.
  label.appendChild(labelText);
  if (propertyTarget) labelPropertyTargets.set(label, propertyTarget);

  renderLabelContent(label, rid, enrichment);
  const stubEl = label.querySelector<HTMLElement>('.crev-stub')!;
  stubEl.setAttribute('role', 'button');
  stubEl.tabIndex = 0;
  stubEl.setAttribute('aria-label', 'Inspect this BMP object');

  // The stub is the affordance for "open this in the sidebar". Modifiers keep
  // the secondary copy paths (Shift = instance, Alt = RID, Ctrl = instance ref).
  stubEl.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    const mod = getModifier(e as MouseEvent);

    // Plain click copies the displayed primary identity (template when known)
    // and selects the concrete object. Sparse identities still select immediately.
    if (mod === 'plain') {
      const enriched = s.enrichments.get(rid);
      const { text: copyText } = resolveCopyText({ rid, ...enriched }, mod);
      if (copyText && !label.classList.contains('crev-label-flash-ok')) {
        navigator.clipboard.writeText(copyText).then(() => {
          const originalText = labelText.textContent;
          labelText.textContent = '';
          labelText.append(svg(ICON_CHECK), ` ${copyText}`);
          label.classList.add('crev-label-flash-ok');
          setTimeout(() => {
            labelText.textContent = originalText;
            label.classList.remove('crev-label-flash-ok');
          }, 600);
        }).catch(e => log.swallow('content:clipboard', e));
      }
      sendToSW({ type: 'SELECT_OBJECT', rid } as InspectorMessage);
      return;
    }

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
      labelText.textContent = 'copy failed';
      label.classList.add('crev-label-flash-error');
      setTimeout(() => {
        labelText.textContent = originalText;
        label.classList.remove('crev-label-flash-error');
      }, 800);
    });
  });

  stubEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    stubEl.click();
  });

  // Double-click upgrades the cheap single-click selection to full object view.
  label.addEventListener('dblclick', (e) => {
    if ((e.target as HTMLElement).closest('.crev-meta')) return;
    e.preventDefault();
    e.stopPropagation();
    sendFireForget({ type: 'OPEN_OBJECT_VIEW', rid });
  });

  return label;
}

/** Incremental overlay sync: clean stale, add new badges, request enrichment.
 *  `additionalTargets` supplies identities known through React/configuration
 *  joins even though BMP did not place a RID on the rendered DOM element. */
export function syncOverlays(s: ContentState, additionalTargets: readonly AdditionalOverlayTarget[] = []) {
  const additionalByElement = new Map(additionalTargets.map(target => [target.element, target]));

  // 1. Clean stale labels (detached parents or elements no longer in DOM)
  for (const label of document.querySelectorAll('.crev-label')) {
    if (!label.parentElement || !document.body.contains(label.parentElement)) {
      label.remove();
      continue;
    }
    if (label.classList.contains('crev-edit-field-label')) {
      const target = additionalByElement.get(label.parentElement);
      if (!target || target.rid !== label.getAttribute('data-crev-label')) {
        const parent = label.parentElement;
        label.remove();
        s.badgedElements.delete(parent);
        if (!parent.querySelector('.crev-label')) {
          parent.classList.remove('crev-outline');
          parent.style.removeProperty('--crev-color');
        }
      }
    }
  }

  const includeLinks = s.enrichMode === 'all';
  const elements: AdditionalOverlayTarget[] = [...getAllRidElements(includeLinks)];
  const seenElements = new Set(elements.map(item => item.element));
  for (const target of additionalTargets) {
    if (!seenElements.has(target.element)) {
      elements.push(target);
      seenElements.add(target.element);
    }
  }
  const linkCount = includeLinks ? elements.filter(({ element }) => element.tagName === 'A').length : 0;
  log.debug('sync', `syncOverlays: ${elements.length} elements (${linkCount} links), enrichMode=${s.enrichMode}`);
  const ridsToEnrich: string[] = [];

  // Filter to new elements only. The WeakSet is the fast path, while the
  // direct-child check is the recovery path when state was reset but BMP kept
  // a navigation host alive. Identity is per host (the same RID may appear in
  // several places), so never dedupe document-wide by RID.
  const newElements = elements.filter(({ element, rid }) => {
    if (s.badgedElements.has(element)) return false;
    const owned = Array.from(element.children).filter(
      (child): child is HTMLElement => child instanceof HTMLElement && child.classList.contains('crev-label'),
    );
    const matching = owned.find(label => label.dataset.crevLabel === rid);
    if (matching) {
      for (const duplicate of owned) {
        if (duplicate !== matching) duplicate.remove();
      }
      s.badgedElements.add(element);
      return false;
    }
    // A reused BMP host can change identity in place. Remove its stale
    // Companion label before mounting the new identity and handlers.
    for (const stale of owned) stale.remove();
    return true;
  });

  // Write pass: apply DOM changes
  for (const { element, rid, labelClassName, visualType, placement, compact, propertyTarget } of newElements) {
    const enrichment = s.enrichments.get(rid);
    const presentation = { labelClassName, visualType, placement, compact } satisfies OverlayPresentation;
    const color = getTypeColor(resolvedOverlayType(enrichment?.type, presentation));

    element.classList.add('crev-outline');
    (element as HTMLElement).style.setProperty('--crev-color', color);

    const label = createIdentityLabel(s, rid, presentation, propertyTarget);

    // Short, inline targets (breadcrumbs, nav links) are mostly text, so the
    // top-right corner pill lands on top of that text. Tag those to overhang
    // the top edge instead of covering content (see .crev-label--edge). Tall
    // widgets keep the in-corner placement — it sits in their header padding.
    const elHeight = (element as HTMLElement).offsetHeight;
    if (placement !== 'inline-start' && (
      labelClassName === 'crev-edit-field-label'
      || element.tagName === 'A'
      || (elHeight > 0 && elHeight <= 26)
    )) {
      // The overhang gets sliced off when the host is flush against a
      // clipping ancestor's top (tab strips, the BMP header, breadcrumb
      // bars) or the viewport top. Detect that and tuck the pill just
      // inside the top edge instead, so it stays fully visible. Kept as a
      // child-of-host placement (not a portal layer) so it scrolls with the
      // element and doesn't fight the editor/objectview frame overlays.
      label.classList.add(hasRoomAbove(element) ? 'crev-label--edge' : 'crev-label--edge-inside');
    }

    if (placement === 'inline-start') element.prepend(label);
    else element.appendChild(label);
    applyCompactMode(label, element as HTMLElement);
    s.badgedElements.add(element);

    // Track RIDs that need enrichment (with dedup)
    if (!s.enrichments.has(rid) && !s.requestedRids.has(rid)) {
      ridsToEnrich.push(rid);
      s.requestedRids.add(rid);
    }
  }

  // Single pass over every element for the two cache concerns, instead of two
  // separate full walks of a dense page's rid set per sync:
  //   (a) re-request enrichment for any rid still missing it — this also covers
  //       already-badged elements whose enrichment never landed (the write pass
  //       above only handles brand-new elements), and
  //   (b) discover new rids for the object cache.
  const now = Date.now();
  const newDiscovered: BmpObject[] = [];
  for (const { rid } of elements) {
    if (!s.enrichments.has(rid) && !s.requestedRids.has(rid)) {
      ridsToEnrich.push(rid);
      s.requestedRids.add(rid);
    }
    if (!s.discoveredRids.has(rid) && s.discoveredRids.size < DISCOVERED_RIDS_CAP) {
      s.discoveredRids.add(rid);
      newDiscovered.push({ rid, source: 'dom' as const, discoveredAt: now, updatedAt: now });
    }
  }

  // Request enrichment for unknown RIDs
  if (ridsToEnrich.length > 0) {
    log.debug('sync', `ENRICH_BADGES: sending ${ridsToEnrich.length} RIDs`, ridsToEnrich);
    sendToSW({ type: 'ENRICH_BADGES', rids: ridsToEnrich });
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
  s.resetOverlays();
}

/** Update badge labels from enrichment data */
export function updateLabels(s: ContentState) {
  for (const label of document.querySelectorAll<HTMLElement>('[data-crev-label]')) {
    const rid = label.getAttribute('data-crev-label');
    if (!rid) continue;
    const enrichment = s.enrichments.get(rid);
    if (enrichment) {
      // Rebuild stub + identity + meta squares from the (now-known) type.
      renderLabelContent(label, rid, enrichment);
      label.classList.remove('crev-label-loading');
      const parent = label.parentElement;
      if (parent) {
        const color = getTypeColor(overlayVisualType(label, enrichment.type));
        parent.style.setProperty('--crev-color', color);
        // The identity text just changed width — re-check the tiny-host fit.
        if (!label.classList.contains('crev-page-label')) applyCompactMode(label, parent);
      }
    }
  }
}
