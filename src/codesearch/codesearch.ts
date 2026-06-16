/**
 * Code Search overlay — find text patterns across BMP code properties
 * workspace-wide. Lives in its own popup window because the result
 * grid needs horizontal space the side panel can't spare.
 *
 * Hero search field + filter pills (match-case, type groups) +
 * subtree scope chip. Query is debounced 350 ms; the SW engine
 * (src/lib/code-search.ts) does the heavy lifting and streams results
 * back via CODE_SEARCH_PROGRESS messages. Expanded result rows show
 * matched lines with line numbers; clicking a line opens the
 * containing object in the side panel's Workshop.
 */

import type { InspectorMessage, CodeSearchResult } from '../lib/types';
import { getTypeColor, getTypeAbbr, CHART_TYPES } from '../lib/types';
import { h, render } from '../lib/dom';
import { emptyState } from '../lib/empty-state';
import { installCloseHandshake } from '../lib/frame-close-handshake';
import { sendFireForget } from '../lib/messaging';
import { tokenizeEcLine, renderTokens } from '../lib/ec-format';
import { captureTypingFocus } from '../lib/focus-keep';

installCloseHandshake();

const root = document.getElementById('search-root')!;

// ── State ────────────────────────────────────────────────────────
let query = '';
let subtreeRid = '';
/** Resolved scope object (name/type/bid) for the feedback chip, or an error
 *  string when the scope input couldn't be resolved. Both null = no scope. */
let scopeInfo: { rid: string; businessId: string; name: string; type: string } | null = null;
let scopeError: string | null = null;
let caseSensitive = true;
let searching = false;
/** True once a search has actually run — gates the "no matches" empty state
 *  so it can't show before the user has searched (manual-trigger model). */
let hasSearched = false;
let searched = 0;
let total = 0;
let results: CodeSearchResult[] = [];
let lastError: string | null = null;
const expandedGroups = new Set<string>();
/** When a type name is here, that section is COLLAPSED. Default empty
 *  means all sections expanded — this is the friendlier default for
 *  small result sets while still letting the toolbar's "Collapse all"
 *  do its job for large ones. */
const collapsedSections = new Set<string>();
/** Substring narrow-down applied AFTER the BMP query lands. Filters by
 *  name / businessId / matched line text — no extra round-trip. */
let resultFilter = '';

// Typing-intent tracking so focus survives a render NOT triggered by the
// keystroke itself (a streamed CODE_SEARCH_PROGRESS can blur the input to <body>
// before capture). The shared captureTypingFocus reclaims it; see focus-keep.ts.
let lastTyped: HTMLInputElement | null = null;
let lastTypedAt = 0;

// Multi-select type-group filter pills. Empty set = all groups
// active (default — same convention as Browse's kind pills).
// `actions` covers click-handler EC (ActionButton / ButtonInput / Label).
// `gates` covers ExtendedExpression — the indirect target of every
//   showExpression / enableExpression / validateExpression Reference.
// `transports` covers ExtendedTransport (notification body EC).
const TYPE_GROUPS: ReadonlyArray<{ key: string; label: string; types: readonly string[] }> = [
  { key: 'tables',     label: 'Tables',          types: ['ExtendedTable'] },
  { key: 'calc',       label: 'Calc Props',      types: ['ExtendedMethodConfig'] },
  { key: 'charts',     label: 'Charts',          types: CHART_TYPES },
  { key: 'viz',        label: 'Visualizations',  types: ['CustomVisualization'] },
  { key: 'actions',    label: 'Actions',         types: ['ActionButton', 'ButtonInput', 'Label'] },
  { key: 'gates',      label: 'Gate EC',         types: ['ExtendedExpression'] },
  { key: 'transports', label: 'Notifications',   types: ['ExtendedTransport'] },
];
const activeGroups = new Set<string>(); // keys; empty = all

