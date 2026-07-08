/**
 * Reference view — shows objects whose code references a given businessId.
 * Pushes onto the active tab like detail-view. Results stream in via CODE_SEARCH_PROGRESS.
 */

import type { InspectorMessage, CodeSearchResult } from '../lib/types';
import { typeBadge } from '../lib/type-badge';
import { h, render, svg } from '../lib/dom';
import { ICON_ARROW_LEFT } from './utils';
import { ecPreviewSpan } from '../lib/ec-format';

const s = {
  active: false,
  query: '',
  targetName: '',
  targetType: '',
  results: [] as CodeSearchResult[],
  searched: 0,
  total: 0,
  done: false,
};

let onBackCb: (() => void) | null = null;
let onNavigateCb: ((rid: string) => void) | null = null;
let sendCb: ((msg: InspectorMessage) => void) | null = null;

export function initReferenceView(onBack: () => void, onNavigate: (rid: string) => void, send: (msg: InspectorMessage) => void) {
  onBackCb = onBack;
  onNavigateCb = onNavigate;
  sendCb = send;
}

export function showReferenceView(msg: InspectorMessage & { type: 'SEARCH_REFERENCES' }, panel: HTMLElement) {
  s.active = true;
  s.query = msg.businessId || msg.rid;
  s.targetName = msg.name || s.query;
  s.targetType = msg.objectType || '';
  s.results = [];
  s.searched = 0;
  s.total = 0;
  s.done = false;
  renderRefs(panel);
}

export function handleReferenceMessage(msg: InspectorMessage, panel: HTMLElement): boolean {
  if (!s.active) return false;

  if (msg.type === 'CODE_SEARCH_PROGRESS') {
    s.results = msg.results;
    s.searched = msg.searched;
    s.total = msg.total;
    renderRefs(panel);
    return true;
  }
  if (msg.type === 'CODE_SEARCH_DONE') {
    s.done = true;
    renderRefs(panel);
    return true;
  }
  return false;
}

export function isReferenceActive(): boolean { return s.active; }

export function clearReferenceView() {
  if (s.active) {
    sendCb?.({ type: 'CODE_SEARCH_STOP' });
  }
  s.active = false;
  s.results = [];
}

function renderRefs(panel: HTMLElement) {
  const children: (HTMLElement | false | null)[] = [
    h('button', { class: 'detail-back', onClick: () => { clearReferenceView(); onBackCb?.(); } }, svg(ICON_ARROW_LEFT), ' Back'),

    h('div', { class: 'ref-header' },
      s.targetType ? typeBadge(s.targetType, { size: 'xs' }) : null,
      h('span', { class: 'ref-title' }, `References to ${s.targetName}`),
    ),

    // Progress
    !s.done && h('div', { class: 'ref-progress' },
      h('div', { class: 'ref-progress-bar' },
        h('div', { class: 'ref-progress-fill', style: `width:${s.total > 0 ? Math.round(s.searched / s.total * 100) : 0}%` }),
      ),
      h('span', { class: 'ref-progress-text' }, `${s.searched} / ${s.total} searched`),
    ),
  ];

  if (s.results.length === 0 && s.done) {
    children.push(h('div', { class: 'ref-empty' }, 'No references found'));
  }

  // Group results by RID
  const grouped = new Map<string, CodeSearchResult[]>();
  for (const r of s.results) {
    const existing = grouped.get(r.rid) ?? [];
    existing.push(r);
    grouped.set(r.rid, existing);
  }

  for (const [rid, matches] of grouped) {
    const first = matches[0];
    children.push(
      h('div', { class: 'ref-group' },
        h('div', { class: 'ref-group-header', onClick: () => onNavigateCb?.(rid) },
          typeBadge(first.type, { size: 'xs' }),
          h('span', { class: 'ref-group-name' }, first.name ?? 'unnamed'),
          h('span', { class: 'ref-group-bid' }, first.businessId ?? ''),
          h('span', { class: 'ref-group-count' }, `${matches.length}`),
        ),
        ...matches.flatMap(m =>
          m.matchingLines.map(line =>
            h('div', { class: 'ref-match' },
              h('span', { class: 'ref-match-prop' }, m.property),
              h('span', { class: 'ref-match-line' }, `L${line.lineNum}`),
              // EC-tokenised match text: same palette as the editor + Code
              // Search results, so a piece of EC reads the same colour
              // everywhere it appears in the panel. `ec-preview` is the
              // base class that carries `.ec-tok-*` rules; we append
              // `ref-match-text` so the existing layout rules still apply.
              ecPreviewSpan(line.text.trim(), 'ref-match-text'),
            ),
          ),
        ),
      ),
    );
  }

  if (s.done && s.results.length > 0) {
    children.push(h('div', { class: 'ref-footer' }, `${s.results.length} match${s.results.length !== 1 ? 'es' : ''} in ${grouped.size} object${grouped.size !== 1 ? 's' : ''}`));
  }

  render(panel, ...children);
}
