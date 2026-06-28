import { describe, it, expect } from 'vitest';
import type { LayoutNode as WireNode } from '../../types';
import type { LModel, LNode } from '../types';
import { reconstruct, findNode, descendantWidgets, isChart } from '../model';
import { resize, setHeight, rename, move, swap, insertRelative, moveInto, addWidget, addContainer, addTab, remove, isAncestorOf } from '../edit';
import { diff, summarizeChanges } from '../diff';
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

describe('isAncestorOf (move-into-own-subtree guard)', () => {
  it('matches self and any descendant, rejects unrelated / parent', () => {
    const box = findNode(demo(), 'box1')!.node; // KPIs container → holds w1
    expect(isAncestorOf(box, 'box1')).toBe(true);  // self
    expect(isAncestorOf(box, 'w1')).toBe(true);     // descendant
    expect(isAncestorOf(box, 'tw1')).toBe(false);   // sibling's child, not under box1
    expect(isAncestorOf(box, 'nope')).toBe(false);  // absent
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

// The drag gestures (gestures.ts) stage these ops; lock their behaviour and the swap/insert inverses
// the tray's per-node revert relies on.
describe('gesture edit ops (drag-to-move / reorder / cross-tab)', () => {
  const threeWide = () => model(n({ id: 't', kind: 'tab', className: 'Tab', children: [
    n({ id: 'A', kind: 'widget', className: 'X' }),
    n({ id: 'B', kind: 'widget', className: 'Y' }),
    n({ id: 'C', kind: 'widget', className: 'Z' }),
  ] }));

  it('insertRelative reorders within a list (after)', () => {
    const b = insertRelative(threeWide(), 'A', 'C', false); // A after C
    expect(b.tabs[0].children.map(c => c.id)).toEqual(['B', 'C', 'A']);
  });
  it('insertRelative reorders within a list (before)', () => {
    const b = insertRelative(threeWide(), 'C', 'A', true); // C before A
    expect(b.tabs[0].children.map(c => c.id)).toEqual(['C', 'A', 'B']);
  });
  it('insertRelative reparents across containers', () => {
    const b = insertRelative(demo(), 'rw', 'w1', true); // Register before Bar (into KPIs box)
    expect(findNode(b, 'rw')!.parent!.id).toBe('box1');
  });
  it('a no-op insert (already in place) yields an empty diff', () => {
    const a = threeWide();
    const b = insertRelative(a, 'A', 'B', true); // A before B — A already there
    expect(diff(a, b)).toHaveLength(0);
  });
  it('swap is its own inverse (the revert round-trip)', () => {
    const a = threeWide();
    const once = swap(a, 'A', 'C');
    expect(once.tabs[0].children.map(c => c.id)).toEqual(['C', 'B', 'A']);
    const twice = swap(once, 'A', 'C');
    expect(diff(a, twice)).toHaveLength(0);
  });
  it('addWidget inserts at an index, sized to a free-column gap', () => {
    // gap zones add positionally: after a sibling, sized to the detected free columns
    const a = model(n({ id: 't', kind: 'tab', className: 'Tab', children: [
      n({ id: 'A', kind: 'widget', className: 'X', cols: { L: 4 } }),
    ] }));
    const { model: b, id } = addWidget(a, 't', 1, 'PieChart', undefined, 2); // after A, width 2
    expect(b.tabs[0].children.map(c => c.id)).toEqual(['A', id]);
    expect(findNode(b, id)!.node.cols.L).toBe(2);
  });
  it('packRows-style fill: A(L4)+new(L2) sums to a full 6-col row', () => {
    const a = model(n({ id: 't', kind: 'tab', className: 'Tab', children: [
      n({ id: 'A', kind: 'widget', className: 'X', cols: { L: 4 } }),
    ] }));
    const { model: b } = addWidget(a, 't', 1, 'Status', undefined, 2);
    const used = b.tabs[0].children.reduce((s, c) => s + c.cols.L, 0);
    expect(used).toBe(6);
  });
  it('moveInto appends a widget onto another tab', () => {
    const a = model(
      n({ id: 't1', kind: 'tab', className: 'Tab', name: 'One', children: [n({ id: 'w', kind: 'widget', className: 'X' })] }),
      n({ id: 't2', kind: 'tab', className: 'Tab', name: 'Two', children: [] }),
    );
    const b = moveInto(a, 'w', 't2');
    expect(findNode(b, 'w')!.parent!.id).toBe('t2');
    expect(b.tabs[0].children).toHaveLength(0);
    expect(diff(a, b).some(s => s.kind === 'reparent')).toBe(true);
  });
});

describe('summarizeChanges (logical changes vs raw actions)', () => {
  it('counts a mid-list insert as ONE change even when it emits a moveAfter chain', () => {
    // tab with three widgets; insert a 4th between the 1st and 2nd → create + reorder side-effects
    const base = model(n({ id: 't', kind: 'tab', className: 'Tab', name: 'T', children: [
      n({ id: 'a', kind: 'widget', className: 'SimpleStatus', name: 'A' }),
      n({ id: 'b', kind: 'widget', className: 'SimpleStatus', name: 'B' }),
      n({ id: 'c', kind: 'widget', className: 'SimpleStatus', name: 'C' }),
    ] }));
    const desired = addWidget(base, 't', 1, 'BarChart', 'New').model; // inserted at index 1 (mid-list)
    const plan = diff(base, desired);
    const { changes, actions } = summarizeChanges(plan, desired);
    expect(plan.some(s => s.kind === 'create')).toBe(true);
    expect(actions).toBeGreaterThan(1);     // the create + its reorder chain
    expect(changes).toBe(1);                // ...but ONE logical change (the inserted widget)
  });
  it('counts a pure reorder gesture as one change', () => {
    const base = model(n({ id: 't', kind: 'tab', className: 'Tab', name: 'T', children: [
      n({ id: 'a', kind: 'widget', className: 'SimpleStatus', name: 'A' }),
      n({ id: 'b', kind: 'widget', className: 'SimpleStatus', name: 'B' }),
    ] }));
    const desired = insertRelative(base, 'b', 'a', true); // move B before A — reorder only, no create
    expect(summarizeChanges(diff(base, desired), desired).changes).toBe(1);
  });
  it('counts independent field edits on two nodes as two changes', () => {
    const base = demo();
    const desired = rename(resize(base, 'w1', 'L', 2), 'rw', 'Renamed');
    expect(summarizeChanges(diff(base, desired), desired).changes).toBe(2);
  });
  it('reports zero for an unchanged model', () => {
    expect(summarizeChanges(diff(demo(), demo()), demo())).toEqual({ changes: 0, actions: 0 });
  });
});

describe('diff + ec compile', () => {
  it('compiles a child into a composite as <composite>.add(Child) (not container:=<widget>)', () => {
    const base = model(n({ id: 'tab1', kind: 'tab', className: 'Tab', name: 'T', children: [
      n({ id: 'bc', kind: 'widget', className: 'ButtonContainer', name: 'Buttons', children: [] }),
    ] }));
    const desired = addWidget(base, 'bc', 0, 'ActionButton', 'Go').model; // child into the composite
    const { script } = compile(diff(base, desired), desired);
    expect(script).toContain('t.bc.add(ActionButton, name := "Go")');
    expect(script).not.toContain('container := t.bc');
  });
  it('still refuses to add a widget into a plain (non-composite) leaf widget', () => {
    const base = model(n({ id: 'tab1', kind: 'tab', className: 'Tab', name: 'T', children: [
      n({ id: 'w', kind: 'widget', className: 'SimpleStatus', name: 'S', children: [] }),
    ] }));
    const desired = addWidget(base, 'w', 0, 'BarChart').model;
    expect(() => compile(diff(base, desired), desired)).toThrow(/not a composite/);
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
    const d = moveInto(base, 'w', 'tB');
    const { script } = compile(diff(base, d), d);
    expect(script).toBe('t.w.change(container := t.tB)');
  });

  it('addresses a businessId-less node by lookup(<rid>), never the silently-broken t.<rid>', () => {
    // Some layout objects can carry no businessId; reconstruct falls `id` back to the rid (id === rid).
    // `t.<rid>` does NOT resolve (the t. namespace is businessId-keyed, and an all-digit rid slips past
    // the businessId validator), so it would mis-target with no error — lookup(<rid>) addresses it.
    const base = model(n({ id: 'tab1', kind: 'tab', className: 'Tab', name: 'T', children: [
      n({ id: '777', rid: '777', kind: 'widget', className: 'Status', name: 'NoBid', cols: { L: 6 } }),
    ] }));
    // update path — node is in the desired model, so ref() reads its rid directly
    const renamed = rename(base, '777', 'Renamed');
    const up = compile(diff(base, renamed), renamed).script;
    expect(up).toContain('lookup(777).change(name := "Renamed")');
    expect(up).not.toContain('t.777');
    // delete path — node lives only in the baseline, so the rid is threaded through the delete step
    const removed = remove(base, '777');
    const del = compile(diff(base, removed), removed).script;
    expect(del).toContain('lookup(777).delete()');
    expect(del).not.toContain('t.777');
    // a normal node (id !== rid) still uses t.<businessId> — no regression
    const normal = rename(demo(), 'w1', 'Z');
    expect(compile(diff(demo(), normal), normal).script).toContain('t.w1.change');
  });

  it('registers a concurrent CLEAR (M/height set→unset) as drift, but never emits broken EC', () => {
    // The stale-guard is `diff(baseline, live).length > 0`. If someone else clears an authored M-width
    // or chart height server-side, diff MUST see it — else the apply re-imposes the old value and
    // clobbers their change. The old `b.cols[bp] != null` guard dropped clears, blinding the guard.
    const baseline = model(n({ id: 'tab1', kind: 'tab', className: 'Tab', name: 'T', children: [
      n({ id: 'w', kind: 'widget', className: 'BarChart', name: 'C', cols: { L: 6, M: 4 }, height: 300 }),
    ] }));
    const live = model(n({ id: 'tab1', kind: 'tab', className: 'Tab', name: 'T', children: [
      n({ id: 'w', kind: 'widget', className: 'BarChart', name: 'C', cols: { L: 6 }, height: undefined }), // M + height cleared
    ] }));
    const steps = diff(baseline, live);
    const upd = steps.find(s => s.kind === 'update');
    expect(upd).toBeDefined();                       // drift detected → stale-guard fires
    expect((upd as { cols?: unknown }).cols).toEqual({ M: null });
    expect((upd as { height?: unknown }).height).toBeNull();
    // compile must NOT serve the clear (no verb yet) NOR emit a broken empty change()
    const { script } = compile(steps, live);
    expect(script).not.toContain('change()');
    expect(script).toBe('');                          // nothing serveable → empty script
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

  it('moving a node INTO a populated box (append) is 1 reparent + 0 reorders, not N', () => {
    const base = model(n({ id: 't', kind: 'tab', className: 'Tab', children: [
      n({ id: 'box', kind: 'container', className: 'Container', name: 'Box', children: [
        n({ id: 'a', kind: 'widget', className: 'X' }), n({ id: 'b', kind: 'widget', className: 'Y' }),
      ] }),
      n({ id: 'w', kind: 'widget', className: 'Z' }),
    ] }));
    // append `w` into box → BMP's reparent appends, so the result order already matches; no reorder noise.
    const appended = move(base, 'w', 'box', 99);
    const steps = diff(base, appended);
    expect(steps.filter(s => s.kind === 'reparent')).toHaveLength(1);
    expect(steps.filter(s => s.kind === 'reorder')).toHaveLength(0);
    // but a genuine interleave (drop `w` at the FRONT of box) still needs reorders to reconstruct it
    const front = move(base, 'w', 'box', 0);
    expect(diff(base, front).some(s => s.kind === 'reorder')).toBe(true);
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
  it('allows add into a tab/container/composite, forbids add into a leaf widget', () => {
    expect(checkAddTarget('tab').ok).toBe(true);
    expect(checkAddTarget('container').ok).toBe(true);
    expect(checkAddTarget('widget', 'ButtonContainer').ok).toBe(true);    // composite — now supported
    expect(checkAddTarget('widget', 'SimpleStatus').ok).toBe(false);      // leaf — nonsensical
  });
  it('notes instance structural ops (info, not a warning — verified live) and warns on shared edits', () => {
    // Structural add/delete on an instance is verified to work, so it's an info-level scope note.
    expect(guard({ type: 'structural', target: 'instance', op: 'add' }).level).toBe('info');
    expect(guard({ type: 'structural', target: 'template', op: 'add' }).level).toBe('ok');
    expect(guard({ type: 'sharedEdit', nodeKind: 'container', op: 'resize' }).level).toBe('warn');
    expect(guard({ type: 'sharedEdit', nodeKind: 'widget', op: 'resize' }).level).toBe('ok');
  });
  it('lints empty tabs (invisible on the page)', () => {
    const m = model(n({ id: 'empty', kind: 'tab', className: 'Tab', name: 'Empty', children: [] }));
    const msg = lint(m, 'template', [])[0];
    expect(msg.level).toBe('warn');
    expect(msg.text).toContain('Empty');
  });
  it('lints structural add/delete as an instance scope note (info), only when the target is an instance', () => {
    const w = n({ id: 'w1', kind: 'widget', className: 'Status', name: 'W', children: [] });
    const m = model(n({ id: 't1', kind: 'tab', className: 'Tab', name: 'T', children: [w] }));
    const addPlan = [{ kind: 'create' as const, node: w, parentId: 't1', parentKind: 'tab' as const }];
    const inst = lint(m, 'instance', addPlan).find(s => s.text.includes('this instance'));
    expect(inst?.level).toBe('info');
    expect(lint(m, 'template', addPlan).some(s => s.text.includes('this instance'))).toBe(false);
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
