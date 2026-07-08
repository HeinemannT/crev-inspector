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
import { CHART_TYPES } from '../lib/types';
import { typeBadge } from '../lib/type-badge';
import { h, render, svg } from '../lib/dom';
import { ICON_X, ICON_WARNING, ICON_CHECK, ICON_SEARCH, ICON_COPY, ICON_ARROWS_OUT_SIMPLE } from '../lib/icons';
import { emptyState } from '../lib/empty-state';
import { installCloseHandshake } from '../lib/frame-close-handshake';
import { sendFireForget, sendRequest } from '../lib/messaging';
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
/** Split-browser selection: the rail row whose code shows in the preview. */
let selectedRid: string | null = null;
/** Index into the selected object's flattened match list (see matchesFor). */
let navIdx = 0;
/** Full code per rid (codeFields from FETCH_OBJECT_PANE) — fetched lazily on
 *  selection so the preview can show real surrounding context, cached for the
 *  session. */
const paneCache = new Map<string, Record<string, string>>();
const paneLoading = new Set<string>();
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
}, svg(ICON_X)) as HTMLButtonElement;

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
    if (!selectedRid && results.length > 0) selectObject(results[0].rid, 0, false);
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
  const elements: (HTMLElement | null | false)[] = [renderToolbar()];
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

function renderToolbar(): HTMLElement {
  // Search shell (hero input) — mirrors Browse's .browse-search-shell.
  // Uses the persistent input + button nodes (never recreated on keystroke);
  // syncSearchShell() sets their current state after they're (re)mounted.
  const searchShell = h('div', { class: 'cs-search-shell' },
    h('span', { class: 'cs-search-icon' }, svg(ICON_SEARCH)),
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

  // Live counts per group from the current result set — the pills double as
  // a result breakdown (C1's facet idea folded into the existing filters).
  const groupCounts = new Map<string, number>();
  for (const r of results) {
    for (const g of TYPE_GROUPS) {
      if (r.type && (g.types as readonly string[]).includes(r.type)) {
        groupCounts.set(g.key, (groupCounts.get(g.key) ?? 0) + r.matchingLines.length);
      }
    }
  }
  for (const g of TYPE_GROUPS) {
    const n = groupCounts.get(g.key) ?? 0;
    pills.push(h('button', {
      class: `cs-pill cs-pill--type${activeGroups.has(g.key) ? ' active' : ''}`,
      title: g.types.length === 1 ? g.types[0] : `${g.types.length} types`,
      onClick: () => {
        if (activeGroups.has(g.key)) activeGroups.delete(g.key);
        else activeGroups.add(g.key);
        fireSearch();
      },
    }, g.label, n > 0 ? h('span', { class: 'cs-pill-count' }, String(n)) : null));
  }

  // Subtree scope on its own row (not crammed into the wrapping pill row) —
  // accepts a numeric RID or a namespace.bid ref (e.g. t.118). The resolved
  // object (or an error) shows in a chip beside the input.
  const scopeSet = subtreeRid.trim().length > 0;
  const scopeFeedback = !scopeSet
    ? null
    : scopeError
      ? h('span', { class: 'cs-scope-feedback cs-scope-feedback--error', title: scopeError }, svg(ICON_WARNING), h('span', { class: 'cs-scope-feedback-name' }, scopeError))
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
          h('span', { class: 'cs-filter-icon' }, svg(ICON_SEARCH)),
          filterInputEl,
          resultFilter
            ? h('button', {
                class: 'cs-filter-clear',
                title: 'Clear filter',
                onClick: () => { resultFilter = ''; filterInputEl.value = ''; renderUI(); },
              }, svg(ICON_X))
            : null,
        ),
        h('button', {
          class: 'cs-bulk-btn cs-copy-btn',
          title: 'Copy the matched objects (class, id, name) as a tab-separated table',
          onClick: copyResultsTable,
        }, svg(ICON_COPY), ' Copy table'),
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
  render(btn, svg(ICON_CHECK), ` Copied ${count}`);
  if (copyFlashTimer) clearTimeout(copyFlashTimer);
  copyFlashTimer = setTimeout(() => { const b = document.querySelector<HTMLElement>('.cs-copy-btn'); if (b) render(b, svg(ICON_COPY), ' Copy table'); }, 1500);
}

