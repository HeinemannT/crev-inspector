/**
 * Browse tab — search-forward over cached objects. Hero search field
 * is the primary surface; pinned + recent live above as a collapsible
 * rail. The substring filter runs against the SW's object cache (a
 * true live BMP search would be a future step).
 */

import type { InspectorMessage, BmpObject, HistoryEntry } from '../../lib/types';
import { getTypeColor, getTypeAbbr } from '../../lib/types';
import { h, render, svg } from '../../lib/dom';
import { delegate } from '../delegate';
import { truncRid, copyText, relativeTime, ICON_COPY, ICON_SEARCH } from '../utils';
import { resolveCopyText, getModifier, COPY_TOOLTIP } from '../../lib/namespace';
import { DISPLAY_LIMIT_STEP, SEARCH_DEBOUNCE } from '../../lib/constants';
import { S as shared } from '../state';
import { emptyState } from '../../lib/empty-state';
import type { Tab, SendFn } from './tab-types';

export class ObjectsTab implements Tab {
  private objects: BmpObject[] = [];
  private filter = '';
  private sortColumn: 'type' | 'name' | 'id' | null = null;
  private sortAscending = true;
  private typeFilter: string | null = null;
  private history: HistoryEntry[] = [];
  private quickRailExpanded = false;
  private displayLimit = DISPLAY_LIMIT_STEP;
  /** Persistent search <input>. Built once and reused across every render so
   *  re-renders (CACHE_DATA arriving mid-type) never recreate it — recreating
   *  it reset its value to the lagging `this.filter` and dropped the caret. */
  private searchInputEl: HTMLInputElement | null = null;
  /** Timestamp of the last keystroke in the search field. Used to restore focus
   *  by *intent* after a re-render: a debounced result can arrive a tick after
   *  an unrelated render already blurred the field to <body>, so checking live
   *  focus misses it — but "typed within the last second" reliably does not. */
  private lastTypedAt = 0;
  /** Latches true on `activate()`, consumed by the first `render()` call
   *  to autofocus the search field. Avoids re-focusing on every render
   *  (which would steal the cursor + selection when CACHE_DATA arrives
   *  mid-typing). */
  private pendingFocus = false;
  private send: SendFn;
  private onNavigate: (rid: string) => void;

  constructor(send: SendFn, onNavigate: (rid: string) => void) {
    this.send = send;
    this.onNavigate = onNavigate;
  }

  activate() {
    this.pendingFocus = true;
    this.send({ type: 'GET_CACHE', filter: this.filter });
    this.send({ type: 'GET_HISTORY' });
    this.send({ type: 'GET_FAVORITES' });
  }

  deactivate() {}

