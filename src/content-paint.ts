/**
 * Content script paint format helpers — banner, cursors, flash, reload toast.
 */

import { h, render } from './lib/dom';
import { showToast } from './lib/toast';
import { PICK_CURSOR, APPLY_CURSOR } from './lib/cursors';
import type { ContentState } from './content-state';

// Phase-distinct cursors over inspect labels: an eyedropper while picking the
// source (you're sampling), a paintbrush while applying to targets. Shared
// with the blueprint brush — see lib/cursors.ts.

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
    showToast('Style painted. Reload the BMP page to see it.', 'success', {
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
