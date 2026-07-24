/**
 * Content script tooltip + technical overlay card rendering.
 */

import { getTypeColor, getTypeAbbr } from './lib/types';
import { buildObjectCard } from './lib/object-card';
import { typeAffordances } from './lib/widget-metadata';
import { hasStudio } from './studio/studio-mode';
import { render } from './lib/dom';
import { sendRequest, sendFireForget } from './lib/messaging';
import { updateOverlayBlockState } from './content-frame-overlay';
import type { ContentState } from './content-state';
import { log } from './lib/logger';

const OVERLAY_SKIP_PROPS = new Set(['rid', 'id', 'name', 'type', '__typename', 'typename',
  'source', 'discoveredAt', 'updatedAt', 'treePath', 'webParentRid', 'hasChildren']);
const OVERLAY_CODE_PROPS = new Set(['expression', 'html', 'javascript']);
const OVERLAY_MAX_PROP_LINES = 6;

export function showTooltipForElement(s: ContentState, el: HTMLElement, rid: string) {
  if (s.tooltipHideTimer) {
    clearTimeout(s.tooltipHideTimer);
    s.tooltipHideTimer = null;
  }

  const tooltip = document.getElementById('crev-tooltip');
  if (!tooltip) return;

  // The card is interactive (copy rows + open button): keep it alive while
  // the cursor is on it, hide on leave. Wired once.
  if (!tooltip.dataset.wired) {
    tooltip.dataset.wired = '1';
    tooltip.addEventListener('mouseenter', () => {
      if (s.tooltipHideTimer) { clearTimeout(s.tooltipHideTimer); s.tooltipHideTimer = null; }
    });
    tooltip.addEventListener('mouseleave', () => hideTooltip(s));
  }

  const enrichment = s.enrichments.get(rid);
  const type = enrichment?.type;
  const color = getTypeColor(type);
  // Open EC only for code-bearing types; route to the studio when the type
  // has one (CVO / TextElement), else the floating editor — same rule the
  // stub's code square uses.
  const codeBearing = typeAffordances(type).code;
  render(tooltip, buildObjectCard(
    {
      name: enrichment?.name,
      type,
      typeFallback: s.requestedRids.has(rid) ? 'Loading\u2026' : 'Unknown',
      businessId: enrichment?.businessId,
      templateBusinessId: enrichment?.templateBusinessId,
      rid,
      color,
    },
    {
      onOpenFull: () => sendFireForget({ type: 'OPEN_OBJECT_VIEW', rid }),
      onOpenEc: codeBearing
        ? () => sendFireForget(hasStudio(type) ? { type: 'OPEN_STUDIO', rid } : { type: 'OPEN_EDITOR', rid })
        : undefined,
    },
  ));
  tooltip.style.top = '-9999px';
  tooltip.style.left = '-9999px';
  tooltip.style.display = 'block';
  tooltip.classList.add('crev-visible');

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

  // A frame overlay (Object View / editor / diff) may sit over the tooltip's
  // new spot. The overlay gate only re-runs on DOM mutations, but we just
  // moved an existing node via inline styles — so it never fired and the
  // tooltip lingered on top of the popout. Nudge the gate here (only when an
  // overlay is actually open) so an intersecting tooltip gets hidden.
  if (document.body.classList.contains('crev-task-open')) {
    updateOverlayBlockState();
  }
}

export function hideTooltip(s: ContentState) {
  if (s.tooltipHideTimer) clearTimeout(s.tooltipHideTimer);
  s.tooltipHideTimer = setTimeout(() => {
    const tooltip = document.getElementById('crev-tooltip');
    // Last-line defence: never hide while the cursor is ON the card —
    // timer-vs-mouseenter races (and any listener that re-arms the hide
    // mid-transit) can't kill an actively used card this way.
    if (tooltip?.matches(':hover')) { s.tooltipHideTimer = null; return; }
    if (tooltip) { tooltip.style.display = 'none'; tooltip.classList.remove('crev-visible'); }
    s.tooltipHideTimer = null;
  }, 400);
}

/** Request and render technical overlay property cards */
export function applyTechnicalOverlay(s: ContentState) {
  if (s.technicalOverlay) {
    const visibleRids: string[] = [];
    for (const label of document.querySelectorAll<HTMLElement>('[data-crev-label]')) {
      if (label.classList.contains('crev-page-label')) continue;
      const rid = label.getAttribute('data-crev-label');
      if (rid && !s.overlayProps.has(rid)) visibleRids.push(rid);
    }
    if (visibleRids.length > 0) {
      sendRequest({ type: 'GET_OVERLAY_PROPS', rids: visibleRids }).then(response => {
        if (response?.type === 'OVERLAY_PROPS_DATA' && response.props) {
          for (const [rid, props] of Object.entries(response.props)) {
            s.overlayProps.set(rid, props as Record<string, string>);
          }
          renderOverlayCards(s);
        }
      }).catch(e => log.swallow('content-tooltip:applyTechnicalOverlay', e));
    }
  }
  renderOverlayCards(s);
}

export function renderOverlayCards(s: ContentState) {
  for (const label of document.querySelectorAll<HTMLElement>('[data-crev-label]')) {
    if (label.classList.contains('crev-page-label')) continue;
    const rid = label.getAttribute('data-crev-label');
    if (!rid) continue;
    const enrichment = s.enrichments.get(rid);
    const textSpan = label.querySelector('.crev-label-text');
    if (!textSpan) continue;

    if (s.technicalOverlay) {
      label.classList.add('crev-label--card');
      const typeName = enrichment?.type ?? 'Unknown';
      const bid = enrichment?.businessId ?? '';
      const name = enrichment?.name ?? 'unnamed';
      const truncatedRid = rid.length > 12 ? rid.slice(0, 6) + '\u2026' + rid.slice(-4) : rid;
      textSpan.innerHTML = '';

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

      const props = s.overlayProps.get(rid);
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