// ── Persistent search-shell nodes ────────────────────────────────
// The search box and its buttons are built ONCE and reused across every
// re-render, so typing never recreates the input element. That was the old
// focus bug: each keystroke ran renderUI() → render(root, …), which destroyed
// and rebuilt the <input>, dropping focus/caret (and characters under fast
// typing or IME composition). Now keystrokes update state + toggle the buttons
// imperatively (syncSearchShell) and never rebuild the input. Search still runs
// only on Enter / the Search button — typing is cheap and local.
const searchInputEl = h('input', {
  class: 'cs-search-input',
  id: 'cs-query',
  type: 'text',
  autocomplete: 'off',
  autocorrect: 'off',
  spellcheck: 'false',
  onInput: () => {
    lastTyped = searchInputEl; lastTypedAt = Date.now();
    query = searchInputEl.value;
    // Editing invalidates the last result set's verdict; it reverts to the
    // hero/fresh state on the next Enter. We don't re-render here — that's the
    // whole point — so the prior results simply linger until the next search.
    hasSearched = false;
    syncSearchShell();
  },
  onKeyDown: (e: KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); fireSearch(); }
    if (e.key === 'Escape') {
      if (searching) sendFireForget({ type: 'CODE_SEARCH_STOP' });
      else if (query) { query = ''; searchInputEl.value = ''; hasSearched = false; syncSearchShell(); }
    }
  },
}) as HTMLInputElement;

const searchClearBtn = h('button', {
  class: 'cs-search-clear',
  title: 'Clear',
  onClick: () => {
    query = ''; searchInputEl.value = ''; results = []; searched = 0; total = 0; hasSearched = false;
    renderUI();
    searchInputEl.focus();
  },
}, '✕') as HTMLButtonElement;

const searchStopBtn = h('button', {
  class: 'cs-search-stop',
  title: 'Stop search',
  onClick: () => sendFireForget({ type: 'CODE_SEARCH_STOP' }),
}, 'Stop') as HTMLButtonElement;

const searchGoBtn = h('button', {
  class: 'cs-search-go',
  title: 'Run search (Enter)',
  onClick: () => fireSearch(),
}, 'Search') as HTMLButtonElement;

/** Persistent result-filter input — like the search box, built once and reused
 *  across renders so narrowing the result set never recreates the field. Focus
 *  is preserved by the capture/restore in renderUI (both inputs are tracked). */
const filterInputEl = h('input', {
  class: 'cs-filter-input', id: 'cs-filter', type: 'text',
  placeholder: 'Filter results by name / id / matched line…',
  autocomplete: 'off', autocorrect: 'off', spellcheck: 'false',
}) as HTMLInputElement;
filterInputEl.addEventListener('input', () => {
  lastTyped = filterInputEl; lastTypedAt = Date.now();
  resultFilter = filterInputEl.value;
  renderUI();
});

/** Imperatively reflect query/searching/case state in the always-present
 *  search-shell controls — no DOM rebuild, so the input keeps focus. */
function syncSearchShell(): void {
  searchInputEl.placeholder = caseSensitive
    ? 'Search code (case-sensitive)…'
    : 'Search code (case-insensitive)…';
  searchClearBtn.hidden = query.length === 0;
  searchStopBtn.hidden = !searching;
  searchGoBtn.hidden = searching || query.trim().length === 0;
}

// ── Message routing ──────────────────────────────────────────────
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
    lastError = msg.error ?? null;
    renderUI();
  }
  if (msg.type === 'CODE_SEARCH_SCOPE') {
    scopeInfo = msg.scope;
    scopeError = msg.error ?? null;
    renderUI();
  }
});

renderUI();

// ── Render ───────────────────────────────────────────────────────
function renderUI() {
  const elements: (HTMLElement | null | false)[] = [renderHeader(), renderToolbar()];
  if (lastError) elements.push(renderErrorBanner(lastError));
  if (searching || searched > 0) elements.push(renderProgress());

  if (results.length > 0) {
    elements.push(renderResults());
  } else if (searching) {
    elements.push(renderSkeleton());
  } else if (hasSearched && !lastError) {
    // Only after a real search came back empty — not while the user is still
    // typing (no auto-search anymore).
    elements.push(renderNoMatches());
  } else {
    elements.push(renderHeroEmpty());
  }

  // The search + result-filter inputs are persistent nodes that render() wipes
  // and reattaches, dropping focus. Reclaim the recently-typed one (shared helper).
  const restoreFocus = captureTypingFocus({ el: lastTyped, at: lastTypedAt });

  render(root, ...elements.filter(Boolean) as HTMLElement[]);

  restoreFocus();
  // First paint / a non-typing rebuild that dropped focus to <body> (and the
  // helper didn't reclaim a typed input) → keep the search box ready for typing.
  if (document.activeElement === document.body) {
    const queryInput = document.getElementById('cs-query') as HTMLInputElement | null;
    queryInput?.focus({ preventScroll: true });
  }
}

