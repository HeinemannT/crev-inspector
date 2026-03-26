/**
 * Code Search Page — search for text patterns across BMP code properties.
 * Communicates with service worker for search operations.
 */

import type { InspectorMessage, CodeSearchResult } from '../lib/types';
import { getTypeColor, getTypeAbbr, CODE_PROPS_FOR_TYPE, CHART_TYPES } from '../lib/types';
import { h, render } from '../lib/dom';

const root = document.getElementById('search-root')!;

// State
let searching = false;
let results: CodeSearchResult[] = [];
let searched = 0;
let total = 0;
let expandedGroups = new Set<string>();

// Listen for messages from service worker
chrome.runtime.onMessage.addListener((msg: InspectorMessage) => {
  if (msg.type === 'CODE_SEARCH_PROGRESS') {
    results = msg.results;
    searched = msg.searched;
    total = msg.total;
    renderUI();
  }
  if (msg.type === 'CODE_SEARCH_DONE') {
    searching = false;
    searched = msg.totalSearched;
    renderUI();
  }
});

renderUI();

function renderUI() {
  const formRow1 = h('div', { class: 'cs-form-row' },
    h('input', { class: 'cs-input', id: 'search-query', placeholder: 'Search pattern...', type: 'text' }),
    !searching
      ? h('button', { class: 'btn btn-accent', id: 'btn-search' }, 'Search')
      : h('button', { class: 'btn btn-danger', id: 'btn-stop' }, 'Stop'),
  );

  const formRow2 = h('div', { class: 'cs-form-row' },
    h('span', { class: 'cs-label' }, 'Scope'),
    h('input', { class: 'cs-input cs-input-mono', id: 'search-scope', placeholder: 'Subtree RID (optional)', style: 'max-width:200px' }),
  );

  const TYPE_GROUPS: Array<{ label: string; types: readonly string[] }> = [
    { label: 'Tables', types: ['ExtendedTable'] },
    { label: 'Calc Props', types: ['ExtendedMethodConfig'] },
    { label: 'Charts (all)', types: CHART_TYPES },
    { label: 'Visualizations', types: ['CustomVisualization'] },
  ];
  const typeChecks = TYPE_GROUPS.map(g =>
    h('label', { class: 'cs-type-check' },
      h('input', { type: 'checkbox', checked: true, 'data-group-types': g.types.join(',') }),
      g.label,
    ),
  );
  const formRow3 = h('div', { class: 'cs-form-row' },
    h('span', { class: 'cs-label' }, 'Types'),
    h('div', { class: 'cs-types' }, ...typeChecks),
  );

  const form = h('div', { class: 'cs-form' }, formRow1, formRow2, formRow3);

  const elements: (HTMLElement | null)[] = [form];

  // Progress bar
  if (searching || searched > 0) {
    const pct = total > 0 ? Math.round((searched / total) * 100) : 0;
    elements.push(
      h('div', { class: 'cs-progress' },
        h('div', { class: 'cs-progress-bar' },
          h('div', { class: 'cs-progress-fill', style: `width:${pct}%` }),
        ),
        h('span', { class: 'cs-progress-text' },
          searching
            ? `Searching\u2026 ${searched}/${total} objects, ${results.length} match${results.length !== 1 ? 'es' : ''}`
            : `Done. Searched ${searched} objects, found ${results.length} match${results.length !== 1 ? 'es' : ''}`,
        ),
      ),
    );
  }

  // Results
  if (results.length > 0) {
    // Group results by RID
    const groups = new Map<string, CodeSearchResult[]>();
    for (const r of results) {
      const key = r.rid;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(r);
    }

    const resultsEl = h('div', { class: 'cs-results' });
    for (const [rid, group] of groups) {
      const first = group[0];
      const color = getTypeColor(first.type);
      const abbr = getTypeAbbr(first.type);
      const expanded = expandedGroups.has(rid);

      const header = h('div', { class: 'cs-result-header', 'data-rid': rid, 'data-toggle': 'true' },
        h('span', { class: 'cs-type-badge', style: `--type-color:${color}` }, abbr),
        h('span', { class: 'cs-result-name' }, first.name ?? 'unnamed'),
        h('span', { class: 'cs-result-bid' }, first.businessId ?? ''),
        h('span', { style: 'font-size:10px;color:var(--text-2)' }, `${group.length} match${group.length !== 1 ? 'es' : ''}`),
      );

      const groupEl = h('div', { class: 'cs-result-group' }, header);

      if (expanded) {
        for (const r of group) {
          groupEl.appendChild(h('div', { class: 'cs-result-prop' }, r.property));
          for (const line of r.matchingLines) {
            const lineEl = h('div', { class: 'cs-match-line' },
              h('span', { class: 'cs-line-num' }, String(line.lineNum)),
              highlightMatch(line.text),
            );
            groupEl.appendChild(lineEl);
          }
        }
      }

      resultsEl.appendChild(groupEl);
    }
    elements.push(resultsEl);
  } else if (!searching && searched > 0) {
    elements.push(h('div', { class: 'cs-hint' }, 'No matches found'));
  } else if (!searching && searched === 0) {
    elements.push(h('div', { class: 'cs-hint' }, 'Enter a search query and click Search'));
  }

  render(root, ...elements.filter(Boolean) as HTMLElement[]);

  // Wire events
  const queryInput = document.getElementById('search-query') as HTMLInputElement;
  queryInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !searching) startSearch();
  });

  document.getElementById('btn-search')?.addEventListener('click', startSearch);
  document.getElementById('btn-stop')?.addEventListener('click', () => {
    chrome.runtime.sendMessage({ type: 'CODE_SEARCH_STOP' });
  });

  // Toggle expanded groups
  root.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const header = target.closest<HTMLElement>('[data-toggle]');
    if (header) {
      const rid = header.dataset.rid;
      if (rid) {
        if (expandedGroups.has(rid)) expandedGroups.delete(rid);
        else expandedGroups.add(rid);
        renderUI();
      }
      return;
    }

    // Click on result to open object view
    const openEl = target.closest<HTMLElement>('[data-rid]');
    if (openEl && !openEl.dataset.toggle) {
      chrome.runtime.sendMessage({ type: 'OPEN_OBJECT_VIEW', rid: openEl.dataset.rid });
    }
  });

  // Focus query input
  queryInput?.focus();
}

