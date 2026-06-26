import { describe, it, expect } from 'vitest';
import type { LayoutNode as WireNode } from '../../types';
import type { LModel, LNode } from '../types';
import { reconstruct, findNode, descendantWidgets, isChart } from '../model';
import { resize, setHeight, rename, move, swap, insertRelative, addWidget, addContainer, addTab, remove, moveToTab } from '../edit';
import { diff } from '../diff';
import { compile } from '../ec';
import { guard, lint, checkReorder, checkHeight, checkAddTarget } from '../constraints';
import { History } from '../history';

// ── factories ────────────────────────────────────────────────────────────────
const n = (p: Partial<LNode> & Pick<LNode, 'id' | 'kind' | 'className'>): LNode => ({
  name: p.id, cols: { L: 6 }, children: [], ...p,
});
const model = (...tabs: LNode[]): LModel => ({
  pageId: '4957', pageRid: 'rsc', pageClass: 'Scorecard', tabsetId: 'ts1',
  tabs, target: 'template', hasTemplate: true,
});
const demo = () => model(n({
  id: 'tab1', kind: 'tab', className: 'Tab', name: 'Overview', children: [
    n({ id: 'box1', kind: 'container', className: 'Container', name: 'KPIs', cols: { L: 3 }, children: [
      n({ id: 'w1', kind: 'widget', className: 'BarChart', name: 'Bar', height: 200 }),
    ] }),
    n({ id: 'rw', kind: 'widget', className: 'RiskList', name: 'Register', cols: { L: 4 } }),
  ],
}));

describe('model.reconstruct', () => {
  it('folds the flat wire tree, containers-first', () => {
    const wire: WireNode[] = [
      { rid: 'r_ts', businessId: 'ts1', type: 'TabSet' },
      { rid: 'r_tab', businessId: 'tab1', type: 'Tab', parentRid: 'r_ts', columnsLargeScreen: 6, name: 'Overview' },
      { rid: 'r_box', businessId: 'box1', type: 'Container', parentRid: 'r_tab', columnsLargeScreen: 3, name: 'KPIs' },
      { rid: 'r_w', businessId: 'w1', type: 'CustomVisualization', containerRid: 'r_box', columnsLargeScreen: 6, name: 'Chart' },
      { rid: 'r_tw', businessId: 'tw1', type: 'ExtendedTable', containerRid: 'r_tab', columnsLargeScreen: 6, name: 'Table' },
    ];
    const m = reconstruct(wire, { pageId: '4957', tabsetId: 'ts1' });
    expect(m.tabs).toHaveLength(1);
    const kids = m.tabs[0].children;
    expect(kids.map(c => c.kind)).toEqual(['container', 'widget']); // containers first
    expect(kids[0].children[0].name).toBe('Chart');
    expect(m.tabs[0].children[0].cols.L).toBe(3);
  });
});

