import { getTypeColor, getTypeAbbr } from '../../lib/types';
import { h, render, svg } from '../../lib/dom';
import { delegate } from '../delegate';
import { truncRid, copyText, ICON_COPY } from '../utils';
import { S, sendMessage } from '../state';
import { DISPLAY_LIMIT_STEP, SEARCH_DEBOUNCE } from '../../lib/constants';

let displayLimit = DISPLAY_LIMIT_STEP;

export function renderObjectsTab(navigateToDetail: (rid: string) => void) {
  const panel = document.getElementById('panel-objects');
  if (!panel) return;

  const searchInput = h('input', {
    class: 'search-input',
    id: 'objects-search',
    placeholder: 'Search by RID, name, type, or ID...',
    value: S.cacheFilter,
  }) as HTMLInputElement;

  const children: (HTMLElement | false | null)[] = [searchInput];

  // Type filter chips
  const types = [...new Set(S.cacheObjects.map(o => o.type).filter(Boolean))] as string[];
  if (S.typeFilter && !types.includes(S.typeFilter)) S.typeFilter = null;
  if (types.length > 1) {
    types.sort();
    children.push(
      h('div', { class: 'type-chips' },
        ...types.map(t =>
          h('button', {
            class: `type-chip${S.typeFilter === t ? ' active' : ''}`,
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
  let filtered = S.cacheObjects;
  if (S.typeFilter) filtered = filtered.filter(o => o.type === S.typeFilter);

  if (filtered.length === 0 && S.cacheObjects.length === 0) {
    children.push(h('div', { class: 'empty-state' }, 'No objects detected yet.', h('br'), 'Toggle inspect on a BMP page to discover objects.'));
  } else if (filtered.length === 0) {
    children.push(h('div', { class: 'empty-state' }, 'No objects match this filter'));
  } else {
    const sorted = filtered.slice();
    if (S.sortColumn) {
      sorted.sort((a, b) => {
        let av: string, bv: string;
        switch (S.sortColumn) {
          case 'type': av = a.type ?? ''; bv = b.type ?? ''; break;
          case 'name': av = a.name ?? ''; bv = b.name ?? ''; break;
          case 'id': av = a.businessId ?? a.rid; bv = b.businessId ?? b.rid; break;
          default: av = ''; bv = '';
        }
        const cmp = av.localeCompare(bv);
        return S.sortAscending ? cmp : -cmp;
      });
    }

    const arrow = (col: string) => S.sortColumn === col ? (S.sortAscending ? ' \u25B4' : ' \u25BE') : '';
    const visible = sorted.slice(0, displayLimit);

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
                  title: 'Copy',
                }, svg(ICON_COPY)),
              ),
            );
          }),
        ),
      ),
    );

    if (sorted.length > displayLimit) {
      children.push(
        h('div', { class: 'overflow-note' },
          `Showing ${displayLimit} of ${sorted.length}${S.typeFilter ? ' (filtered)' : ''} `,
          h('button', { class: 'btn btn-small', 'data-action': 'show-more' }, 'Show more'),
        ),
      );
    }
  }

  render(panel, ...children);

  // Search input event (not delegated — needs input event, not click)
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  searchInput.addEventListener('input', () => {
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      displayLimit = DISPLAY_LIMIT_STEP;
      S.cacheFilter = searchInput.value;
      sendMessage({ type: 'GET_CACHE', filter: searchInput.value });
    }, SEARCH_DEBOUNCE);
  });

  const rerender = () => renderObjectsTab(navigateToDetail);

  delegate(panel, {
    'row-click': (el, e) => {
      if ((e.target as HTMLElement).closest('[data-action="copy"]')) return;
      const rid = el.dataset.rid;
      if (rid) navigateToDetail(rid);
    },
    copy: (el, e) => {
      e.stopPropagation();
      const text = el.dataset.copy;
      if (text) {
        copyText(text);
        el.style.color = 'var(--md-primary)';
        setTimeout(() => { el.style.color = ''; }, 1200);
      }
    },
    'show-more': () => {
      displayLimit += DISPLAY_LIMIT_STEP;
      rerender();
    },
    sort: (el) => {
      const col = el.dataset.sort as 'type' | 'name' | 'id';
      if (S.sortColumn === col) {
        S.sortAscending = !S.sortAscending;
      } else {
        S.sortColumn = col;
        S.sortAscending = true;
      }
      rerender();
    },
    'type-filter': (el) => {
      const t = el.dataset.type;
      if (!t) return;
      displayLimit = DISPLAY_LIMIT_STEP;
      S.typeFilter = S.typeFilter === t ? null : t;
      rerender();
    },
  });
}