  /** Lazily build the persistent search input, attaching its debounced
   *  listener exactly once (not per render — that would stack listeners on the
   *  reused node and fire GET_CACHE many times per keystroke). */
  private getSearchInput(): HTMLInputElement {
    if (this.searchInputEl) return this.searchInputEl;
    const input = h('input', {
      class: 'browse-search-input',
      id: 'objects-search',
      placeholder: 'Search by name, type, business ID, or RID',
      value: this.filter,
      autocomplete: 'off',
      autocorrect: 'off',
      spellcheck: 'false',
    }) as HTMLInputElement;
    let searchTimer: ReturnType<typeof setTimeout> | null = null;
    input.addEventListener('input', () => {
      this.lastTypedAt = Date.now();
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        this.displayLimit = DISPLAY_LIMIT_STEP;
        this.filter = input.value;
        this.send({ type: 'GET_CACHE', filter: input.value });
      }, SEARCH_DEBOUNCE);
    });
    this.searchInputEl = input;
    return input;
  }

  findObject(rid: string) {
    return this.objects.find(o => o.rid === rid) ?? null;
  }

  handleMessage(msg: InspectorMessage): boolean {
    switch (msg.type) {
      case 'CACHE_DATA':
        if (msg.objects.length > 0 || this.filter.length > 0) {
          this.objects = msg.objects;
        }
        return true;
      case 'HISTORY_DATA':
        this.history = msg.entries;
        return true;
      case 'FAVORITES_DATA':
        return true;
      default:
        return false;
    }
  }

  render(container: HTMLElement) {
    const rerender = () => this.render(container);
    const hasFilter = this.filter.trim().length > 0;

    const children: (HTMLElement | false | null)[] = [];

    // ── Quick access rail ──────────────────────────────────────────
    // Pinned + Recent live as a compact one-row strip above the
    // search field. Default collapsed; expand reveals horizontal
    // chip rows. Hidden entirely when searching — the user's intent
    // is "find something I haven't pinned", so reclaim the space.
    const pinnedCount = shared.favoriteEntries.length;
    const recentCount = this.history.length;
    const hasQuickAccess = pinnedCount + recentCount > 0;
    if (hasQuickAccess && !hasFilter) {
      const headerLabel = this.quickRailExpanded
        ? `▾ Quick access`
        : `▸ Quick access (${pinnedCount} pinned, ${recentCount} recent)`;
      const rail: (HTMLElement | false | null)[] = [
        h('button', {
          class: 'browse-quick-header',
          'data-action': 'toggle-quick-rail',
        }, headerLabel),
      ];
      if (this.quickRailExpanded) {
        if (pinnedCount > 0) {
          rail.push(h('div', { class: 'browse-quick-section' },
            h('div', { class: 'browse-quick-label' }, 'Pinned'),
            h('div', { class: 'browse-quick-chips' },
              ...shared.favoriteEntries.map(fav =>
                h('button', {
                  class: 'browse-quick-chip',
                  'data-action': 'pinned-click',
                  'data-rid': fav.rid,
                  title: fav.businessId ?? truncRid(fav.rid),
                },
                  h('span', { class: 'type-badge', style: `--type-color:${getTypeColor(fav.type)}` }, getTypeAbbr(fav.type)),
                  h('span', { class: 'browse-quick-name' }, fav.name ?? 'unnamed'),
                  h('button', {
                    class: 'browse-quick-remove',
                    'data-action': 'unpin',
                    'data-rid': fav.rid,
                    title: 'Unpin',
                  }, '✕'),
                ),
              ),
            ),
          ));
        }
        if (recentCount > 0) {
          const actionIcons: Record<string, string> = { viewed: '\u{1F441}', edited: '✏', painted: '\u{1F3A8}', 'ec-executed': '▶' };
          rail.push(h('div', { class: 'browse-quick-section' },
            h('div', { class: 'browse-quick-label' }, 'Recent'),
            h('div', { class: 'browse-quick-chips' },
              ...this.history.slice(0, 10).map(entry =>
                h('button', {
                  class: 'browse-quick-chip',
                  'data-action': 'recent-click',
                  'data-rid': entry.rid,
                  title: `${entry.action}: ${relativeTime(entry.timestamp)}`,
                },
                  h('span', { class: 'browse-quick-recent-action' }, actionIcons[entry.action] ?? '?'),
                  h('span', { class: 'type-badge', style: `--type-color:${getTypeColor(entry.type)}` }, getTypeAbbr(entry.type)),
                  h('span', { class: 'browse-quick-name' }, entry.name ?? 'unnamed'),
                ),
              ),
            ),
          ));
        }
      }
      children.push(h('div', { class: 'browse-quick-rail' }, ...rail.filter(Boolean) as HTMLElement[]));
    }

    // ── Hero search field ─────────────────────────────────────────
    // The primary surface — wide, with a leading search icon and a
    // count hint on the right. Type-filter chips render directly
    // below on demand.
    const searchInput = this.getSearchInput();
    const totalCount = this.objects.length;
    const countHint = totalCount > 0
      ? h('span', { class: 'browse-search-count' }, `${totalCount}`)
      : null;
    const clearBtn = hasFilter
      ? h('button', { class: 'browse-search-clear', 'data-action': 'clear-search', title: 'Clear search' }, '✕')
      : null;
    children.push(h('div', { class: 'browse-search-shell' },
      h('span', { class: 'browse-search-icon' }, svg(ICON_SEARCH)),
      searchInput,
      clearBtn,
      countHint,
    ));

    // ── Type filter chips ────────────────────────────────────────
    // Only shown when results exist + there's more than one type
    // worth filtering by. Keeps the toolbar quiet otherwise.
    const types = [...new Set(this.objects.map(o => o.type).filter(Boolean))] as string[];
    if (this.typeFilter && !types.includes(this.typeFilter)) this.typeFilter = null;
    if (types.length > 1) {
      types.sort();
      children.push(
        h('div', { class: 'type-chips browse-type-chips' },
          ...types.map(t =>
            h('button', {
              class: `type-chip${this.typeFilter === t ? ' active' : ''}`,
              'data-action': 'type-filter',
              'data-type': t,
            },
              h('span', { class: 'chip-dot', style: `--type-color:${getTypeColor(t)}` }),
              getTypeAbbr(t),
            ),
          ),
        ),
      );
    }

    // ── Results / empty states ───────────────────────────────────
    let filtered = this.objects;
    if (this.typeFilter) filtered = filtered.filter(o => o.type === this.typeFilter);

    if (filtered.length === 0 && this.objects.length === 0 && !hasFilter) {
      children.push(emptyState({
        variant: 'hero',
        title: 'Browse workspace objects',
        body: 'Objects appear here as you discover them on BMP pages, pin them from the detail view, or run Extended Code that returns identities. Once they’re here, search by name, type, business ID, or RID.',
        hint: 'Tip: toggle Inspect on a BMP page to harvest visible widgets, or right-click a BMP element → "Set as CREV context".',
      }));
    } else if (filtered.length === 0) {
      children.push(emptyState({
        variant: 'inline',
        body: hasFilter ? `No matches for “${this.filter}”.` : 'No objects match this filter.',
      }));
    } else {
      const sorted = filtered.slice();
      if (this.sortColumn) {
        sorted.sort((a, b) => {
          let av: string, bv: string;
          switch (this.sortColumn) {
            case 'type': av = a.type ?? ''; bv = b.type ?? ''; break;
            case 'name': av = a.name ?? ''; bv = b.name ?? ''; break;
            case 'id': av = a.businessId ?? a.rid; bv = b.businessId ?? b.rid; break;
            default: av = ''; bv = '';
          }
          return this.sortAscending ? av.localeCompare(bv) : -av.localeCompare(bv);
        });
      }

      const arrow = (col: string) => this.sortColumn === col ? (this.sortAscending ? ' ▴' : ' ▾') : '';
      const visible = sorted.slice(0, this.displayLimit);

      children.push(
        h('table', { class: 'obj-table' },
          h('thead', null,
            h('tr', null,
              h('th', { class: 'sortable', 'data-action': 'sort', 'data-sort': 'type' }, `Type${arrow('type')}`),
              h('th', { class: 'sortable', 'data-action': 'sort', 'data-sort': 'name' }, `Name${arrow('name')}`),
              h('th', { class: 'sortable', 'data-action': 'sort', 'data-sort': 'id' }, `ID${arrow('id')}`),
              h('th'),
            ),
          ),
          h('tbody', null,
            ...visible.map(obj => {
              const color = getTypeColor(obj.type);
              const display = obj.businessId ?? truncRid(obj.rid);
              return h('tr', { class: 'obj-row', 'data-action': 'row-click', 'data-rid': obj.rid },
                h('td', null, h('span', { class: 'type-badge', style: `--type-color:${color}` }, getTypeAbbr(obj.type))),
                h('td', { class: 'col-name' }, obj.name ?? ''),
                h('td', { class: 'col-id' }, display),
                h('td', { style: 'display:flex;gap:2px' },
                  h('button', {
                    class: 'copy-btn',
                    'data-action': 'search-ref',
                    'data-rid': obj.rid,
                    'data-search-bid': obj.businessId ?? '',
                    'data-search-type': obj.type ?? '',
                    'data-search-name': obj.name ?? '',
                    title: 'Find references',
                  }, svg(ICON_SEARCH)),
                  h('button', {
                    class: 'copy-btn',
                    'data-action': 'copy',
                    'data-copy': obj.businessId ?? obj.rid,
                    'data-copy-rid': obj.rid,
                    'data-copy-type': obj.type ?? '',
                    'data-copy-tmpl': obj.templateBusinessId ?? '',
                    title: COPY_TOOLTIP,
                  }, svg(ICON_COPY)),
                ),
              );
            }),
          ),
        ),
      );

      if (sorted.length > this.displayLimit) {
        children.push(
          h('div', { class: 'overflow-note' },
            `Showing ${this.displayLimit} of ${sorted.length}${this.typeFilter ? ' (filtered)' : ''} `,
            h('button', { class: 'btn btn-small', 'data-action': 'show-more' }, 'Show more'),
          ),
        );
      }
    }

    // render() clears the container, detaching the (persistent) search input and
    // dropping its focus + caret. Restore by INTENT, not live focus: an unrelated
    // render can blur the field to <body> a tick before the debounced result
    // re-renders, so `activeElement === input` is already false here. "Was the
    // user just typing?" (lastTypedAt) survives that. The input node persists, so
    // its value is never reset; we only restore focus + caret.
    const editing = document.activeElement === searchInput
      || (document.activeElement === document.body && Date.now() - this.lastTypedAt < 1000);
    const selStart = searchInput.selectionStart;
    const selEnd = searchInput.selectionEnd;

    render(container, ...children);

    if (this.pendingFocus) {
      // First render after activate() — autofocus the field.
      this.pendingFocus = false;
      try { searchInput.focus({ preventScroll: true }); } catch { /* fine */ }
    } else if (editing) {
      // Re-render while the user was typing — put focus + caret back.
      try {
        searchInput.focus({ preventScroll: true });
        if (selStart != null) searchInput.setSelectionRange(selStart, selEnd ?? selStart);
      } catch { /* fine */ }
    }

    delegate(container, {
      'pinned-click': (el, e) => {
        if ((e.target as HTMLElement).closest('[data-action="unpin"]')) return;
        const rid = el.dataset.rid;
        if (rid) this.onNavigate(rid);
      },
      unpin: (el, e) => {
        e.stopPropagation();
        const rid = el.dataset.rid;
        if (rid) this.send({ type: 'TOGGLE_FAVORITE', rid });
      },
      'toggle-quick-rail': () => { this.quickRailExpanded = !this.quickRailExpanded; rerender(); },
      'recent-click': (el) => { const rid = el.dataset.rid; if (rid) this.onNavigate(rid); },
      'clear-search': () => {
        this.filter = '';
        if (this.searchInputEl) this.searchInputEl.value = '';
        this.displayLimit = DISPLAY_LIMIT_STEP;
        this.send({ type: 'GET_CACHE', filter: '' });
        rerender();
      },
      'row-click': (el, e) => {
        if ((e.target as HTMLElement).closest('[data-action="copy"]') || (e.target as HTMLElement).closest('[data-action="search-ref"]')) return;
        const rid = el.dataset.rid;
        if (rid) this.onNavigate(rid);
      },
      'search-ref': (el, e) => {
        e.stopPropagation();
        const rid = el.dataset.rid;
        if (!rid) return;
        this.send({
          type: 'SEARCH_REFERENCES',
          rid,
          businessId: el.dataset.searchBid || undefined,
          objectType: el.dataset.searchType || undefined,
          name: el.dataset.searchName || undefined,
        });
      },
      copy: (el, e) => {
        e.stopPropagation();
        const { text } = resolveCopyText({
          rid: el.dataset.copyRid ?? el.dataset.copy ?? '',
          businessId: el.dataset.copy,
          type: el.dataset.copyType,
          templateBusinessId: el.dataset.copyTmpl,
        }, getModifier(e as MouseEvent));
        if (text) {
          copyText(text);
          el.style.color = 'var(--accent)';
          setTimeout(() => { el.style.color = ''; }, 1200);
        }
      },
      'show-more': () => { this.displayLimit += DISPLAY_LIMIT_STEP; rerender(); },
      sort: (el) => {
        const col = el.dataset.sort as 'type' | 'name' | 'id';
        if (this.sortColumn === col) { this.sortAscending = !this.sortAscending; }
        else { this.sortColumn = col; this.sortAscending = true; }
        rerender();
      },
      'type-filter': (el) => {
        const t = el.dataset.type;
        if (!t) return;
        this.displayLimit = DISPLAY_LIMIT_STEP;
        this.typeFilter = this.typeFilter === t ? null : t;
        rerender();
      },
    });
  }
}