describe('edit engine (pure, returns new model)', () => {
  it('resize clamps and is immutable', () => {
    const a = demo();
    const b = resize(a, 'w1', 'L', 9);
    expect(findNode(b, 'w1')!.node.cols.L).toBe(6);
    expect(findNode(a, 'w1')!.node.cols.L).toBe(6); // original untouched
  });
  it('setHeight only applies to chart/URLView', () => {
    const a = demo();
    expect(findNode(setHeight(a, 'w1', 300), 'w1')!.node.height).toBe(300); // BarChart
    expect(findNode(setHeight(a, 'rw', 300), 'rw')!.node.height).toBeUndefined(); // RiskList: no height
  });
  it('move reparents and PRESERVES width (widget width is within the container\'s own 6-col grid)', () => {
    const b = move(demo(), 'rw', 'box1', 0); // RiskList (L4) into KPIs (L3 container)
    const f = findNode(b, 'rw')!;
    expect(f.parent!.id).toBe('box1');
    expect(f.node.cols.L).toBe(4); // NOT clamped to the container's page-width — verified live
  });
  it('swap exchanges positions across containers', () => {
    const a = model(n({ id: 't', kind: 'tab', className: 'Tab', children: [
      n({ id: 'A', kind: 'widget', className: 'X' }), n({ id: 'B', kind: 'widget', className: 'Y' }),
    ] }));
    const b = swap(a, 'A', 'B');
    expect(b.tabs[0].children.map(c => c.id)).toEqual(['B', 'A']);
  });
  it('delete container re-homes its widgets to the tab (no RESULT orphan)', () => {
    const b = remove(demo(), 'box1');
    expect(findNode(b, 'box1')).toBeNull();
    const w1 = findNode(b, 'w1');
    expect(w1).not.toBeNull();
    expect(w1!.parent!.id).toBe('tab1'); // re-homed to the tab
  });
  it('addWidget / addContainer / addTab mint temp ids', () => {
    const { model: m1, id } = addWidget(demo(), 'tab1', 1, 'PieChart');
    expect(id).toMatch(/^w:/);
    expect(findNode(m1, id)!.node.kind).toBe('widget');
    expect(addContainer(demo(), 'tab1', 0).id).toMatch(/^box:/);
    expect(addTab(demo(), 0).id).toMatch(/^tab:/);
  });
});

