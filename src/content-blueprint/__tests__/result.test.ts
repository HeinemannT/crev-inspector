// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// armBox wires document-level listeners + the render cycle; the result view's geometry/state is what
// we're testing, so stub it to a no-op.
vi.mock('../gestures', () => ({ armBox: () => {} }));

import { cellState, indexBaseline, renderResult } from '../result';
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
  const base = indexBaseline(mdl([tab('t1', [container('A', 3, [widget('w1', 6)]), widget('w2', 3)])]));

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
  it('flags a DescriptionView property-source change as changed', () => {
    const view = widget('view', 6, { className: 'DescriptionView', viewTypes: [] });
    const index = indexBaseline(mdl([tab('t1', [view])]));
    expect(cellState(index, { ...view, viewTypes: ['CeIssue'] }, 't1')).toBe('changed');
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
    bp.resultAnchor = null; // the frozen canvas anchor is a session singleton — isolate it per test
  });

  const m = mdl([tab('t1', [container('A', 4, [widget('w1', 6), widget('w2', 3)]), widget('w2top', 2)])]);
  const byRid = new Map<string, Element>(
    ['r_w1', 'r_w2', 'r_w2top'].map(rid => [rid, document.createElement('div')]));

  it('renders a 12-track grid anchored to the content box, with per-node spans (2× cols.L) + nesting', () => {
    const layer = document.createElement('div');
    const ok = renderResult(m, m, byRid, layer);
    expect(ok).toBe(true);

    const wrap = layer.querySelector('.bp-result') as HTMLElement;
    expect(wrap.style.left).toBe('100px');
    expect(wrap.style.width).toBe('600px');

    const cellA = layer.querySelector('.bp-rcell[data-bpid="A"]') as HTMLElement;
    expect(cellA.dataset.bpkind).toBe('container');
    expect(cellA.style.gridColumn).toBe('span 8'); // cols.L 4 → 8 of 12 tracks
    // container nests its own sub-grid with the children
    expect(cellA.querySelectorAll('.bp-rgrid .bp-rcell').length).toBe(2);
    expect((layer.querySelector('.bp-rcell[data-bpid="w1"]') as HTMLElement).style.gridColumn).toBe('span 12');
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

  it('renders on a synthetic frame when no live widget anchors (post-apply reload / rid mismatch)', () => {
    // The model is loaded and editable, so the canvas must render even with an empty rid map —
    // the old dead-end ("no widgets are on screen") stranded a valid session. The synthetic frame
    // is NOT cached, so the next render with real widgets re-anchors to pixel alignment.
    const layer = document.createElement('div');
    expect(renderResult(m, m, new Map(), layer)).toBe(true);
    expect(layer.querySelector('.bp-result')).not.toBeNull();
    expect(bp.resultAnchor).toBeNull(); // a guessed frame must never be frozen
  });

  it('a trailing-gap cell carries data-bpafter = the row’s last cell, so a DROP inserts in order (not at the end)', () => {
    // Row sums to 5 of 6 → a 1-col trailing gap whose ordinal anchor is the row's last widget (w2).
    const part = mdl([tab('t1', [widget('w1', 3), widget('w2', 2)])]);
    const rids = new Map<string, Element>(['r_w1', 'r_w2'].map(r => [r, document.createElement('div')]));
    const layer = document.createElement('div');
    expect(renderResult(part, part, rids, layer)).toBe(true);
    const gap = layer.querySelector('.bp-rgap') as HTMLElement;
    expect(gap).not.toBeNull();
    expect(gap.dataset.bpkind).toBe('avail');
    expect(gap.dataset.bpfree).toBe('1');
    expect(gap.dataset.bpafter).toBe('w2'); // the drop path inserts after w2, keeping reading order
  });

  it('turns the selected DescriptionView body into the individual-property editor', () => {
    const description = widget('description', 6, {
      className: 'DescriptionView',
      sortVisibility: ['name'],
    });
    const descriptionModel = mdl([tab('t1', [description])]);
    bp.mode = 'layout';
    bp.selectedId = description.id;
    bp.propertySchemas.set('Scorecard', [
      { accessor: 'name', label: 'Name', configClass: 'TextMethodConfig', systemobject: true },
      { accessor: 'description', label: 'Description', configClass: 'TextMethodConfig', systemobject: true },
    ]);
    const layer = document.createElement('div');

    renderResult(descriptionModel, descriptionModel, new Map([['r_description', document.createElement('div')]]), layer);

    const cell = layer.querySelector('.bp-rcell[data-bpid="description"]')!;
    expect(cell.classList.contains('bp-rdescription-editing')).toBe(true);
    expect(cell.querySelector('.bp-dv-body.is-editing')).not.toBeNull();
    expect(cell.querySelector('.bp-dv-source code')?.textContent).toBe('Scorecard');
    expect(cell.querySelector('.bp-dv-property-name')?.textContent).toBe('Name');
    expect(cell.querySelector('[aria-label="Add visible property"]')).not.toBeNull();
  });
});

describe('renderResult — G3 style mode', () => {
  beforeEach(() => {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(
      { left: 100, top: 50, right: 700, bottom: 300, width: 600, height: 250, x: 100, y: 50, toJSON: () => ({}) } as DOMRect);
    bp.selectedId = null; bp.viewTabId = null; bp.mode = 'style'; bp.resultAnchor = null;
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
