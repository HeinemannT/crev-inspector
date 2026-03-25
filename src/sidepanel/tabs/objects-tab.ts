/**
 * Objects tab — cached objects with pinned/recent sections, search, sort, type filter.
 */

import type { InspectorMessage, BmpObject, HistoryEntry } from '../../lib/types';
import { getTypeColor, getTypeAbbr } from '../../lib/types';
import { h, render, svg } from '../../lib/dom';
import { delegate } from '../delegate';
import { truncRid, copyText, relativeTime, ICON_COPY } from '../utils';
import { resolveCopyText, getModifier, COPY_TOOLTIP } from '../../lib/namespace';
import { DISPLAY_LIMIT_STEP, SEARCH_DEBOUNCE } from '../../lib/constants';
import { S as shared } from '../state';
import type { Tab, SendFn } from './tab-types';

export class ObjectsTab implements Tab {
  private objects: BmpObject[] = [];
  private filter = '';
  private sortColumn: 'type' | 'name' | 'id' | null = null;
  private sortAscending = true;
  private typeFilter: string | null = null;
  private history: HistoryEntry[] = [];
  private historyExpanded = false;
  private displayLimit = DISPLAY_LIMIT_STEP;
  private send: SendFn;
  private onNavigate: (rid: string) => void;

  constructor(send: SendFn, onNavigate: (rid: string) => void) {
    this.send = send;
    this.onNavigate = onNavigate;
  }

  activate() {
    this.send({ type: 'GET_CACHE', filter: this.filter });
    this.send({ type: 'GET_HISTORY' });
    this.send({ type: 'GET_FAVORITES' });
  }

  deactivate() {}

  findObject(rid: string) {
    return this.objects.find(o => o.rid === rid) ?? null;
  }

  handleMessage(msg: InspectorMessage): boolean {
    switch (msg.type) {
      case 'CACHE_DATA':
        this.objects = msg.objects;
        return true;
      case 'HISTORY_DATA':
        this.history = msg.entries;
        return true;
      case 'FAVORITES_DATA':
        // Shared state — orchestrator writes S.favoriteEntries, we just re-render
        return true;
      default:
        return false;
    }
  }

  render(container: HTMLElement) {
    const rerender = () => this.render(container);

    const searchInput = h('input', {
      class: 'search-input',
      id: 'objects-search',
      placeholder: 'Search by RID, name, type, or ID...',
      value: this.filter,
    }) as HTMLInputElement;

    const children: (HTMLElement | false | null)[] = [];

    // Pinned (favorites)
    if (shared.favoriteEntries.length > 0) {
      children.push(
        h('div', { class: 'pinned-section' },
          h('div', { class: 'section-title section-title--flush' }, '\u2605 Pinned'),
          ...shared.favoriteEntries.map(fav =>
            h('div', { class: 'pinned-row', 'data-action': 'pinned-click', 'data-rid': fav.rid },
              h('span', { class: 'type-badge', style: `background:${getTypeColor(fav.type)}` }, getTypeAbbr(fav.type)),
              h('span', { class: 'pinned-name' }, fav.name ?? 'unnamed'),
              h('span', { class: 'pinned-bid' }, fav.businessId ?? truncRid(fav.rid)),
              h('button', { class: 'pinned-remove', 'data-action': 'unpin', 'data-rid': fav.rid, title: 'Remove from pinned' }, '\u2715'),
            ),
          ),
        ),
      );
    }

    // Recent (history)
    if (this.history.length > 0) {
      const actionIcons: Record<string, string> = { viewed: '\u{1F441}', edited: '\u270F', painted: '\u{1F3A8}', 'ec-executed': '\u25B6' };
      children.push(
        h('div', { class: `recent-section${this.historyExpanded ? ' expanded' : ''}` },
          h('div', { class: 'section-title section-title--flush recent-header', 'data-action': 'toggle-history' },
            this.historyExpanded ? `\u25BE Recent (${this.history.length})` : `\u25B8 Recent (${this.history.length})`,
          ),
          this.historyExpanded && h('div', { class: 'recent-list' },
            ...this.history.map(entry =>
              h('div', { class: 'recent-row', 'data-action': 'recent-click', 'data-rid': entry.rid },
                h('span', { class: 'recent-action' }, actionIcons[entry.action] ?? '?'),
                h('span', { class: 'type-badge', style: `background:${getTypeColor(entry.type)}` }, getTypeAbbr(entry.type)),
                h('span', { class: 'recent-name' }, entry.name ?? 'unnamed'),
                h('span', { class: 'recent-time' }, relativeTime(entry.timestamp)),
              ),
            ),
          ),
        ),
      );
    }

    children.push(searchInput);

    // Type filter chips
    const types = [...new Set(this.objects.map(o => o.type).filter(Boolean))] as string[];
    if (this.typeFilter && !types.includes(this.typeFilter)) this.typeFilter = null;
    if (types.length > 1) {
      types.sort();
      children.push(
        h('div', { class: 'type-chips' },
          ...types.map(t =>
            h('button', {
              class: `type-chip${this.typeFilter === t ? ' active' : ''}`,
              'data-action': 'type-filter',
              'data-type': t,
            },
              h('span', { class: 'chip-dot', style: `background:${getTypeColor(t)}` }),
              getTypeAbbr(t),
            ),
          ),
        ),
      );
    }

    // Filter + sort
    let filtered = this.objects;
    if (this.typeFilter) filtered = filtered.filter(o => o.type === this.typeFilter);

    if (filtered.length === 0 && this.objects.length === 0) {
      children.push(h('div', { class: 'empty-state' }, 'No objects detected yet.', h('br'), 'Toggle inspect on a BMP page to discover objects.'));
    } else if (filtered.length === 0) {
      children.push(h('div', { class: 'empty-state' }, 'No objects match this filter'));
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

      const arrow = (col: string) => this.sortColumn === col ? (this.sortAscending ? ' \u25B4' : ' \u25BE') : '';
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
                h('td', null, h('span', { class: 'type-badge', style: `background:${color}` }, getTypeAbbr(obj.type))),
                h('td', { class: 'col-name' }, obj.name ?? ''),
                h('td', { class: 'col-id' }, display),
                h('td', null,
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

    render(container, ...children);

    let searchTimer: ReturnType<typeof setTimeout> | null = null;
    searchInput.addEventListener('input', () => {
      if (searchTimer) clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        this.displayLimit = DISPLAY_LIMIT_STEP;
        this.filter = searchInput.value;
        this.send({ type: 'GET_CACHE', filter: searchInput.value });
      }, SEARCH_DEBOUNCE);
    });

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
      'toggle-history': () => { this.historyExpanded = !this.historyExpanded; rerender(); },
      'recent-click': (el) => { const rid = el.dataset.rid; if (rid) this.onNavigate(rid); },
      'row-click': (el, e) => {
        if ((e.target as HTMLElement).closest('[data-action="copy"]')) return;
        const rid = el.dataset.rid;
        if (rid) this.onNavigate(rid);
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
          el.style.color = 'var(--md-primary)';
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