function renderHeader(): HTMLElement {
  return h('header', { class: 'cs-header' },
    h('h1', { class: 'cs-title' }, 'Code Search'),
    h('span', { class: 'cs-subtitle' },
      'Find a text pattern across every BMP code property in the workspace.',
    ),
  );
}

function renderToolbar(): HTMLElement {
  // Search shell (hero input) — mirrors Browse's .browse-search-shell.
  // Uses the persistent input + button nodes (never recreated on keystroke);
  // syncSearchShell() sets their current state after they're (re)mounted.
  const searchShell = h('div', { class: 'cs-search-shell' },
    h('span', { class: 'cs-search-icon' }, '⌕'),
    searchInputEl,
    searchClearBtn,
    searchStopBtn,
    searchGoBtn,
  );
  syncSearchShell();

  // Filter pills row.
  const pills: HTMLElement[] = [];
  pills.push(h('button', {
    class: `cs-pill cs-pill--case${caseSensitive ? ' active' : ''}`,
    title: caseSensitive
      ? 'Match case: uses the fast server-side prefilter (recommended)'
      : 'Ignore case: falls back to fetch-and-grep, slower on large workspaces',
    onClick: () => { caseSensitive = !caseSensitive; fireSearch(); },
  }, 'Aa Match case'));

  for (const g of TYPE_GROUPS) {
    pills.push(h('button', {
      class: `cs-pill cs-pill--type${activeGroups.has(g.key) ? ' active' : ''}`,
      title: g.types.length === 1 ? g.types[0] : `${g.types.length} types`,
      onClick: () => {
        if (activeGroups.has(g.key)) activeGroups.delete(g.key);
        else activeGroups.add(g.key);
        fireSearch();
      },
    }, g.label));
  }

  // Subtree scope on its own row (not crammed into the wrapping pill row) —
  // accepts a numeric RID or a namespace.bid ref (e.g. t.118). The resolved
  // object (or an error) shows in a chip beside the input.
  const scopeSet = subtreeRid.trim().length > 0;
  const scopeFeedback = !scopeSet
    ? null
    : scopeError
      ? h('span', { class: 'cs-scope-feedback cs-scope-feedback--error', title: scopeError }, '⚠ ' + scopeError)
      : scopeInfo
        ? h('span', { class: 'cs-scope-feedback cs-scope-feedback--ok', title: `${scopeInfo.type} · ${scopeInfo.businessId || scopeInfo.rid}` },
            '↳ ',
            h('span', { class: 'cs-scope-feedback-name' }, scopeInfo.name || '(unnamed)'),
            scopeInfo.type ? h('span', { class: 'cs-scope-feedback-type' }, scopeInfo.type) : null,
          )
        : null;
  const scopeRow = h('div', { class: 'cs-scope-row' },
    h('span', { class: 'cs-scope-label' }, 'Scope'),
    h('input', {
      class: 'cs-scope-input',
      type: 'text',
      placeholder: 'RID or t.bid (blank = whole workspace)',
      value: subtreeRid,
      title: 'Limit to a subtree: numeric RID or namespace.bid (e.g. t.118). Empty = whole workspace. Press Enter or Search to apply.',
      onInput: (e: Event) => { subtreeRid = (e.currentTarget as HTMLInputElement).value; hasSearched = false; },
      onKeyDown: (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); fireSearch(); } },
    }),
    scopeFeedback,
  );

  // Second toolbar row — only shown once results land. Carries the
  // narrow-by-substring filter and the bulk expand/collapse controls.
  // Kept hidden when there are no results so the empty / hero state
  // doesn't reserve unnecessary vertical space.
  const hasResults = results.length > 0;
  const resultControls = hasResults
    ? h('div', { class: 'cs-result-controls' },
        h('div', { class: 'cs-filter-shell' },
          h('span', { class: 'cs-filter-icon' }, '⌕'),
          filterInputEl,
          resultFilter
            ? h('button', {
                class: 'cs-filter-clear',
                title: 'Clear filter',
                onClick: () => { resultFilter = ''; filterInputEl.value = ''; renderUI(); },
              }, '✕')
            : null,
        ),
        h('button', {
          class: 'cs-bulk-btn',
          title: 'Expand every section + every object',
          onClick: () => {
            collapsedSections.clear();
            for (const r of results) expandedGroups.add(r.rid);
            renderUI();
          },
        }, '▾ Expand all'),
        h('button', {
          class: 'cs-bulk-btn',
          title: 'Collapse every section',
          onClick: () => {
            const types = new Set(results.map(r => r.type ?? ''));
            for (const t of types) collapsedSections.add(t);
            expandedGroups.clear();
            renderUI();
          },
        }, '▸ Collapse all'),
        h('button', {
          class: 'cs-bulk-btn cs-copy-btn',
          title: 'Copy the matched objects (class, id, name) as a tab-separated table',
          onClick: copyResultsTable,
        }, '⎘ Copy table'),
      )
    : null;

  return h('div', { class: 'cs-toolbar' },
    searchShell,
    h('div', { class: 'cs-pill-row' }, ...pills),
    scopeRow,
    resultControls,
  );
}

