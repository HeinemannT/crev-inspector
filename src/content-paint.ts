/**
 * Content script paint format helpers — banner, cursors, flash, reload toast.
 */

import { h, render } from './lib/dom';
import { showToast } from './lib/toast';
import type { ContentState } from './content-state';

// ── Custom paint cursors ─────────────────────────────────────────────
// Phase-distinct cursors over inspect labels: an eyedropper while picking the
// source (you're sampling), a paintbrush while applying to targets. Each icon
// is drawn twice — a white halo underlay then the accent stroke — so it stays
// legible over any widget background. Hotspot sits on the tool's tip.

const EYEDROPPER_PATHS =
  '<path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/>' +
  '<path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"/>';

const PAINTBRUSH_PATHS =
  '<path d="M18.37 2.63 14 7l-1.59-1.59a2 2 0 0 0-2.82 0L8 7l9 9 1.59-1.59a2 2 0 0 0 0-2.82L17 10l4.37-4.37a2.12 2.12 0 1 0-3-3Z"/>' +
  '<path d="M9 8c-2 3-4 3.5-7 4l8 10c2-1 6-5 6-7"/><path d="M14.5 17.5 4.5 15"/>';

function cursorUrl(paths: string, hotX: number, hotY: number): string {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" ' +
    'fill="none" stroke-linecap="round" stroke-linejoin="round">' +
    `<g stroke="#ffffff" stroke-width="4">${paths}</g>` +
    `<g stroke="#8a3ffc" stroke-width="2.25">${paths}</g></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hotX} ${hotY}, crosshair`;
}

const PICK_CURSOR = cursorUrl(EYEDROPPER_PATHS, 2, 22);
const APPLY_CURSOR = cursorUrl(PAINTBRUSH_PATHS, 3, 20);

export function updatePaintBanner(s: ContentState) {
  const banner = document.getElementById('crev-paint-banner');
  const bannerText = document.getElementById('crev-paint-text');
  if (!banner || !bannerText) return;

  if (s.paintPhase === 'off') {
    banner.classList.remove('crev-visible');
    banner.style.display = 'none';
    return;
  }

  // Clear the inline display:none the off-path set — otherwise it wins over
  // the `.crev-visible { display: block }` rule and the banner stays hidden
  // after a toggle-off→on cycle. (Styling now lives entirely in CSS.)
  banner.style.display = '';
  banner.classList.add('crev-visible');

  if (s.paintPhase === 'picking') {
    render(bannerText, 'Paint Format: ', h('b', null, 'click a widget to pick its style'));
  } else {
    render(bannerText,
      'Paint Format from ', h('b', null, s.paintSourceName ?? '?'),
      ': click widgets to apply (Esc to stop)');
  }
}

export function updatePaintCursors(s: ContentState) {
  const cursor = s.paintPhase === 'picking' ? PICK_CURSOR
    : s.paintPhase === 'applying' ? APPLY_CURSOR
    : 'pointer';
  for (const label of document.querySelectorAll<HTMLElement>('.crev-label-text')) {
    label.style.cursor = cursor;
  }
  updatePaintBanner(s);
}

export function flashApplyResult(rid: string, ok: boolean, error?: string) {
  const label = document.querySelector<HTMLElement>(`[data-crev-label="${rid}"]`);
  if (label) {
    const flashClass = ok ? 'crev-label-flash-ok' : 'crev-label-flash-error';
    label.classList.add(flashClass);
    setTimeout(() => { label.classList.remove(flashClass); }, 600);
  }

  if (ok) {
    // BMP's React DOM doesn't re-render on out-of-band EC writes, so the
    // painted style is invisible until a full reload. Offer one-click reload —
    // mirrors the object-detail save toast (detail-view.ts).
    showToast('Style painted — reload the BMP page to see it', 'success', {
      label: 'Reload',
      onClick: () => location.reload(),
    });
  } else {
    const msg = error === 'No source selected'
      ? 'Not connected. Add a server in Connect tab'
      : `Paint error: ${error ?? 'unknown'}`;
    showToast(msg, 'error');
  }
}
