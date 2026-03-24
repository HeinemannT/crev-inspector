/**
 * Content script paint format helpers — banner, cursors, preview, flash.
 */

import type { InspectorMessage } from './lib/types';
import { h, render } from './lib/dom';
import { sendToSW } from './lib/content-port';
import { showToast } from './lib/toast';
import type { ContentState } from './content-state';

export function updatePaintBanner(s: ContentState, ...content: (Node | string)[]) {
  const banner = document.getElementById('crev-paint-banner');
  const bannerText = document.getElementById('crev-paint-text');
  if (!banner || !bannerText) return;

  if (s.paintPhase === 'off') {
    banner.style.display = 'none';
    return;
  }

  banner.style.display = 'block';
  banner.style.background = '#ff832b';

  if (content.length > 0) {
    render(bannerText, ...content);
    return;
  }

  if (s.paintPhase === 'picking') {
    render(bannerText, 'Paint Format \u2014 ', h('b', null, 'click a widget to pick its style'));
  } else {
    render(bannerText, 'Paint Format from ', h('b', null, s.paintSourceName ?? '?'), ' \u2014 click widgets to apply');
  }
}

export function updatePaintCursors(s: ContentState) {
  const cursor = s.paintPhase !== 'off' ? 'crosshair' : 'pointer';
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
    showToast('Applied \u2014 refresh page to see changes', 'success');
  } else {
    const msg = error === 'No source selected'
      ? 'Not connected \u2014 add a server in Connect tab'
      : `Paint error: ${error ?? 'unknown'}`;
    showToast(msg, 'error');
  }
}

export function showPaintPreview(s: ContentState, rid: string, diff: Array<{ prop: string; from: string; to: string }>) {
  const bannerText = document.getElementById('crev-paint-text');
  if (!bannerText) return;

  if (diff.length === 0) {
    render(bannerText, 'No style differences \u2014 already identical');
    setTimeout(() => updatePaintBanner(s), 2000);
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
        onClick: () => updatePaintBanner(s),
      }, 'Cancel'),
    ),
  );
}