/** Copy the (filtered) matched objects as a TSV table: className, id, name —
 *  one row per object (deduped across the property rows that share a RID). */
function copyResultsTable(): void {
  const seen = new Set<string>();
  const rows = [['Class', 'ID', 'Name']];
  for (const r of results.filter(passesResultFilter)) {
    if (seen.has(r.rid)) continue;
    seen.add(r.rid);
    rows.push([r.type ?? '', r.businessId || r.rid, r.name || '']);
  }
  const tsv = rows.map(cols => cols.join('\t')).join('\n');
  navigator.clipboard.writeText(tsv)
    .then(() => flashCopied(rows.length - 1))
    .catch(() => { /* clipboard blocked — nothing we can do from here */ });
}

let copyFlashTimer: ReturnType<typeof setTimeout> | null = null;
function flashCopied(count: number): void {
  const btn = document.querySelector<HTMLElement>('.cs-copy-btn');
  if (!btn) return;
  btn.textContent = `✓ Copied ${count}`;
  if (copyFlashTimer) clearTimeout(copyFlashTimer);
  copyFlashTimer = setTimeout(() => { const b = document.querySelector<HTMLElement>('.cs-copy-btn'); if (b) b.textContent = '⎘ Copy table'; }, 1500);
}

function renderErrorBanner(message: string): HTMLElement {
  return h('div', { class: 'cs-error', role: 'alert' },
    h('span', { class: 'cs-error-icon' }, '⚠'),
    h('span', { class: 'cs-error-text' }, message),
    h('button', {
      class: 'cs-error-dismiss',
      title: 'Dismiss',
      onClick: () => { lastError = null; renderUI(); },
    }, '✕'),
  );
}

function renderProgress(): HTMLElement {
  const pct = total > 0 ? Math.round((searched / total) * 100) : 0;
  const hitCount = results.length;
  const status = searching
    ? `Searching… ${searched}/${total} · ${hitCount} hit${hitCount !== 1 ? 's' : ''}`
    : `${searched} ${total === searched && total > 0 ? 'completed' : 'scanned'} · ${hitCount} hit${hitCount !== 1 ? 's' : ''}`;
  return h('div', { class: `cs-progress${searching ? ' cs-progress--active' : ''}` },
    h('div', { class: 'cs-progress-bar' },
      h('div', { class: 'cs-progress-fill', style: `width:${pct}%` }),
    ),
    h('span', { class: 'cs-progress-text' }, status),
  );
}

