/**
 * Browse tab — find any object in the workspace.
 *
 * Blends two sources into one ranked list:
 *  - the SW object CACHE (instant, as-you-type): things you've touched / pinned
 *    / discovered, matched by substring;
 *  - live BMP GraphQL quickSearch (the engine the web portal's own search box
 *    uses): the whole navigable workspace, relevance-ranked.
 * Results dedupe by rid and carry provenance (touched vs live).
 *
 * Type filtering uses two typable multi-select dropdowns — one for the Ce*
 * ENTERPRISE types, one for the non-Ce WEB/model types — plus an All-types
 * reset. Source can be narrowed to cache-only or workspace-only. The search
 * input is a persistent node (typing never recreates it) and focus is restored
 * by intent so a streamed result can't steal the cursor mid-edit.
 */

import type { InspectorMessage, BmpObject, HistoryEntry } from '../../lib/types';
import { getTypeColor, getTypeAbbr } from '../../lib/types';
import { h, render, svg } from '../../lib/dom';
import { delegate } from '../delegate';
import { truncRid, copyText, ICON_COPY, ICON_SEARCH } from '../utils';
import { resolveCopyText, getModifier, COPY_TOOLTIP } from '../../lib/namespace';
import { DISPLAY_LIMIT_STEP, SEARCH_DEBOUNCE } from '../../lib/constants';
import { S as shared } from '../state';
import { emptyState } from '../../lib/empty-state';
import { CE_TYPES, WEB_OBJECT_TYPES } from '../../lib/object-types';
import {
  blendResults, filterTypeOptions, provenance,
  type BrowseSource, type BrowseSort, type BrowseResult,
} from '../../lib/browse-blend';
import { captureTypingFocus } from '../../lib/focus-keep';
import type { Tab, SendFn } from './tab-types';

type DropdownKind = 'ce' | 'web' | null;

export class ObjectsTab implements Tab {
  private query = '';
  private cacheObjects: BmpObject[] = [];
  private liveObjects: BmpObject[] = [];
  private totalHits = 0;
  private searching = false;
  private searchError: string | null = null;
  /** Monotonic search id; a BROWSE_SEARCH_RESULT with a stale gen is ignored. */
  private gen = 0;

  // Filters.
  private ceTypes = new Set<string>();
  private webTypes = new Set<string>();
  private source: BrowseSource = 'all';
  private sort: BrowseSort = 'relevance';

  // Type-dropdown UI state.
  private openDropdown: DropdownKind = null;
  private typeSearch = '';

  private history: HistoryEntry[] = [];
  private displayLimit = DISPLAY_LIMIT_STEP;

  // Focus management (see render()).
  private searchInputEl: HTMLInputElement | null = null;
  private typeFilterInputEl: HTMLInputElement | null = null;
  private lastTypedAt = 0;
  private lastTypedEl: HTMLInputElement | null = null;
  private pendingFocus = false;
  private searchTimer: ReturnType<typeof setTimeout> | null = null;

  // Outside-click closer for the open dropdown.
  private outsideClickHandler: ((e: MouseEvent) => void) | null = null;

  private send: SendFn;
  private onNavigate: (rid: string) => void;

  constructor(send: SendFn, onNavigate: (rid: string) => void) {
    this.send = send;
    this.onNavigate = onNavigate;
  }

  activate() {
    this.pendingFocus = true;
    this.send({ type: 'GET_CACHE', filter: this.query });
    this.send({ type: 'GET_HISTORY' });
    this.send({ type: 'GET_FAVORITES' });
    if (this.query.trim()) this.fireSearch();
  }

  deactivate() {
    this.detachOutsideClick();
  }

  findObject(rid: string): BmpObject | null {
    return this.cacheObjects.find(o => o.rid === rid)
      ?? this.liveObjects.find(o => o.rid === rid)
      ?? null;
  }

