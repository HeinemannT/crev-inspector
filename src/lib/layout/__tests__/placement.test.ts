/**
 * Slot placement + the band invariant on edits — the pieces that fix "place in a free slot
 * sometimes doesn't work": drops resolve through the band model (unreachable slots refuse with a
 * reason), adds remap to the nearest legal index, and every edit primitive re-normalizes so the
 * raw children order can never drift from BMP's rendered order.
 */
import { describe, it, expect } from 'vitest';
import { resolveGapPlacement, bandInsertIndex } from '../placement';
import { insertRelative, moveInto, addContainer } from '../edit';
import type { LModel, LNode } from '../types';

const widget = (id: string, L = 3): LNode =>
  ({ id, kind: 'widget', className: 'TextElement', name: id, cols: { L }, children: [] });
const container = (id: string, L = 3, children: LNode[] = []): LNode =>
  ({ id, kind: 'container', className: 'Container', name: id, cols: { L }, children });
const tab = (id: string, children: LNode[]): LNode =>
  ({ id, kind: 'tab', className: 'Tab', name: id, cols: { L: 6 }, children });
const mdl = (children: LNode[]): LModel =>
  ({ pageId: 'p', tabsetId: 'ts', pageClass: 'Scorecard', tabs: [tab('t1', children)], target: 'instance', hasTemplate: false });

const tabIds = (m: LModel) => m.tabs[0].children.map(c => c.id);

describe('resolveGapPlacement', () => {
  const kids = [container('c1', 3), container('c2', 2), widget('w1', 3), widget('w2', 2)];

  it('same band → insert after the anchor', () => {
    expect(resolveGapPlacement(kids, 'w1', 'widget')).toEqual({ ok: true, mode: 'after', targetId: 'w1' });
    expect(resolveGapPlacement(kids, 'c1', 'container')).toEqual({ ok: true, mode: 'after', targetId: 'c1' });
  });

  it('widget onto the LAST container’s gap is legal — it leads the widget band on that row', () => {
    expect(resolveGapPlacement(kids, 'c2', 'widget')).toEqual({ ok: true, mode: 'after', targetId: 'c2' });
  });

  it('widget onto an EARLIER container’s gap is refused (the slot sits between containers)', () => {
    const r = resolveGapPlacement(kids, 'c1', 'widget');
    expect(r.ok).toBe(false);
  });

  it('container onto a widget-anchored gap is refused (containers render first)', () => {
    const r = resolveGapPlacement(kids, 'w2', 'container');
    expect(r.ok).toBe(false);
  });

  it('no anchor (empty container / add zone) → append into', () => {
    expect(resolveGapPlacement(kids, undefined, 'widget')).toEqual({ ok: true, mode: 'into' });
  });
});

describe('bandInsertIndex (add-picker flows)', () => {
  const kids = [container('c1'), container('c2'), widget('w1'), widget('w2')];

  it('same-band anchor → right after it, no remap', () => {
    expect(bandInsertIndex(kids, 'c1', 'container')).toEqual({ index: 1, remapped: false });
    expect(bandInsertIndex(kids, 'w1', 'widget')).toEqual({ index: 3, remapped: false });
  });

  it('widget after the LAST container = head of the widget band, not a remap', () => {
    expect(bandInsertIndex(kids, 'c2', 'widget')).toEqual({ index: 2, remapped: false });
  });

  it('cross-band anchors remap to the band boundary, flagged', () => {
    expect(bandInsertIndex(kids, 'c1', 'widget')).toEqual({ index: 2, remapped: true });
    expect(bandInsertIndex(kids, 'w1', 'container')).toEqual({ index: 2, remapped: true });
  });

  it('no anchor → end of the node’s own band', () => {
    expect(bandInsertIndex(kids, undefined, 'widget')).toEqual({ index: 4, remapped: false });
    expect(bandInsertIndex(kids, undefined, 'container')).toEqual({ index: 2, remapped: false });
  });
});

describe('edit primitives enforce canonical band order (the safety net under the resolver)', () => {
  it('insertRelative can no longer strand a widget between containers', () => {
    const m = mdl([container('c1'), container('c2'), widget('w1')]);
    // a (hypothetically unguarded) "insert w1 after c1" splice would give [c1, w1, c2]
    const next = insertRelative(m, 'w1', 'c1', false);
    expect(tabIds(next)).toEqual(['c1', 'c2', 'w1']);
  });

  it('insert after the LAST container lands the widget at the head of the widget band', () => {
    const m = mdl([container('c1'), container('c2'), widget('w1'), widget('w2')]);
    const next = insertRelative(m, 'w2', 'c2', false);
    expect(tabIds(next)).toEqual(['c1', 'c2', 'w2', 'w1']);
  });

  it('moveInto appends within the node’s band, not after the widgets', () => {
    const m = mdl([container('c1', 3, [container('inner')]), widget('w1')]);
    const next = moveInto(m, 'inner', 't1'); // raw append would give [c1, w1, inner]
    expect(tabIds(next)).toEqual(['c1', 'inner', 'w1']);
  });

  it('addContainer at a widget-band index normalizes back to the container band', () => {
    const m = mdl([container('c1'), widget('w1')]);
    const r = addContainer(m, 't1', 2, 3); // raw index after the widget
    expect(tabIds(r.model)).toEqual(['c1', r.id, 'w1']);
  });
});