function renderHeroEmpty(): HTMLElement {
  return emptyState({
    variant: 'hero',
    title: 'Search BMP code',
    body: 'Find a substring across every code-bearing object in the workspace: ExtendedTable expressions, calculated property EC, chart code, CustomVisualization html / javascript, action button EC (init / after / show / enable), label / button defaults, ExtendedExpression bodies, and notification transports.',
    hint: 'Tip: case-sensitive search uses a server-side prefilter (much faster). Disable “Match case” only when the substring case is genuinely uncertain.',
  });
}

function renderNoMatches(): HTMLElement {
  return emptyState({ variant: 'inline', body: `No matches for “${query}”.` });
}

function renderSkeleton(): HTMLElement {
  return h('div', { class: 'cs-skeleton' },
    h('div', { class: 'cs-skeleton-row' }),
    h('div', { class: 'cs-skeleton-row' }),
    h('div', { class: 'cs-skeleton-row' }),
  );
}

/** Apply the substring `resultFilter` to a result. Empty filter = pass. */
function passesResultFilter(r: CodeSearchResult): boolean {
  const q = resultFilter.trim().toLowerCase();
  if (!q) return true;
  if (r.name?.toLowerCase().includes(q)) return true;
  if (r.businessId?.toLowerCase().includes(q)) return true;
  if (r.property.toLowerCase().includes(q)) return true;
  return r.matchingLines.some(l => l.text.toLowerCase().includes(q));
}

