/**
 * Reference view — shows objects whose code references a given businessId.
 * Pushes onto the active tab like detail-view. Results stream in via CODE_SEARCH_PROGRESS.
 */

import type { InspectorMessage, CodeSearchResult } from '../lib/types';
import { getTypeColor, getTypeAbbr } from '../lib/types';
import { h, render, svg } from '../lib/dom';

let active = false;
let query = '';
let targetName = '';
let targetType = '';
let results: CodeSearchResult[] = [];
let searched = 0;
let total = 0;
let done = false;
let onBackCb: (() => void) | null = null;
let onNavigateCb: ((rid: string) => void) | null = null;

const ICON_BACK = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/></svg>';

export function initReferenceView(onBack: () => void, onNavigate: (rid: string) => void) {
  onBackCb = onBack;
  onNavigateCb = onNavigate;
}

export function showReferenceView(msg: InspectorMessage & { type: 'SEARCH_REFERENCES' }, panel: HTMLElement) {
  active = true;
  query = msg.businessId || msg.rid;
  targetName = msg.name || query;
  targetType = msg.objectType || '';
  results = [];
  searched = 0;
  total = 0;
  done = false;
  renderRefs(panel);
}

export function handleReferenceMessage(msg: InspectorMessage, panel: HTMLElement): boolean {
  if (!active) return false;

  if (msg.type === 'CODE_SEARCH_PROGRESS') {
    results = msg.results;
    searched = msg.searched;
    total = msg.total;
    renderRefs(panel);
    return true;
  }
  if (msg.type === 'CODE_SEARCH_DONE') {
    done = true;
    renderRefs(panel);
    return true;
  }
  return false;
}

export function isReferenceActive(): boolean { return active; }

export function clearReferenceView() {
  active = false;
  results = [];
}

function renderRefs(panel: HTMLElement) {
  const color = getTypeColor(targetType);
  const abbr = getTypeAbbr(targetType);

  const children: (HTMLElement | false | null)[] = [
    h('button', { class: 'detail-back', onClick: () => { clearReferenceView(); onBackCb?.(); } }, svg(ICON_BACK), ' Back'),

    h('div', { class: 'ref-header' },
      targetType && h('span', { class: 'type-badge', style: `background:${color}` }, abbr),
      h('span', { class: 'ref-title' }, `References to ${targetName}`),
    ),

    // Progress
    !done && h('div', { class: 'ref-progress' },
      h('div', { class: 'ref-progress-bar' },
        h('div', { class: 'ref-progress-fill', style: `width:${total > 0 ? Math.round(searched / total * 100) : 0}%` }),
      ),
      h('span', { class: 'ref-progress-text' }, `${searched} / ${total} searched`),
    ),
  ];

  if (results.length === 0 && done) {
    children.push(h('div', { class: 'ref-empty' }, 'No references found'));
  }

  // Group results by RID
  const grouped = new Map<string, CodeSearchResult[]>();
  for (const r of results) {
    const existing = grouped.get(r.rid) ?? [];
    existing.push(r);
    grouped.set(r.rid, existing);
  }

  for (const [rid, matches] of grouped) {
    const first = matches[0];
    const matchColor = getTypeColor(first.type);
    children.push(
      h('div', { class: 'ref-group' },
        h('div', { class: 'ref-group-header', onClick: () => onNavigateCb?.(rid) },
          h('span', { class: 'type-badge', style: `background:${matchColor}` }, getTypeAbbr(first.type)),
          h('span', { class: 'ref-group-name' }, first.name ?? 'unnamed'),
          h('span', { class: 'ref-group-bid' }, first.businessId ?? ''),
          h('span', { class: 'ref-group-count' }, `${matches.length}`),
        ),
        ...matches.flatMap(m =>
          m.matchingLines.map(line =>
            h('div', { class: 'ref-match' },
              h('span', { class: 'ref-match-prop' }, m.property),
              h('span', { class: 'ref-match-line' }, `L${line.lineNum}`),
              h('span', { class: 'ref-match-text' }, line.text.trim()),
            ),
          ),
        ),
      ),
    );
  }

  if (done && results.length > 0) {
    children.push(h('div', { class: 'ref-footer' }, `${results.length} match${results.length !== 1 ? 'es' : ''} in ${grouped.size} object${grouped.size !== 1 ? 's' : ''}`));
  }

  render(panel, ...children);
}