  handleMessage(msg: InspectorMessage): boolean {
    switch (msg.type) {
      case 'CACHE_DATA':
        // Drop a late/reordered response whose filter no longer matches the
        // current query — otherwise stale cache rows (substring-filtered by the
        // SW for an older query) could render under the visible one.
        if (msg.filter != null && msg.filter !== this.query) return false;
        this.cacheObjects = msg.objects;
        return true;
      case 'BROWSE_SEARCH_RESULT':
        if (msg.gen !== this.gen) return false; // stale — a newer search superseded it
        this.searching = false;
        this.searchError = msg.ok ? null : (msg.error ?? 'Search failed');
        this.liveObjects = msg.objects ?? [];
        this.totalHits = msg.totalHits ?? this.liveObjects.length;
        return true;
      case 'HISTORY_DATA':
        this.history = msg.entries;
        return true;
      case 'FAVORITES_DATA':
        return true; // shared.favoriteEntries updated centrally; re-render
      default:
        return false;
    }
  }

  // ── Search ───────────────────────────────────────────────────────

  /** Persistent main search input — built once, never recreated by a render. */
  private getSearchInput(): HTMLInputElement {
    if (this.searchInputEl) return this.searchInputEl;
    const input = h('input', {
      class: 'bx-input', id: 'objects-search', type: 'text',
      placeholder: 'Search the workspace — name, type, ID, RID',
      autocomplete: 'off', autocorrect: 'off', spellcheck: 'false',
    }) as HTMLInputElement;
    input.addEventListener('input', () => {
      this.lastTypedAt = Date.now();
      this.lastTypedEl = input;
      this.query = input.value;
      this.displayLimit = DISPLAY_LIMIT_STEP;
      if (this.searchTimer) clearTimeout(this.searchTimer);
      this.searchTimer = setTimeout(() => {
        this.send({ type: 'GET_CACHE', filter: input.value });
        this.fireSearch();
      }, SEARCH_DEBOUNCE);
    });
    input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this.query) { this.resetQuery(); this.rerenderSelf(); }
    });
    this.searchInputEl = input;
    return input;
  }

  /** Clear the query + any pending debounce, and reset the live search. */
  private resetQuery(): void {
    if (this.searchTimer) { clearTimeout(this.searchTimer); this.searchTimer = null; }
    this.query = '';
    if (this.searchInputEl) this.searchInputEl.value = '';
    this.displayLimit = DISPLAY_LIMIT_STEP;
    this.fireSearch();
    this.send({ type: 'GET_CACHE', filter: '' });
  }

  private fireSearch(): void {
    const q = this.query.trim();
    if (!q) {
      this.gen++;
      this.searching = false;
      this.liveObjects = [];
      this.totalHits = 0;
      this.searchError = null;
      return;
    }
    this.gen++;
    this.searching = true;
    this.searchError = null;
    // Page generously so a client-side type filter still has material to show.
    this.send({ type: 'BROWSE_SEARCH', query: q, gen: this.gen, pageSize: this.typeFilterActive() ? 100 : 40 });
  }

  private typeFilterActive(): boolean {
    return this.ceTypes.size > 0 || this.webTypes.size > 0;
  }

  private results(): BrowseResult[] {
    return blendResults(this.cacheObjects, this.liveObjects, {
      ceTypes: this.ceTypes, webTypes: this.webTypes, source: this.source, sort: this.sort,
    });
  }

  // ── Render ───────────────────────────────────────────────────────

  render(container: HTMLElement) {
    const rerender = () => this.render(container);
    const hasQuery = this.query.trim().length > 0;
    const searchInput = this.getSearchInput();

    const children: (HTMLElement | null)[] = [];
    children.push(this.renderSearchShell(searchInput, hasQuery));

    if (hasQuery) {
      children.push(this.renderFilterBar());
      if (this.openDropdown) children.push(this.renderTypeDropdown());
      children.push(this.renderErrorBanner());
      children.push(this.renderResults());
    } else {
      children.push(this.renderHome());
    }

    // Persistent inputs keep their value across the wipe; only focus/caret need
    // help. captureTypingFocus reclaims the recently-typed input (search box or
    // type-filter) even if a streamed result already blurred it to <body>.
    const restoreFocus = captureTypingFocus(
      { el: this.lastTypedEl, at: this.lastTypedAt },
      (el) => container.contains(el),
    );

    render(container, ...children.filter(Boolean) as HTMLElement[]);

    if (this.pendingFocus) {
      this.pendingFocus = false;
      try { searchInput.focus({ preventScroll: true }); } catch { /* fine */ }
    } else {
      restoreFocus();
    }

    this.bindOutsideClick(container, rerender);
    this.bindDelegates(container, rerender);
  }

  private renderSearchShell(input: HTMLInputElement, hasQuery: boolean): HTMLElement {
    const blended = hasQuery ? this.results().length : 0;
    // "N of total" only when nothing client-side is narrowing the set — otherwise
    // the two numbers have different denominators (filtered shown vs raw indexed).
    const clientFiltered = this.typeFilterActive() || this.source !== 'all';
    const count = !hasQuery ? ''
      : (!clientFiltered && this.totalHits > blended) ? `${blended} of ${this.totalHits}`
      : `${blended}`;
    return h('div', { class: 'bx-shell' },
      h('span', { class: 'bx-shell-icon' }, svg(ICON_SEARCH)),
      input,
      this.searching ? h('span', { class: 'bx-spin', title: 'Searching the workspace…' }) : null,
      count ? h('span', { class: 'bx-count', title: `${blended} shown${this.totalHits > blended ? ` · ${this.totalHits} total index matches` : ''}` }, count) : null,
      hasQuery ? h('button', { class: 'bx-clear', 'data-action': 'clear-search', title: 'Clear (Esc)' }, '✕') : null,
    );
  }

  /** A non-blocking banner when the LIVE search failed — shown even if the cache
   *  still produced rows, so the user knows the workspace wasn't fully searched. */
  private renderErrorBanner(): HTMLElement | null {
    if (!this.searchError) return null;
    return h('div', { class: 'bx-state bx-state--err' }, `Workspace search unavailable: ${this.searchError}`);
  }

  private renderFilterBar(): HTMLElement {
    const allActive = !this.typeFilterActive();
    const ceLabel = this.ceTypes.size > 0 ? `Enterprise (${this.ceTypes.size})` : 'Enterprise (Ce·)';
    const webLabel = this.webTypes.size > 0 ? `Web object (${this.webTypes.size})` : 'Web object';
    const sortLabel = this.sort === 'relevance' ? 'Relevance' : this.sort === 'name' ? 'Name' : 'Type';

    return h('div', { class: 'bx-filters' },
      h('div', { class: 'bx-frow' },
        h('button', { class: `bx-fchip${allActive ? ' active' : ''}`, 'data-action': 'all-types' }, 'All types'),
        h('button', { class: `bx-dd${this.ceTypes.size > 0 ? ' active' : ''}${this.openDropdown === 'ce' ? ' open' : ''}`, 'data-action': 'toggle-ce' },
          ceLabel, h('span', { class: 'bx-dd-cv' }, '▾')),
        h('button', { class: `bx-dd${this.webTypes.size > 0 ? ' active' : ''}${this.openDropdown === 'web' ? ' open' : ''}`, 'data-action': 'toggle-web' },
          webLabel, h('span', { class: 'bx-dd-cv' }, '▾')),
      ),
      h('div', { class: 'bx-frow' },
        h('div', { class: 'bx-seg' },
          ...(['all', 'touched', 'workspace'] as BrowseSource[]).map(s =>
            h('button', { class: `bx-seg-btn${this.source === s ? ' active' : ''}`, 'data-action': 'source', 'data-source': s },
              s === 'all' ? 'All' : s === 'touched' ? 'Touched' : 'Workspace')),
        ),
        h('button', { class: 'bx-sort', 'data-action': 'sort', title: 'Cycle sort order' }, `Sort: ${sortLabel} ▾`),
      ),
    );
  }

  private renderTypeDropdown(): HTMLElement {
    const kind = this.openDropdown!;
    const all = kind === 'ce' ? CE_TYPES : WEB_OBJECT_TYPES;
    const selected = kind === 'ce' ? this.ceTypes : this.webTypes;
    const shown = filterTypeOptions(all, this.typeSearch);
    const input = this.getTypeFilterInput();
    return h('div', { class: 'bx-dd-pop' },
      h('div', { class: 'bx-dd-search' }, h('span', null, '⌕'), input),
      h('div', { class: 'bx-dd-list' },
        shown.length === 0
          ? h('div', { class: 'bx-dd-empty' }, 'No matching type')
          : null,
        ...shown.map(t =>
          h('div', { class: `bx-dd-opt${selected.has(t) ? ' on' : ''}`, 'data-action': 'type-option', 'data-type': t, 'data-fam': kind },
            h('span', { class: 'bx-dd-box' }, selected.has(t) ? '✓' : ''),
            h('span', { class: 'bx-dd-name' },
              h('span', { class: 'bx-chip bx-chip--sm', style: `--tc:${getTypeColor(t)}` }, getTypeAbbr(t)),
              t),
          )),
      ),
      h('div', { class: 'bx-dd-foot' },
        h('span', null, `${shown.length} of ${all.length}`),
        selected.size > 0 ? h('button', { class: 'bx-dd-clear', 'data-action': 'type-clear', 'data-fam': kind }, `Clear ${selected.size}`) : null,
      ),
    );
  }

  /** Persistent dropdown search input (one node, reused for whichever dropdown
   *  is open) so typing to filter types doesn't lose focus on re-render. */
  private getTypeFilterInput(): HTMLInputElement {
    if (this.typeFilterInputEl) {
      // Sync the value only when the field isn't being actively typed in (e.g.
      // on (re)open, where typeSearch was reset) — never clobber a live caret.
      if (document.activeElement !== this.typeFilterInputEl) this.typeFilterInputEl.value = this.typeSearch;
      return this.typeFilterInputEl;
    }
    const input = h('input', {
      class: 'bx-dd-in', id: 'browse-typefilter', type: 'text', placeholder: 'Filter types…',
      autocomplete: 'off', autocorrect: 'off', spellcheck: 'false',
    }) as HTMLInputElement;
    input.addEventListener('input', () => {
      this.lastTypedAt = Date.now();
      this.lastTypedEl = input;
      this.typeSearch = input.value;
      this.rerenderSelf(); // re-render the checklist; the input itself is persistent
    });
    this.typeFilterInputEl = input;
    return input;
  }

  /** A tab can't reach its container from an event handler; stash the last
   *  render container so the persistent inputs can request a re-render. */
  private lastContainer: HTMLElement | null = null;
  private rerenderSelf(): void {
    if (this.lastContainer) this.render(this.lastContainer);
  }

  private renderResults(): HTMLElement {
    const all = this.results();

    if (all.length === 0) {
      // The error (if any) is shown by the banner above; here we only cover the
      // searching and genuinely-empty states.
      if (this.searching) return h('div', { class: 'bx-state' }, h('span', { class: 'bx-spin' }), ' Searching…');
      if (this.searchError) return h('div'); // banner already explains it
      return emptyState({ variant: 'inline', body: `No matches for “${this.query}”.` });
    }

    const visible = all.slice(0, this.displayLimit);
    const out: (HTMLElement | null)[] = [h('div', { class: 'bx-list' }, ...visible.map(r => this.renderRow(r)))];
    if (all.length > this.displayLimit) {
      out.push(h('div', { class: 'bx-more' },
        `Showing ${this.displayLimit} of ${all.length} `,
        h('button', { class: 'btn btn-small', 'data-action': 'show-more' }, 'Show more'),
      ));
    }
    return h('div', null, ...out.filter(Boolean) as HTMLElement[]);
  }

  private renderRow(r: BrowseResult): HTMLElement {
    // Page-location breadcrumb, but only when it adds info — top-level pages
    // report themselves as their own location, which would just echo the name.
    const rawCrumb = r.pageName || r.webParentName || '';
    const crumb = rawCrumb && rawCrumb !== r.name ? rawCrumb : '';
    const prov = provenance(r);
    return h('div', { class: 'bx-row', 'data-action': 'row-click', 'data-rid': r.rid },
      h('span', { class: 'bx-chip', style: `--tc:${getTypeColor(r.type)}`, title: r.type ?? '' }, getTypeAbbr(r.type)),
      h('span', { class: 'bx-name', title: r.name ?? '' }, r.name ?? '(unnamed)'),
      crumb ? h('span', { class: 'bx-crumb', title: crumb }, crumb) : null,
      h('span', { class: `bx-prov bx-prov--${prov}`, title: prov === 'touched' ? 'In your cache (touched)' : 'From the workspace (live)' }),
      h('div', { class: 'bx-row-actions' },
        h('button', {
          class: 'bx-iconbtn', 'data-action': 'search-ref', 'data-rid': r.rid,
          'data-search-bid': r.businessId ?? '', 'data-search-type': r.type ?? '', 'data-search-name': r.name ?? '',
          title: 'Find references',
        }, svg(ICON_SEARCH)),
        h('button', {
          class: 'bx-iconbtn', 'data-action': 'copy',
          'data-copy': r.businessId ?? r.rid, 'data-copy-rid': r.rid, 'data-copy-type': r.type ?? '', 'data-copy-tmpl': r.templateBusinessId ?? '',
          title: COPY_TOOLTIP,
        }, svg(ICON_COPY)),
      ),
    );
  }

  private renderHome(): HTMLElement {
    const pinned = shared.favoriteEntries;
    const recent = this.history.slice(0, 8);
    const sections: (HTMLElement | null)[] = [];

    if (pinned.length > 0) {
      sections.push(h('div', { class: 'bx-rail-h' }, 'Pinned'));
      sections.push(h('div', { class: 'bx-pills' }, ...pinned.map(f => this.renderPill(f.rid, f.name, f.type, 'pinned-click'))));
    }
    if (recent.length > 0) {
      sections.push(h('div', { class: 'bx-rail-h' }, 'Recent'));
      sections.push(h('div', { class: 'bx-pills' }, ...recent.map(e => this.renderPill(e.rid, e.name, e.type, 'recent-click'))));
    }

    if (sections.length === 0) {
      return emptyState({
        variant: 'hero',
        title: 'Browse the workspace',
        body: 'Search every object by name, type, business ID, or RID — pages, scorecards, tasks, and Ce* enterprise objects. Pinned and recent items appear here as you go.',
        hint: 'Tip: toggle Inspect on a BMP page to harvest visible widgets into your cache.',
      });
    }
    return h('div', { class: 'bx-home' }, ...sections.filter(Boolean) as HTMLElement[]);
  }

  private renderPill(rid: string, name: string | undefined, type: string | undefined, action: string): HTMLElement {
    return h('button', { class: 'bx-pill', 'data-action': action, 'data-rid': rid, title: name ?? truncRid(rid) },
      h('span', { class: 'bx-chip bx-chip--sm', style: `--tc:${getTypeColor(type)}` }, getTypeAbbr(type)),
      h('span', { class: 'bx-pill-name' }, name ?? 'unnamed'),
    );
  }

  // ── Interaction ──────────────────────────────────────────────────

  private bindOutsideClick(container: HTMLElement, rerender: () => void): void {
    this.detachOutsideClick();
    if (!this.openDropdown) return;
    const handler = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('.bx-dd-pop') || t.closest('[data-action="toggle-ce"]') || t.closest('[data-action="toggle-web"]')) return;
      this.openDropdown = null;
      this.typeSearch = '';
      this.detachOutsideClick();
      rerender();
    };
    this.outsideClickHandler = handler;
    document.addEventListener('mousedown', handler, true);
  }

  private detachOutsideClick(): void {
    if (this.outsideClickHandler) {
      document.removeEventListener('mousedown', this.outsideClickHandler, true);
      this.outsideClickHandler = null;
    }
  }

  private bindDelegates(container: HTMLElement, rerender: () => void): void {
    this.lastContainer = container;
    delegate(container, {
      'clear-search': () => { this.resetQuery(); rerender(); },
      'row-click': (el, e) => {
        if ((e.target as HTMLElement).closest('[data-action="copy"], [data-action="search-ref"]')) return;
        const rid = el.dataset.rid;
        if (rid) this.onNavigate(rid);
      },
      'search-ref': (el, e) => {
        e.stopPropagation();
        const rid = el.dataset.rid;
        if (!rid) return;
        this.send({
          type: 'SEARCH_REFERENCES', rid,
          businessId: el.dataset.searchBid || undefined,
          objectType: el.dataset.searchType || undefined,
          name: el.dataset.searchName || undefined,
        });
      },
      copy: (el, e) => {
        e.stopPropagation();
        const { text } = resolveCopyText({
          rid: el.dataset.copyRid ?? el.dataset.copy ?? '',
          businessId: el.dataset.copy, type: el.dataset.copyType, templateBusinessId: el.dataset.copyTmpl,
        }, getModifier(e as MouseEvent));
        if (text) {
          copyText(text);
          el.style.color = 'var(--accent)';
          setTimeout(() => { el.style.color = ''; }, 1200);
        }
      },
      'all-types': () => { this.ceTypes.clear(); this.webTypes.clear(); this.openDropdown = null; this.displayLimit = DISPLAY_LIMIT_STEP; rerender(); },
      'toggle-ce': () => { this.openDropdown = this.openDropdown === 'ce' ? null : 'ce'; this.typeSearch = ''; rerender(); },
      'toggle-web': () => { this.openDropdown = this.openDropdown === 'web' ? null : 'web'; this.typeSearch = ''; rerender(); },
      'type-option': (el) => {
        const type = el.dataset.type; const fam = el.dataset.fam;
        if (!type) return;
        const set = fam === 'ce' ? this.ceTypes : this.webTypes;
        if (set.has(type)) set.delete(type); else set.add(type);
        this.displayLimit = DISPLAY_LIMIT_STEP;
        // A narrower type filter wants a deeper page — re-fire if active.
        if (this.query.trim()) this.fireSearch();
        rerender();
      },
      'type-clear': (el) => {
        const fam = el.dataset.fam;
        (fam === 'ce' ? this.ceTypes : this.webTypes).clear();
        this.displayLimit = DISPLAY_LIMIT_STEP;
        rerender();
      },
      source: (el) => { this.source = (el.dataset.source as BrowseSource) ?? 'all'; this.displayLimit = DISPLAY_LIMIT_STEP; rerender(); },
      sort: () => {
        this.sort = this.sort === 'relevance' ? 'name' : this.sort === 'name' ? 'type' : 'relevance';
        rerender();
      },
      'pinned-click': (el, e) => {
        if ((e.target as HTMLElement).closest('[data-action="unpin"]')) return;
        const rid = el.dataset.rid; if (rid) this.onNavigate(rid);
      },
      'recent-click': (el) => { const rid = el.dataset.rid; if (rid) this.onNavigate(rid); },
      'show-more': () => { this.displayLimit += DISPLAY_LIMIT_STEP; rerender(); },
    });
  }
}