function renderResults(): HTMLElement {
  // Two-level grouping: TYPE → RID. Type sections collapse to clean
  // up the scan UX when there are many type families in the result
  // set; RID groups inside each section keep the existing per-object
  // expand-to-see-context behaviour.
  const filtered = results.filter(passesResultFilter);
  if (filtered.length === 0) {
    // Distinguish "no results" (handled at the renderUI level) from
    // "filter excluded everything" — show the second only when there
    // ARE underlying results.
    return h('div', { class: 'cs-results' },
      h('div', { class: 'cs-no-filter-matches' },
        `No results match the filter "${resultFilter}". `,
        h('button', {
          class: 'cs-link',
          onClick: () => { resultFilter = ''; filterInputEl.value = ''; renderUI(); },
        }, 'Clear filter'),
      ),
    );
  }

  const byType = new Map<string, Map<string, CodeSearchResult[]>>();
  for (const r of filtered) {
    // Engine always populates `type` but the message type marks it
    // optional; coalesce defensively so the bucket key is well-defined.
    const typeKey = r.type ?? '';
    if (!byType.has(typeKey)) byType.set(typeKey, new Map());
    const ridMap = byType.get(typeKey)!;
    if (!ridMap.has(r.rid)) ridMap.set(r.rid, []);
    ridMap.get(r.rid)!.push(r);
  }

  const sectionEls: HTMLElement[] = [];
  // Stable, alphabetical type order; types unknown to the abbreviation
  // map (rare) fall through to their raw name and still sort.
  const sortedTypes = [...byType.keys()].sort((a, b) => a.localeCompare(b));
  for (const typeName of sortedTypes) {
    const ridMap = byType.get(typeName)!;
    const sectionExpanded = !collapsedSections.has(typeName);
    const objectCount = ridMap.size;
    const matchCount = [...ridMap.values()].reduce(
      (n, group) => n + group.reduce((m, r) => m + r.matchingLines.length, 0),
      0,
    );

    const sectionHeader = h('button', {
      class: `cs-section-header${sectionExpanded ? ' expanded' : ''}`,
      'data-type': typeName,
      'data-action': 'toggle-section',
      title: sectionExpanded ? `Collapse ${typeName} results` : `Expand ${typeName} results`,
    },
      h('span', { class: 'cs-section-chev' }, sectionExpanded ? '▾' : '▸'),
      h('span', { class: 'cs-type-chip', style: `--type-color:${getTypeColor(typeName)}` }, getTypeAbbr(typeName)),
      h('span', { class: 'cs-section-type' }, typeName),
      h('span', { class: 'cs-section-counts' },
        `${objectCount} object${objectCount !== 1 ? 's' : ''} · ${matchCount} match${matchCount !== 1 ? 'es' : ''}`,
      ),
    );

    const sectionBody: HTMLElement[] = [];
    if (sectionExpanded) {
      for (const [rid, group] of ridMap) {
        const first = group[0];
        const expanded = expandedGroups.has(rid);
        const totalMatches = group.reduce((n, r) => n + r.matchingLines.length, 0);

        // A div (not a button) so the id / name text stays selectable —
        // drag-select doesn't fire a click, so a plain click still toggles
        // (delegated via data-action). Name + id are two equal columns.
        const header = h('div', {
          class: `cs-result-header${expanded ? ' expanded' : ''}`,
          role: 'button',
          tabindex: '0',
          'data-rid': rid,
          'data-action': 'toggle',
          title: expanded ? 'Collapse' : 'Expand to see matched lines',
          onKeyDown: (e: KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              if (expandedGroups.has(rid)) expandedGroups.delete(rid); else expandedGroups.add(rid);
              renderUI();
            }
          },
        },
          h('span', { class: 'cs-result-chev' }, expanded ? '▾' : '▸'),
          h('span', { class: 'cs-result-name', title: first.name || '(unnamed)' }, first.name || '(unnamed)'),
          h('span', { class: 'cs-result-id' },
            h('span', { class: 'cs-result-id-label' }, 'id:'),
            h('span', { class: 'cs-result-id-val' }, first.businessId || rid),
          ),
          h('span', { class: 'cs-result-count' }, `${totalMatches} match${totalMatches !== 1 ? 'es' : ''}`),
          h('button', {
            class: 'cs-result-open',
            title: 'Open this object in the popout',
            'data-action': 'open-in-popout',
            'data-rid': rid,
            onClick: (e: Event) => { e.stopPropagation(); sendFireForget({ type: 'OPEN_OBJECT_VIEW', rid }); },
          }, '↗'),
        );

        const groupEl = h('div', { class: 'cs-result-group' }, header);

        if (expanded) {
          for (const r of group) {
            groupEl.appendChild(h('div', { class: 'cs-result-prop' }, `.${r.property}`));
            for (const line of r.matchingLines) {
              // Click → open the EDITOR on this property AND scroll
              // to the matched line. The ↗ button in the header still
              // opens ObjectView for users who want the broader
              // context (parent, siblings, props).
              groupEl.appendChild(h('div', {
                class: 'cs-match-line',
                title: `Open .${r.property} at line ${line.lineNum} in the floating editor`,
                onClick: () => sendFireForget({
                  type: 'OPEN_EDITOR',
                  rid,
                  property: r.property,
                  scrollToLine: line.lineNum,
                  scrollToText: line.text,
                }),
              },
                h('span', { class: 'cs-line-num' }, String(line.lineNum)),
                highlightMatch(line.text),
              ));
            }
          }
        }

        sectionBody.push(groupEl);
      }
    }

    sectionEls.push(h('div', { class: 'cs-section' },
      sectionHeader,
      sectionExpanded ? h('div', { class: 'cs-section-body' }, ...sectionBody) : null,
    ));
  }

  const resultsEl = h('div', { class: 'cs-results' }, ...sectionEls);
  resultsEl.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    const sectionToggle = target.closest<HTMLElement>('[data-action="toggle-section"]');
    if (sectionToggle) {
      const t = sectionToggle.dataset.type;
      if (t) {
        if (collapsedSections.has(t)) collapsedSections.delete(t);
        else collapsedSections.add(t);
        renderUI();
        return;
      }
    }
    const toggleEl = target.closest<HTMLElement>('[data-action="toggle"]');
    if (toggleEl) {
      const rid = toggleEl.dataset.rid;
      if (rid) {
        if (expandedGroups.has(rid)) expandedGroups.delete(rid);
        else expandedGroups.add(rid);
        renderUI();
      }
    }
  });
  return resultsEl;
}

/** Render a matched code line with EC syntax colouring AND the query-match
 *  background composed together. The tokens come from the lightweight EC
 *  tokeniser (`tokenizeEcLine`); the match ranges come from the
 *  case-aware indexOf walk that used to be the whole of this function.
 *
 *  Composition: each token is split at the match-range boundaries so a
 *  match that overlaps a tokenised span produces multiple sub-spans —
 *  the outside-match part carries only `ec-tok-<kind>`, the inside-match
 *  part carries BOTH `ec-tok-<kind>` and `cs-match-highlight`. The
 *  background-only `cs-match-highlight` (see codesearch.css) layers
 *  over the token colour cleanly. Total `textContent` of the assembled
 *  span equals the input — covered by the composition test. */