function renderErrorBanner(message: string): HTMLElement {
  return h('div', { class: 'cs-error', role: 'alert' },
    h('span', { class: 'cs-error-icon' }, svg(ICON_WARNING)),
    h('span', { class: 'cs-error-text' }, message),
    h('button', {
      class: 'cs-error-dismiss',
      title: 'Dismiss',
      onClick: () => { lastError = null; renderUI(); },
    }, svg(ICON_X)),
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

/** Select a rail object; optionally jump its match nav to `idx`. Kicks the
 *  lazy full-code fetch so the preview can show real context. */
function selectObject(rid: string, idx = 0, rerender = true): void {
  selectedRid = rid;
  navIdx = idx;
  ensurePane(rid);
  if (rerender) renderUI();
}

/** Fetch (once) the object's full code fields for the preview. */
function ensurePane(rid: string): void {
  if (paneCache.has(rid) || paneLoading.has(rid)) return;
  paneLoading.add(rid);
  void sendRequest({ type: 'FETCH_OBJECT_PANE', rid }).then((msg) => {
    paneLoading.delete(rid);
    if (msg && msg.type === 'OBJECT_PANE_DATA' && msg.rid === rid) {
      paneCache.set(rid, msg.codeFields ?? {});
    } else {
      paneCache.set(rid, {});
    }
    renderUI();
  });
}

/** The selected object's matches flattened across its property results. */
function matchesFor(rid: string): Array<{ property: string; lineNum: number; text: string }> {
  const out: Array<{ property: string; lineNum: number; text: string }> = [];
  for (const r of results.filter(passesResultFilter)) {
    if (r.rid !== rid) continue;
    for (const l of r.matchingLines) out.push({ property: r.property, lineNum: l.lineNum, text: l.text });
  }
  return out;
}

/** Rail order: unique rids of the (filtered) result set, stream order. */
function railRids(): string[] {
  const seen = new Set<string>();
  const rids: string[] = [];
  for (const r of results.filter(passesResultFilter)) {
    if (!seen.has(r.rid)) { seen.add(r.rid); rids.push(r.rid); }
  }
  return rids;
}

/** Step the match cursor; wraps across rail objects at either end. */
function stepMatch(dir: 1 | -1): void {
  if (!selectedRid) return;
  const matches = matchesFor(selectedRid);
  const next = navIdx + dir;
  if (next >= 0 && next < matches.length) { navIdx = next; renderUI(); return; }
  const rids = railRids();
  const at = rids.indexOf(selectedRid);
  const nextRid = rids[(at + dir + rids.length) % rids.length];
  const nextMatches = matchesFor(nextRid);
  selectObject(nextRid, dir === 1 ? 0 : Math.max(0, nextMatches.length - 1));
}

function renderResults(): HTMLElement {
  const filtered = results.filter(passesResultFilter);
  if (filtered.length === 0) {
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

  const rids = railRids();
  // Keep the selection valid under the result filter.
  const rid = selectedRid && rids.includes(selectedRid) ? selectedRid : rids[0];
  if (rid !== selectedRid) { selectedRid = rid; navIdx = 0; ensurePane(rid); }

  // ── Left rail: one row per hit object ──
  const byRid = new Map<string, CodeSearchResult[]>();
  for (const r of filtered) {
    if (!byRid.has(r.rid)) byRid.set(r.rid, []);
    byRid.get(r.rid)!.push(r);
  }
  const railRows = rids.map((rrid) => {
    const group = byRid.get(rrid)!;
    const first = group[0];
    const count = group.reduce((n, g) => n + g.matchingLines.length, 0);
    return h('div', {
      class: `csx-rrow${rrid === rid ? ' on' : ''}`,
      role: 'button',
      tabindex: '0',
      title: `${first.type ?? ''} \u00b7 ${first.name || first.businessId || rrid}`,
      onClick: () => selectObject(rrid),
      onKeyDown: (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); selectObject(rrid); }
      },
    },
      typeBadge(first.type, { size: 'xs' }),
      h('span', { class: 'csx-rid' }, first.businessId || first.name || rrid),
      h('span', { class: 'csx-rcount' }, String(count)),
    );
  });
  const rail = h('div', { class: 'csx-rail' },
    ...railRows,
    h('div', { class: 'csx-rail-note' }, `${rids.length} object${rids.length !== 1 ? 's' : ''} \u00b7 ${filtered.reduce((n, r) => n + r.matchingLines.length, 0)} matches`),
  );

  // ── Right preview: full code of the current match's property ──
  const group = byRid.get(rid)!;
  const first = group[0];
  const matches = matchesFor(rid);
  if (navIdx >= matches.length) navIdx = Math.max(0, matches.length - 1);
  const cur = matches[navIdx];
  const prop = cur?.property ?? first.property;

  const header = h('div', { class: 'csx-phead' },
    typeBadge(first.type, { size: 'xs' }),
    h('span', { class: 'csx-pname', title: first.name || '(unnamed)' }, first.name || '(unnamed)'),
    h('span', { class: 'csx-pprop' }, `.${prop}`),
    h('span', { class: 'csx-psp' }),
    h('button', { class: 'csx-nav', title: 'Previous match', onClick: () => stepMatch(-1) }, '\u2039'),
    h('button', { class: 'csx-nav', title: 'Next match', onClick: () => stepMatch(1) }, '\u203a'),
    h('span', { class: 'csx-navpos' }, matches.length > 0 ? `${navIdx + 1}/${matches.length}` : '0/0'),
    h('button', {
      class: 'csx-act',
      title: `Open .${prop} in the floating editor`,
      onClick: () => sendFireForget({ type: 'OPEN_EDITOR', rid, property: prop, scrollToLine: cur?.lineNum, scrollToText: cur?.text }),
    }, 'Edit \u2197'),
    h('button', {
      class: 'csx-act csx-act--ov',
      title: 'Open this object in the full Object View',
      'aria-label': 'Open full object view',
      onClick: () => sendFireForget({ type: 'OPEN_OBJECT_VIEW', rid }),
    }, svg(ICON_ARROWS_OUT_SIMPLE)),
  );

  // Full code when the pane fetch has landed; matched-lines-only fallback
  // while loading (or when the prop wasn't in codeFields, e.g. indirect EC).
  const fields = paneCache.get(rid);
  const fullBody = fields?.[prop];
  const hitLines = new Set(matches.filter(m => m.property === prop).map(m => m.lineNum));
  const curLine = cur?.property === prop ? cur.lineNum : -1;
  const codeChildren: HTMLElement[] = [];
  if (fullBody != null) {
    const lines = fullBody.split('\n');
    lines.forEach((text, i) => {
      const n = i + 1;
      codeChildren.push(h('div', { class: `csx-cl${hitLines.has(n) ? ' hit' : ''}${n === curLine ? ' cur' : ''}`,
        title: `Open .${prop} at line ${n} in the floating editor`,
        onClick: () => sendFireForget({ type: 'OPEN_EDITOR', rid, property: prop, scrollToLine: n, scrollToText: text }),
      },
        h('span', { class: 'csx-ln' }, String(n)),
        highlightMatch(text),
      ));
    });
  } else {
    if (paneLoading.has(rid)) codeChildren.push(h('div', { class: 'csx-loading' }, 'Loading full code\u2026'));
    for (const m of matches.filter(mm => mm.property === prop)) {
      codeChildren.push(h('div', { class: `csx-cl hit${m.lineNum === curLine ? ' cur' : ''}` },
        h('span', { class: 'csx-ln' }, String(m.lineNum)),
        highlightMatch(m.text),
      ));
    }
  }

  const preview = h('div', { class: 'csx-prev' }, header, h('div', { class: 'csx-code', id: 'csx-code' }, ...codeChildren));
  const el = h('div', { class: 'csx-split' }, rail, preview);
  // Bring the current match into view after the (re)render lands.
  requestAnimationFrame(() => {
    document.querySelector('#csx-code .csx-cl.cur')?.scrollIntoView({ block: 'center' });
  });
  return el;
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
  selectedRid = null;
  navIdx = 0;
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