describe('diff + ec compile', () => {
  it('refuses to compile a widget added into a composite (no broken container:=<widget>)', () => {
    const base = model(n({ id: 'tab1', kind: 'tab', className: 'Tab', name: 'T', children: [
      n({ id: 'bc', kind: 'widget', className: 'ButtonContainer', name: 'Buttons', children: [] }),
    ] }));
    const desired = addWidget(base, 'bc', 0, 'ActionButton').model; // child into the composite
    expect(() => compile(diff(base, desired), desired)).toThrow(/composite/);
  });
  it('emits create→update→reparent ordered with variable threading', () => {
    const base = demo();
    let d = resize(base, 'w1', 'L', 3);                // update
    const added = addContainer(d, 'tab1', 0, 2); d = added.model; // create container
    d = addWidget(d, added.id, 0, 'PieChart').model;   // create widget INTO the new container
    const steps = diff(base, d);
    const { script } = compile(steps, d);

    // new container created before the widget that binds into it
    const boxLine = script.split('\n').findIndex(l => l.includes('.add(Container'));
    const wLine = script.split('\n').findIndex(l => l.includes('.add(PieChart'));
    expect(boxLine).toBeGreaterThanOrEqual(0);
    expect(wLine).toBeGreaterThan(boxLine);
    // the widget binds to the container's VARIABLE, not a t.<id>
    const boxVar = script.match(/(_n\d+) := t\.tab1\.add\(Container/)?.[1];
    expect(boxVar).toBeTruthy();
    expect(script).toContain(`container := ${boxVar}`);
    // the existing widget update references it by business id
    expect(script).toContain('t.w1.change(columnsLargeScreen := 3)');
  });

  it('re-home shows as reparent ordered BEFORE the container delete', () => {
    const base = demo();
    const d = remove(base, 'box1');               // re-homes w1 to tab1, deletes box1
    const steps = diff(base, d);
    const { script } = compile(steps, d);
    const lines = script.split('\n');
    const rehome = lines.findIndex(l => l.startsWith('t.w1.change(container := t.tab1)'));
    const del = lines.findIndex(l => l.startsWith('t.box1.delete()'));
    expect(rehome).toBeGreaterThanOrEqual(0);
    expect(del).toBeGreaterThan(rehome);
  });

  it('cross-tab move emits a container re-point', () => {
    const base = model(
      n({ id: 'tA', kind: 'tab', className: 'Tab', name: 'A', children: [n({ id: 'w', kind: 'widget', className: 'X' })] }),
      n({ id: 'tB', kind: 'tab', className: 'Tab', name: 'B', children: [] }),
    );
    const d = moveToTab(base, 'w', 'tB');
    const { script } = compile(diff(base, d), d);
    expect(script).toBe('t.w.change(container := t.tB)');
  });

  it('reorder emits moveAfter only when order actually changes', () => {
    const base = model(n({ id: 't', kind: 'tab', className: 'Tab', children: [
      n({ id: 'A', kind: 'widget', className: 'X' }), n({ id: 'B', kind: 'widget', className: 'Y' }),
    ] }));
    const reordered = insertRelative(base, 'B', 'A', /* before */ true);
    const { script } = compile(diff(base, reordered), reordered);
    expect(script).toContain('moveAfter');
    // a no-op edit produces no script
    expect(compile(diff(base, base), base).script).toBe('');
  });

  it('escapes names in EC string slots', () => {
    const base = demo();
    const d = rename(base, 'w1', 'say "hi"\\n');
    const { script } = compile(diff(base, d), d);
    expect(script).toContain('name := "say \\"hi\\"\\\\n"');
  });
});

describe('constraints', () => {
  it('forbids a widget ordered before a container (containers-first)', () => {
    expect(checkReorder('widget', 'container', true).level).toBe('forbidden');
    expect(checkReorder('widget', 'container', false).level).toBe('ok');
    expect(checkReorder('container', 'container', true).level).toBe('ok');
  });
  it('forbids height on non-chart types', () => {
    expect(checkHeight('BarChart').ok).toBe(true);
    expect(checkHeight('URLView').ok).toBe(true);
    expect(checkHeight('ExtendedTable').ok).toBe(false);
  });
  it('allows add into a tab/container, forbids add into a widget (composite or leaf)', () => {
    expect(checkAddTarget('tab').ok).toBe(true);
    expect(checkAddTarget('container').ok).toBe(true);
    expect(checkAddTarget('widget', 'ButtonContainer').ok).toBe(false);   // composite — Phase 4
    expect(checkAddTarget('widget', 'ButtonContainer').reason).toMatch(/composite/);
    expect(checkAddTarget('widget', 'SimpleStatus').ok).toBe(false);      // leaf — nonsensical
  });
  it('warns on instance structural ops and shared edits', () => {
    expect(guard({ type: 'structural', target: 'instance', op: 'add' }).level).toBe('warn');
    expect(guard({ type: 'structural', target: 'template', op: 'add' }).level).toBe('ok');
    expect(guard({ type: 'sharedEdit', nodeKind: 'container', op: 'resize' }).level).toBe('warn');
    expect(guard({ type: 'sharedEdit', nodeKind: 'widget', op: 'resize' }).level).toBe('ok');
  });
  it('lints empty tabs (invisible on the page)', () => {
    const m = model(n({ id: 'empty', kind: 'tab', className: 'Tab', name: 'Empty', children: [] }));
    expect(lint(m)[0]).toContain('Empty');
  });
});

describe('history', () => {
  it('undo/redo over snapshots', () => {
    const h = new History(demo());
    expect(h.canUndo()).toBe(false);
    h.push(resize(demo(), 'w1', 'L', 2));
    expect(h.canUndo()).toBe(true);
    expect(findNode(h.present(), 'w1')!.node.cols.L).toBe(2);
    expect(findNode(h.undo()!, 'w1')!.node.cols.L).toBe(6);
    expect(findNode(h.redo()!, 'w1')!.node.cols.L).toBe(2);
    // a new push truncates the redo tail
    h.undo();
    h.push(resize(demo(), 'w1', 'L', 4));
    expect(h.canRedo()).toBe(false);
  });
});

describe('helpers', () => {
  it('isChart + descendantWidgets', () => {
    expect(isChart('BarLineChart')).toBe(true);
    expect(isChart('ExtendedTable')).toBe(false);
    expect(descendantWidgets(demo().tabs[0]).map(w => w.id).sort()).toEqual(['rw', 'w1']);
  });
});
