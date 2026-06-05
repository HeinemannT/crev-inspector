/**
 * ObjectsTab (Browse) integration tests — the message/race surface the pure
 * browse-blend tests don't reach: gen-guard staleness, error surfacing, and the
 * cache+live blend through handleMessage/render.
 *
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ObjectsTab } from '../tabs/objects-tab';
import type { InspectorMessage, BmpObject } from '../../lib/types';
import { SEARCH_DEBOUNCE } from '../../lib/constants';

const obj = (rid: string, o: Partial<BmpObject> = {}): BmpObject =>
  ({ rid, source: 'server', discoveredAt: 0, updatedAt: 0, ...o });

function setup() {
  const sent: InspectorMessage[] = [];
  const tab = new ObjectsTab((m) => sent.push(m), vi.fn());
  const panel = document.createElement('div');
  document.body.appendChild(panel);
  tab.render(panel);
  return { tab, panel, sent };
}

/** Type into the search box and let the debounce fire (advances fake timers). */
function type(panel: HTMLElement, value: string) {
  const input = panel.querySelector<HTMLInputElement>('#objects-search')!;
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  vi.advanceTimersByTime(SEARCH_DEBOUNCE + 1);
}

describe('ObjectsTab — search wiring', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ''; });

  it('fires GET_CACHE + BROWSE_SEARCH after the debounce', () => {
    const { panel, sent } = setup();
    type(panel, 'risk');
    expect(sent.find(m => m.type === 'GET_CACHE' && m.filter === 'risk')).toBeTruthy();
    const search = sent.find(m => m.type === 'BROWSE_SEARCH');
    expect(search).toMatchObject({ type: 'BROWSE_SEARCH', query: 'risk' });
  });

  it('ignores a BROWSE_SEARCH_RESULT with a stale gen', () => {
    const { tab, panel, sent } = setup();
    type(panel, 'risk');
    const gen = (sent.find(m => m.type === 'BROWSE_SEARCH') as { gen: number }).gen;

    // Stale result (older gen) must NOT change state.
    const staleChanged = tab.handleMessage({
      type: 'BROWSE_SEARCH_RESULT', query: 'risk', gen: gen - 1, ok: true,
      objects: [obj('stale', { name: 'STALE', type: 'Task' })], totalHits: 1,
    } as InspectorMessage);
    expect(staleChanged).toBe(false);
    tab.render(panel);
    expect(panel.textContent).not.toContain('STALE');

    // Current result applies.
    const freshChanged = tab.handleMessage({
      type: 'BROWSE_SEARCH_RESULT', query: 'risk', gen, ok: true,
      objects: [obj('1', { name: 'Fresh Risk', type: 'CeRiskAssessment' })], totalHits: 1,
    } as InspectorMessage);
    expect(freshChanged).toBe(true);
    tab.render(panel);
    expect(panel.querySelector('.bx-name')!.textContent).toBe('Fresh Risk');
  });

  it('surfaces a live-search failure even when the cache yields rows', () => {
    const { tab, panel } = setup();
    type(panel, 'risk');
    // Cache returns a hit…
    tab.handleMessage({ type: 'CACHE_DATA', objects: [obj('c', { name: 'Cached Risk', type: 'Task' })] } as InspectorMessage);
    // …but the live search fails.
    const gen = 1; // first fireSearch
    tab.handleMessage({ type: 'BROWSE_SEARCH_RESULT', query: 'risk', gen, ok: false, error: 'Not connected to BMP' } as InspectorMessage);
    tab.render(panel);
    expect(panel.querySelector('.bx-state--err')!.textContent).toContain('Not connected to BMP');
    // The cached row is still shown — the banner is non-blocking.
    expect(panel.textContent).toContain('Cached Risk');
  });

  it('blends cache + live, deduping by rid (no duplicate rows)', () => {
    const { tab, panel, sent } = setup();
    type(panel, 'risk');
    const gen = (sent.find(m => m.type === 'BROWSE_SEARCH') as { gen: number }).gen;
    tab.handleMessage({ type: 'CACHE_DATA', objects: [obj('1', { name: 'Shared', type: 'Task' }), obj('2', { name: 'CacheOnly', type: 'Task' })] } as InspectorMessage);
    tab.handleMessage({ type: 'BROWSE_SEARCH_RESULT', query: 'risk', gen, ok: true, objects: [obj('1', { name: 'Shared', type: 'Task' }), obj('3', { name: 'LiveOnly', type: 'Scorecard' })], totalHits: 2 } as InspectorMessage);
    tab.render(panel);
    const names = [...panel.querySelectorAll('.bx-name')].map(n => n.textContent);
    expect(names.filter(n => n === 'Shared').length).toBe(1); // deduped
    expect(names).toEqual(expect.arrayContaining(['Shared', 'CacheOnly', 'LiveOnly']));
  });

  it('drops a CACHE_DATA whose filter no longer matches the current query', () => {
    const { tab, panel } = setup();
    type(panel, 'risk'); // this.query === 'risk'
    // A late response for an older query must be ignored…
    const staleChanged = tab.handleMessage({ type: 'CACHE_DATA', filter: 'ri', objects: [obj('x', { name: 'StaleCache', type: 'Task' })] } as InspectorMessage);
    expect(staleChanged).toBe(false);
    tab.render(panel);
    expect(panel.textContent).not.toContain('StaleCache');
    // …while the matching response applies.
    const okChanged = tab.handleMessage({ type: 'CACHE_DATA', filter: 'risk', objects: [obj('y', { name: 'FreshCache', type: 'Task' })] } as InspectorMessage);
    expect(okChanged).toBe(true);
    tab.render(panel);
    expect(panel.textContent).toContain('FreshCache');
  });

  it('empty query shows the home rail, not a search', () => {
    const { tab, panel, sent } = setup();
    tab.handleMessage({ type: 'HISTORY_DATA', entries: [{ rid: '9', name: 'Recent Thing', type: 'Scorecard', action: 'viewed', timestamp: 0 }] } as InspectorMessage);
    tab.render(panel);
    expect(panel.querySelector('.bx-home')).toBeTruthy();
    expect(panel.textContent).toContain('Recent Thing');
    expect(sent.find(m => m.type === 'BROWSE_SEARCH')).toBeFalsy();
  });
});
