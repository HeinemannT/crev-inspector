/**
 * Page tab — BMP detection status, current page RIDs, widget list.
 */

import type { InspectorMessage, WidgetInfo, DetectionPhase } from '../../lib/types';
import { getTypeColor, getTypeAbbr } from '../../lib/types';
import { h, render, svg } from '../../lib/dom';
import { delegate } from '../delegate';
import { truncRid, copyBtn, ICON_REFRESH } from '../utils';
import { S as shared } from '../state';
import type { Tab, SendFn } from './tab-types';

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

export class PageTab implements Tab {
  private pageInfo: { url: string; rid?: string; tabRid?: string; widgets: WidgetInfo[] } | null = null;
  private detection = { phase: 'unknown' as DetectionPhase, confidence: 0, signals: [] as string[] };
  private send: SendFn;
  private onNavigate: (rid: string) => void;

  constructor(send: SendFn, onNavigate: (rid: string) => void) {
    this.send = send;
    this.onNavigate = onNavigate;
  }

  activate() {
    this.detection = { phase: 'unknown', confidence: 0, signals: [] };
    this.pageInfo = null;
    this.send({ type: 'GET_PAGE_INFO' });
  }

  deactivate() {}

  handleMessage(msg: InspectorMessage): boolean {
    switch (msg.type) {
      case 'PAGE_INFO':
        this.pageInfo = { url: msg.url, rid: msg.rid, tabRid: msg.tabRid, widgets: msg.widgets };
        if (msg.detection) {
          const phase: DetectionPhase = msg.detection.isBmp ? 'detected' : 'not-detected';
          this.detection = { phase, confidence: msg.detection.confidence, signals: msg.detection.signals };
        }
        return true;
      case 'DETECTION_STATE':
        this.detection = { phase: msg.phase, confidence: msg.confidence, signals: msg.signals };
        return true;
      default:
        return false;
    }
  }

  render(container: HTMLElement) {
    const children: (HTMLElement | false | null)[] = [this.detectionCard()];

    if (!this.pageInfo) {
      children.push(h('div', { class: 'empty-state' }, 'Loading page info\u2026'));
      render(container, ...children);
      return;
    }

    // Current page RIDs
    if (this.pageInfo.rid || this.pageInfo.tabRid) {
      const rows = [];
      if (this.pageInfo.rid) {
        rows.push(h('tr', null,
          h('td', { class: 'prop-key' }, 'RID'),
          h('td', { class: 'prop-value has-copy' },
            h('span', { class: 'mono' }, this.pageInfo.rid), copyBtn(this.pageInfo.rid)),
        ));
      }
      if (this.pageInfo.tabRid) {
        rows.push(h('tr', null,
          h('td', { class: 'prop-key' }, 'Tab RID'),
          h('td', { class: 'prop-value has-copy' },
            h('span', { class: 'mono' }, this.pageInfo.tabRid), copyBtn(this.pageInfo.tabRid)),
        ));
      }
      children.push(
        h('div', { class: 'section-title' }, 'Current Page'),
        h('table', { class: 'prop-table' }, ...rows),
      );
    }

    // Widgets
    if (this.pageInfo.widgets.length > 0) {
      children.push(
        h('div', { class: 'section-title' },
          `Widgets (${this.pageInfo.widgets.length})`,
          h('button', { class: 'refresh-enrich-btn', 'data-action': 'refresh', title: 'Re-fetch badge IDs' }, svg(ICON_REFRESH)),
        ),
        h('ul', { class: 'widget-list' },
          ...this.pageInfo.widgets.map(w =>
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
      const msg = this.detection.phase === 'detected'
        ? 'BMP detected, but no inspectable widgets on this view. Try scrolling or navigating to a dashboard.'
        : 'No widgets detected on this page';
      children.push(h('div', { class: 'empty-state' }, msg));
    }

    render(container, ...children);

    delegate(container, {
      widget: (el) => {
        const rid = el.dataset.rid;
        if (rid) this.onNavigate(rid);
      },
      refresh: () => this.send({ type: 'REFRESH_ENRICHMENT' }),
    });
  }

  private detectionCard(): HTMLElement | false {
    const d = this.detection;
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
}
