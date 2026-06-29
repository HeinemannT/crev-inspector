// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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
  it('flags a node listed in the reordered set as moved', () => {
    // swapped within its container but otherwise unchanged — cellState alone reads 'same',
    // the reordered set (computed in renderResult) is what lights it up.
    expect(cellState(base, widget('w2', 3), 't1', new Set(['w2']))).toBe('moved');
    expect(cellState(base, widget('w2', 3), 't1', new Set(['other']))).toBe('same');
  });
});

describe('renderResult (CSS-grid mirror)', () => {
  // jsdom returns a zero rect by default; stub a non-empty box so unionRect can anchor the active tab.
  beforeEach(() => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(
      { left: 100, top: 50, right: 700, bottom: 300, width: 600, height: 250, x: 100, y: 50, toJSON: () => ({}) } as DOMRect);
    bp.selectedId = null;
    bp.viewTabId = null;
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

  it('renders ONE tab at a time — the first tab by default, the passed viewedId when given', () => {
    // The canvas shows one tab; the caller (view.render) resolves which and passes it as viewedId. No
    // per-tab section headers in the canvas anymore.
    const multi = mdl([
      tab('t1', [widget('w1', 6)]),
      tab('t2', [widget('z1', 6)]),
    ]);
    const layer = document.createElement('div');
    expect(renderResult(multi, multi, byRid, layer)).toBe(true);
    // default (no viewedId) → first tab t1: its widget renders, the other tab's does not, no sections
    expect(layer.querySelector('.bp-rcell[data-bpid="w1"]')).not.toBeNull();
    expect(layer.querySelector('.bp-rcell[data-bpid="z1"]')).toBeNull();
    expect(layer.querySelector('.bp-rtab-sec')).toBeNull();

    // pass viewedId t2 → now t2's widget renders (from the model, even with no live DOM) and t1's doesn't
    const layer2 = document.createElement('div');
    expect(renderResult(multi, multi, byRid, layer2, 't2')).toBe(true);
    expect(layer2.querySelector('.bp-rcell[data-bpid="z1"]')).not.toBeNull();
    expect(layer2.querySelector('.bp-rcell[data-bpid="w1"]')).toBeNull();
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

describe('renderResult — G3 style mode', () => {
  beforeEach(() => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(
      { left: 100, top: 50, right: 700, bottom: 300, width: 600, height: 250, x: 100, y: 50, toJSON: () => ({}) } as DOMRect);
    bp.selectedId = null; bp.viewTabId = null; bp.mode = 'style';
  });
  afterEach(() => { bp.mode = 'layout'; });

  const byRid = new Map<string, Element>([['r_w1', document.createElement('div')]]);

  it('paints a styled cell with the appearance classes (shadow / border / header-drop)', () => {
    const styled = widget('w1', 6, { style: { shadow: true, borderStyle: 'NONE', headerStyle: 'NONE' } });
    const base = mdl([tab('t1', [widget('w1', 6)])]);          // baseline: no style
    const desired = mdl([tab('t1', [styled])]);
    const layer = document.createElement('div');
    renderResult(base, desired, byRid, layer);
    const cell = layer.querySelector('.bp-rcell[data-bpid="w1"]') as HTMLElement;
    expect(cell.classList.contains('bp-styled')).toBe(true);
    expect(cell.classList.contains('bp-sh-on')).toBe(true);
    expect(cell.classList.contains('bp-bd-none')).toBe(true);
    expect(cell.classList.contains('bp-hdr-none')).toBe(true);
    // its appearance differs from baseline → the edited ring
    expect(cell.classList.contains('bp-style-dirty')).toBe(true);
  });

  it('does NOT ring a cell whose style equals the baseline', () => {
    const same = widget('w1', 6, { style: { shadow: true } });
    const m2 = mdl([tab('t1', [same])]);
    const layer = document.createElement('div');
    renderResult(m2, m2, byRid, layer);                        // base === desired
    const cell = layer.querySelector('.bp-rcell[data-bpid="w1"]') as HTMLElement;
    expect(cell.classList.contains('bp-styled')).toBe(true);   // still painted
    expect(cell.classList.contains('bp-style-dirty')).toBe(false);
  });

  it('layout mode never paints style', () => {
    bp.mode = 'layout';
    const styled = widget('w1', 6, { style: { shadow: true } });
    const m2 = mdl([tab('t1', [styled])]);
    const layer = document.createElement('div');
    renderResult(m2, m2, byRid, layer);
    const cell = layer.querySelector('.bp-rcell[data-bpid="w1"]') as HTMLElement;
    expect(cell.classList.contains('bp-styled')).toBe(false);
    expect(cell.classList.contains('bp-sh-on')).toBe(false);
  });
});
