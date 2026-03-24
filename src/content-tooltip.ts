/**
 * Content script tooltip + technical overlay card rendering.
 */

import { getTypeColor, getTypeAbbr, TYPES_WITH_CODE } from './lib/types';
import { h, render } from './lib/dom';
import type { ContentState } from './content-state';

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

  const enrichment = s.enrichments.get(rid);
  const color = getTypeColor(enrichment?.type);
  const typeAbbr = getTypeAbbr(enrichment?.type);
  const typeName = enrichment?.type ?? (s.requestedRids.has(rid) ? 'Loading\u2026' : 'Unknown');

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

export function hideTooltip(s: ContentState) {
  if (s.tooltipHideTimer) clearTimeout(s.tooltipHideTimer);
  s.tooltipHideTimer = setTimeout(() => {
    const tooltip = document.getElementById('crev-tooltip');
    if (tooltip) tooltip.style.display = 'none';
    s.tooltipHideTimer = null;
  }, 50);
}

/** Request and render technical overlay property cards */
export function applyTechnicalOverlay(s: ContentState) {
  if (s.technicalOverlay) {
    const visibleRids: string[] = [];
    for (const label of document.querySelectorAll<HTMLElement>('[data-crev-label]')) {
      const rid = label.getAttribute('data-crev-label');
      if (rid && !s.overlayProps.has(rid)) visibleRids.push(rid);
    }
    if (visibleRids.length > 0) {
      try {
        chrome.runtime.sendMessage(
          { type: 'GET_OVERLAY_PROPS', rids: visibleRids },
          (response: any) => {
            if (chrome.runtime.lastError) return;
            if (response?.type === 'OVERLAY_PROPS_DATA' && response.props) {
              for (const [rid, props] of Object.entries(response.props)) {
                s.overlayProps.set(rid, props as Record<string, string>);
              }
              renderOverlayCards(s);
            }
          },
        );
      } catch { /* swallowed — extension context may be invalidated */ }
    }
  }
  renderOverlayCards(s);
}

export function renderOverlayCards(s: ContentState) {
  for (const label of document.querySelectorAll<HTMLElement>('[data-crev-label]')) {
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