function highlightMatch(text: string): HTMLElement {
  const tokens = tokenizeEcLine(text);
  const lineSpan = h('span', { class: 'cs-line-text' });

  if (!query) {
    renderTokens(lineSpan, text, tokens);
    return lineSpan;
  }

  // Find all match ranges. Skip the walk entirely if the query somehow
  // ends up empty after trimming (shouldn't happen — fireSearch guards
  // it — but the indexOf-of-"" loop would otherwise spin).
  const haystackXform = caseSensitive ? (s: string) => s : (s: string) => s.toLowerCase();
  const needle = caseSensitive ? query : query.toLowerCase();
  if (!needle) {
    renderTokens(lineSpan, text, tokens);
    return lineSpan;
  }
  const hay = haystackXform(text);
  const matchRanges: Array<[number, number]> = [];
  let idx = hay.indexOf(needle);
  while (idx !== -1) {
    matchRanges.push([idx, idx + needle.length]);
    idx = hay.indexOf(needle, idx + needle.length);
  }

  // Walk tokens; for each, intersect with match ranges and emit sub-spans.
  // Boundary set per token = {tok.start, tok.end} ∪ (match boundaries inside).
  const inAnyMatch = (s: number, e: number): boolean =>
    matchRanges.some(([ms, me]) => ms <= s && e <= me);

  for (const tok of tokens) {
    const breaks = new Set<number>([tok.start, tok.end]);
    for (const [ms, me] of matchRanges) {
      if (me <= tok.start || ms >= tok.end) continue;
      if (ms > tok.start && ms < tok.end) breaks.add(ms);
      if (me > tok.start && me < tok.end) breaks.add(me);
    }
    const sorted = [...breaks].sort((a, b) => a - b);
    for (let i = 0; i < sorted.length - 1; i++) {
      const s = sorted[i];
      const e = sorted[i + 1];
      const inMatch = inAnyMatch(s, e);
      const kindCls = tok.kind ? `ec-tok-${tok.kind}` : '';
      const matchCls = inMatch ? 'cs-match-highlight' : '';
      const className = [kindCls, matchCls].filter(Boolean).join(' ');
      const slice = text.slice(s, e);
      if (!className) {
        lineSpan.appendChild(document.createTextNode(slice));
      } else {
        const el = document.createElement('span');
        el.className = className;
        el.textContent = slice;
        lineSpan.appendChild(el);
      }
    }
  }
  return lineSpan;
}

// ── Search invocation ────────────────────────────────────────────
function fireSearch(): void {
  if (!query.trim()) {
    results = [];
    searched = 0;
    total = 0;
    searching = false;
    hasSearched = false;
    renderUI();
    return;
  }
  hasSearched = true;

  // No need to explicitly stop the previous in-flight search —
  // `startCodeSearch` bumps the generation counter on entry, which
  // invalidates whatever's already running. Sending a separate STOP
  // before START would race with the new START because
  // chrome.runtime.sendMessage doesn't guarantee FIFO across calls;
  // STOP could arrive AFTER the new START, killing the new search.

  // Resolve active type groups → flat type list. Empty selection =
  // all groups active (every code-bearing type).
  let types: string[] | undefined;
  if (activeGroups.size > 0) {
    types = [];
    for (const g of TYPE_GROUPS) {
      if (activeGroups.has(g.key)) types.push(...g.types);
    }
  }

  searching = true;
  results = [];
  searched = 0;
  total = 0;
  lastError = null;
  expandedGroups.clear();
  collapsedSections.clear();
  resultFilter = '';
  filterInputEl.value = ''; // persistent node — clear it too, or it shows stale filter text

  sendFireForget({
    type: 'CODE_SEARCH_START',
    query: query.trim(),
    subtreeRid: subtreeRid.trim() || undefined,
    types,
    caseSensitive,
  });

  renderUI();
}

