import { getTypeColor, getTypeAbbr } from '../../lib/types';
import { h, render, svg } from '../../lib/dom';
import { delegate } from '../delegate';
import { truncRid, copyBtn, ICON_REFRESH } from '../utils';
import { S, sendMessage } from '../state';

const SIGNAL_LABELS: Record<string, string> = {
  '#epmapp container': 'App container',
  '#corpo-app root': 'App root',
  'data-rid attributes': 'Object IDs found',
  'LatoLatinWeb font': 'BMP font loaded',
  'BMP URL path': 'BMP URL',
  'BMP page title': 'Page title',
  'BMP widget classes': 'Widgets detected',
  'BMP assets': 'BMP scripts',
  'widget-found': 'Widgets found',
  'storage-read': 'Storage data',
  'content-script-unreachable': 'Page not scriptable',
  'non-injectable': 'Browser page',
};

function friendlySignal(s: string): string {
  return SIGNAL_LABELS[s] ?? s;
}

function detectionCard(): HTMLElement | false {
  const d = S.detection;
  if (d.phase === 'checking' || d.phase === 'unknown') {
    return h('div', { class: 'detection-card' },
      h('div', { class: 'detection-header' },
        h('span', { class: 'detection-status checking' }, 'Checking\u2026'),
        h('span', { class: 'detection-confidence' }, h('span', { class: 'detection-spinner' })),
      ),
    );
  }

  const pct = Math.round(d.confidence * 100);
  const isDetected = d.phase === 'detected';
  return h('div', { class: 'detection-card' },
    h('div', { class: 'detection-header' },
      h('span', { class: `detection-status ${isDetected ? 'detected' : 'not-detected'}` },
        isDetected ? 'BMP Detected' : 'Not a BMP page'),
      h('span', { class: 'detection-confidence' }, `${pct}%`),
    ),
    d.signals.length > 0 && h('div', { class: 'detection-signals' },
      ...d.signals.map(s => h('span', { class: 'signal-tag' }, friendlySignal(s))),
    ),
  );
}

export function renderPageTab(navigateToDetail: (rid: string) => void) {
  const panel = document.getElementById('panel-page');
  if (!panel) return;

  const children: (HTMLElement | false | null)[] = [detectionCard()];

  if (!S.pageInfo) {
    children.push(h('div', { class: 'empty-state' }, 'Loading page info\u2026'));
    render(panel, ...children);
    return;
  }

  // Current page RIDs
  if (S.pageInfo.rid || S.pageInfo.tabRid) {
    const rows = [];
    if (S.pageInfo.rid) {
      rows.push(h('tr', null,
        h('td', { class: 'prop-key' }, 'RID'),
        h('td', { class: 'prop-value has-copy' },
          h('span', { class: 'mono' }, S.pageInfo.rid), copyBtn(S.pageInfo.rid)),
      ));
    }
    if (S.pageInfo.tabRid) {
      rows.push(h('tr', null,
        h('td', { class: 'prop-key' }, 'Tab RID'),
        h('td', { class: 'prop-value has-copy' },
          h('span', { class: 'mono' }, S.pageInfo.tabRid), copyBtn(S.pageInfo.tabRid)),
      ));
    }
    children.push(
      h('div', { class: 'section-title' }, 'Current Page'),
      h('table', { class: 'prop-table' }, ...rows),
    );
  }

  // Widgets
  if (S.pageInfo.widgets.length > 0) {
    children.push(
      h('div', { class: 'section-title' },
        `Widgets (${S.pageInfo.widgets.length})`,
        h('button', { class: 'refresh-enrich-btn', 'data-action': 'refresh', title: 'Re-fetch badge IDs' }, svg(ICON_REFRESH)),
      ),
      h('ul', { class: 'widget-list' },
        ...S.pageInfo.widgets.map(w =>
          h('li', {
            class: 'widget-item',
            'data-action': 'widget',
            'data-rid': w.rid,
            title: 'Click for details',
          },
            h('span', { class: 'widget-type', style: `background:${getTypeColor(w.type)}` }, getTypeAbbr(w.type)),
            h('span', { class: 'widget-name' }, w.name ?? 'unnamed'),
            h('span', { class: 'widget-rid' }, truncRid(w.rid)),
          ),
        ),
      ),
    );
  } else {
    const msg = S.detection.phase === 'detected'
      ? 'BMP detected, but no inspectable widgets on this view. Try scrolling or navigating to a dashboard.'
      : 'No widgets detected on this page';
    children.push(h('div', { class: 'empty-state' }, msg));
  }

  render(panel, ...children);

  delegate(panel, {
    widget: (el) => {
      const rid = el.dataset.rid;
      if (rid) navigateToDetail(rid);
    },
    refresh: () => sendMessage({ type: 'REFRESH_ENRICHMENT' }),
  });
}
