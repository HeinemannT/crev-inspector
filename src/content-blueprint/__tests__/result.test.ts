// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest';

// armBox wires document-level listeners + the render cycle; the result view's geometry/state is what
// we're testing, so stub it to a no-op.
vi.mock('../gestures', () => ({ armBox: () => {} }));

import { cellState, renderResult } from '../result';
import { bp } from '../state';
import type { LModel, LNode } from '../../lib/layout/types';

const widget = (id: string, colsL: number, extra: Partial<LNode> = {}): LNode =>
  ({ id, rid: `r_${id}`, kind: 'widget', className: 'TextElement', name: id, cols: { L: colsL }, children: [], ...extra });
const container = (id: string, colsL: number, children: LNode[]): LNode =>
  ({ id, rid: `r_${id}`, kind: 'container', className: 'Container', name: id, cols: { L: colsL }, children });
const tab = (id: string, children: LNode[]): LNode =>
  ({ id, rid: `r_${id}`, kind: 'tab', className: 'Tab', name: id, cols: { L: 6 }, children });
const mdl = (tabs: LNode[]): LModel =>
  ({ pageId: 'sc1', tabsetId: 'ts1', pageClass: 'Scorecard', tabs, target: 'instance', hasTemplate: false });

describe('cellState (result-view diff classification)', () => {
  const base = mdl([tab('t1', [container('A', 3, [widget('w1', 6)]), widget('w2', 3)])]);

  it('flags a temp-id node as new', () => {
    expect(cellState(base, widget('box:9', 6), 't1')).toBe('new');
  });
  it('flags an id absent from baseline as new', () => {
    expect(cellState(base, widget('w99', 6), 't1')).toBe('new');
  });
  it('flags a node whose parent changed as moved', () => {
    // w1 was under A in baseline; now reported under t1
    expect(cellState(base, widget('w1', 6), 't1')).toBe('moved');
  });
  it('flags a width/name/height change as changed (same parent)', () => {
    expect(cellState(base, widget('w2', 5), 't1')).toBe('changed');          // 3 -> 5
    expect(cellState(base, widget('w2', 3, { name: 'renamed' }), 't1')).toBe('changed');
  });
  it('flags an unchanged node in place as same', () => {
    expect(cellState(base, widget('w2', 3), 't1')).toBe('same');
  });
});

describe('renderResult (CSS-grid mirror)', () => {
  // jsdom returns a zero rect by default; stub a non-empty box so unionRect can anchor the active tab.
  beforeEach(() => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(
      { left: 100, top: 50, right: 700, bottom: 300, width: 600, height: 250, x: 100, y: 50, toJSON: () => ({}) } as DOMRect);
    bp.selectedId = null;
  });

  const m = mdl([tab('t1', [container('A', 4, [widget('w1', 6), widget('w2', 3)]), widget('w2top', 2)])]);
  const byRid = new Map<string, Element>(
    ['r_w1', 'r_w2', 'r_w2top'].map(rid => [rid, document.createElement('div')]));

  it('renders a 6-col grid anchored to the content box, with per-node spans + nesting', () => {
    const layer = document.createElement('div');
    const ok = renderResult(m, m, byRid, layer);
    expect(ok).toBe(true);

    const wrap = layer.querySelector('.bp-result') as HTMLElement;
    expect(wrap.style.left).toBe('100px');
    expect(wrap.style.width).toBe('600px');

    const cellA = layer.querySelector('.bp-rcell[data-bpid="A"]') as HTMLElement;
    expect(cellA.dataset.bpkind).toBe('container');
    expect(cellA.style.gridColumn).toBe('span 4');
    // container nests its own sub-grid with the children
    expect(cellA.querySelectorAll('.bp-rgrid .bp-rcell').length).toBe(2);
    expect((layer.querySelector('.bp-rcell[data-bpid="w1"]') as HTMLElement).style.gridColumn).toBe('span 6');
  });

  it('renders ALL tabs stacked (cross-tab), marking only the active one, active first', () => {
    // t1 has the live widgets (in byRid) → active; t2 has none → inactive but still rendered.
    const multi = mdl([
      tab('t1', [widget('w1', 6)]),
      tab('t2', [widget('z1', 6)]),
    ]);
    const layer = document.createElement('div');
    expect(renderResult(multi, multi, byRid, layer)).toBe(true);
    const secs = [...layer.querySelectorAll('.bp-rtab-sec')];
    expect(secs).toHaveLength(2);
    // active tab section comes first and is marked; each header is a move-to-tab drop target
    const heads = secs.map(s => s.querySelector('.bp-rtab-h') as HTMLElement);
    expect(heads[0].dataset.bpid).toBe('t1');
    expect(heads[0].classList.contains('active')).toBe(true);
    expect(heads[1].dataset.bpid).toBe('t2');
    expect(heads[1].classList.contains('active')).toBe(false);
    expect(heads.every(h => h.dataset.bpkind === 'avail')).toBe(true);
    // the inactive tab's widget renders from the model even with no live DOM
    expect(layer.querySelector('.bp-rcell[data-bpid="z1"]')).not.toBeNull();
  });

  it('exposes add affordances: a + on each container and a tab-level add/drop zone', () => {
    const layer = document.createElement('div');
    renderResult(m, m, byRid, layer);
    // container "A" carries a + add button
    expect(layer.querySelector('.bp-rcell[data-bpid="A"] .bp-radd')).not.toBeNull();
    // the root grid ends with a tab-level add zone that is ALSO a move drop-target (kind=avail)
    const zone = layer.querySelector('.bp-radd-zone') as HTMLElement;
    expect(zone).not.toBeNull();
    expect(zone.dataset.bpid).toBe('t1');
    expect(zone.dataset.bpkind).toBe('avail');
  });

  it('returns false when no active tab has live widgets (nothing to anchor to)', () => {
    const layer = document.createElement('div');
    expect(renderResult(m, m, new Map(), layer)).toBe(false);
    expect(layer.querySelector('.bp-result')).toBeNull();
  });
});