function startSearch() {
  const query = (document.getElementById('search-query') as HTMLInputElement)?.value.trim();
  if (!query) return;

  const subtreeRid = (document.getElementById('search-scope') as HTMLInputElement)?.value.trim() || undefined;
  const types = Array.from(root.querySelectorAll<HTMLInputElement>('[data-group-types]:checked'))
    .flatMap(el => (el.dataset.groupTypes ?? '').split(','))
    .filter(Boolean);

  searching = true;
  results = [];
  searched = 0;
  total = 0;
  expandedGroups.clear();

  chrome.runtime.sendMessage({
    type: 'CODE_SEARCH_START',
    query,
    subtreeRid,
    types: types.length > 0 ? types : undefined,
  } as InspectorMessage);

  renderUI();
}

/** Get the current query for highlighting */
function getQuery(): string {
  return (document.getElementById('search-query') as HTMLInputElement)?.value.trim() ?? '';
}

/** Create a span with the match highlighted */
function highlightMatch(text: string): HTMLElement {
  const query = getQuery();
  if (!query) return h('span', null, text);

  const span = document.createElement('span');
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  let lastIdx = 0;

  let idx = lowerText.indexOf(lowerQuery);
  while (idx !== -1) {
    if (idx > lastIdx) {
      span.appendChild(document.createTextNode(text.slice(lastIdx, idx)));
    }
    const matchEl = document.createElement('span');
    matchEl.className = 'cs-match-highlight';
    matchEl.textContent = text.slice(idx, idx + query.length);
    span.appendChild(matchEl);
    lastIdx = idx + query.length;
    idx = lowerText.indexOf(lowerQuery, lastIdx);
  }

  if (lastIdx < text.length) {
    span.appendChild(document.createTextNode(text.slice(lastIdx)));
  }

  return span;
}
