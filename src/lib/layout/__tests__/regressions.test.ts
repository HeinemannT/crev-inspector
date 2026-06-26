import { describe, it, expect } from 'vitest';
import type { LModel, LNode } from '../types';
import { findNode } from '../model';
import { resize, addContainer, addWidget, move, swap } from '../edit';
import { diff } from '../diff';
import { compile } from '../ec';

const n = (p: Partial<LNode> & Pick<LNode, 'id' | 'kind' | 'className'>): LNode => ({ name: p.id, cols: { L: 6 }, children: [], ...p });
const model = (...tabs: LNode[]): LModel => ({
  scorecardId: '4957', scorecardClass: 'Scorecard', tabsetId: 'ts1', tabs, target: 'template', hasTemplate: true,
});

// Regression guards for the senior-dev review findings (all reproduced before the fixes).
describe('review regressions', () => {
  it('P2-A: created nodes carry their M/S responsive widths into the add() EC', () => {
    const base = model(n({ id: 'tab1', kind: 'tab', className: 'Tab', children: [] }));
    const box = addContainer(base, 'tab1', 0, 3);
    let d = resize(box.model, box.id, 'M', 2);
    d = resize(d, box.id, 'S', 6);
    const { script } = compile(diff(base, d), d);
    expect(script).toContain('columnsLargeScreen := 3, columnsMediumScreen := 2, columnsSmallScreen := 6');
  });

  it('P2-B: a new parent receiving a created child + a reparented-in existing child gets ordered', () => {
    const base = model(n({ id: 'tab1', kind: 'tab', className: 'Tab', children: [
      n({ id: 'wExist', kind: 'widget', className: 'ExtendedTable' }),
    ] }));
    const box = addContainer(base, 'tab1', 0, 6);     // create container
    let d = addWidget(box.model, box.id, 0, 'PieChart').model; // create widget into it  -> [wNew]
    d = move(d, 'wExist', box.id, 0);                 // move existing widget in at front -> desired [wExist, wNew]
    const { script } = compile(diff(base, d), d);
    // without the fix there is no moveAfter and BMP would render [wNew, wExist] (reversed)
    expect(script).toContain('.moveAfter(t.wExist)');
  });

  it('P2-C: move via the *tab-root* sentinel lands the widget in its tab, not the tabs array', () => {
    const base = model(n({ id: 'tab1', kind: 'tab', className: 'Tab', children: [
      n({ id: 'box1', kind: 'container', className: 'Container', cols: { L: 3 }, children: [
        n({ id: 'w1', kind: 'widget', className: 'BarChart' }),
      ] }),
    ] }));
    const d = move(base, 'w1', '*tab-root*', 0);
    expect(findNode(d, 'w1')!.parent!.id).toBe('tab1');
    expect(d.tabs.some(t => t.id === 'w1')).toBe(false);
  });

  it('P3-G: swapping a node with its own descendant is a no-op (no orphaning)', () => {
    const base = model(n({ id: 'tab1', kind: 'tab', className: 'Tab', children: [
      n({ id: 'box1', kind: 'container', className: 'Container', children: [
        n({ id: 'w1', kind: 'widget', className: 'BarChart' }),
      ] }),
    ] }));
    const d = swap(base, 'box1', 'w1'); // box1 is an ancestor of w1
    expect(findNode(d, 'box1')).not.toBeNull();
    expect(findNode(d, 'w1')!.parent!.id).toBe('box1');
  });
});
