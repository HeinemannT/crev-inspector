import { describe, it, expect } from 'vitest';
import type { LayoutNode as WireNode } from '../../types';
import { maskStyle, type LModel, type LNode, type NodeStyle } from '../types';
import { reconstruct, findNode, descendantWidgets, isChart, isResultTab } from '../model';
import { resize, setHeight, rename, move, swap, insertRelative, moveInto, addWidget, addContainer, addTab, remove, restoreNode, isAncestorOf, toggleReset, setStyle } from '../edit';
import { diff, summarizeChanges } from '../diff';
import { compile } from '../ec';
import { lint } from '../constraints';
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

  it('adopts a foreign-tabset tab (the shared Result tab) with its directly-bound widgets', () => {
    const wire: WireNode[] = [
      { rid: 'r_ts', businessId: 'ts1', type: 'TabSet' },
      // the shared Result tab lives in ANOTHER tabset (parent r_def, not the page's r_ts), emitted first
      { rid: 'r_res', businessId: 'RESULT', type: 'Tab', parentRid: 'r_def', name: 'Result' },
      { rid: 'r_ra', businessId: '5920', type: 'ActionButton', containerRid: 'r_res', columnsLargeScreen: 6, name: 'Run Audit' },
      { rid: 'r_tab', businessId: 'tab1', type: 'Tab', parentRid: 'r_ts', columnsLargeScreen: 6, name: 'Overview' },
    ];
    const m = reconstruct(wire, { pageId: '4957', tabsetId: 'ts1' });
    expect(m.tabs.map(t => t.id)).toEqual(['RESULT', 'tab1']); // Result leads the strip (emit order)
    expect(isResultTab(m.tabs[0])).toBe(true);
    expect(m.tabs[0].children.map(c => c.name)).toEqual(['Run Audit']); // its directly-bound widget attaches
  });

  it('drops the Result tab when it holds none of this page\'s widgets', () => {
    const wire: WireNode[] = [
      { rid: 'r_ts', businessId: 'ts1', type: 'TabSet' },
      { rid: 'r_res', businessId: 'RESULT', type: 'Tab', parentRid: 'r_def', name: 'Result' }, // empty
      { rid: 'r_tab', businessId: 'tab1', type: 'Tab', parentRid: 'r_ts', columnsLargeScreen: 6, name: 'Overview' },
      { rid: 'r_w', businessId: 'w1', type: 'BarChart', containerRid: 'r_tab', columnsLargeScreen: 6, name: 'Chart' },
    ];
    const m = reconstruct(wire, { pageId: '4957', tabsetId: 'ts1' });
    expect(m.tabs.map(t => t.id)).toEqual(['tab1']); // empty Result tab is not shown
  });

  it('nests a composite (ButtonContainer) child under its parent, not the Result tab it reports', () => {
    // Live shape (demo 4957): the buttons report container=RESULT (phantom) but belong to the
    // ButtonContainer, which is itself placed in a real cell. Buttons must NOT leak onto the Result tab.
    const wire: WireNode[] = [
      { rid: 'r_ts', businessId: 'ts1', type: 'TabSet' },
      { rid: 'r_res', businessId: 'RESULT', type: 'Tab', parentRid: 'r_def', name: 'Result' },
      { rid: 'r_tab', businessId: 'tab1', type: 'Tab', parentRid: 'r_ts', columnsLargeScreen: 6, name: 'Overview' },
      { rid: 'r_cell', businessId: 'cell1', type: 'Container', parentRid: 'r_tab', columnsLargeScreen: 6, name: 'Cell' },
      { rid: 'r_bc', businessId: '5919', type: 'ButtonContainer', parentRid: 'r_sc', containerRid: 'r_cell', columnsLargeScreen: 6, name: 'Test Buttons' },
      { rid: 'r_b1', businessId: '5920', type: 'ActionButton', parentRid: 'r_bc', containerRid: 'r_res', columnsLargeScreen: 6, name: 'Run' },
      { rid: 'r_b2', businessId: '5921', type: 'ActionButton', parentRid: 'r_bc', containerRid: 'r_res', columnsLargeScreen: 6, name: 'Reset' },
    ];
    const m = reconstruct(wire, { pageId: '4957', tabsetId: 'ts1' });
    // buttons no longer leak onto the Result tab → it's empty → dropped (Part-1 behaviour)
    expect(m.tabs.find(t => t.id === 'RESULT')).toBeUndefined();
    const cell = m.tabs.find(t => t.id === 'tab1')!.children.find(c => c.id === 'cell1')!;
    const bc = cell.children.find(c => c.id === '5919')!;
    expect(bc.children.map(c => c.id)).toEqual(['5920', '5921']); // nested under the ButtonContainer
  });

  it('nests a model Container\'s children under it (not the Result tab), keeping its width', () => {
    // Live shape (demo 4957): Container 455 sits on the Result tab; its table + create-object report
    // container=RESULT too but belong to 455. The 3-wide container keeps its width; children nest in it.
    const wire: WireNode[] = [
      { rid: 'r_ts', businessId: 'ts1', type: 'TabSet' },
      { rid: 'r_res', businessId: 'RESULT', type: 'Tab', parentRid: 'r_def', name: 'Result' },
      { rid: 'r_c', businessId: '455', type: 'Container', parentRid: 'r_sc', containerRid: 'r_res', columnsLargeScreen: 3, name: 'Box' },
      { rid: 'r_t', businessId: '456', type: 'ExtendedTable', parentRid: 'r_c', containerRid: 'r_res', columnsLargeScreen: 6, name: 'Table' },
      { rid: 'r_co', businessId: '457', type: 'CreateObjectView', parentRid: 'r_c', containerRid: 'r_res', columnsLargeScreen: 6, name: 'Create' },
    ];
    const m = reconstruct(wire, { pageId: '4957', tabsetId: 'ts1' });
    const result = m.tabs.find(t => t.id === 'RESULT')!;
    const box = result.children.find(c => c.id === '455')!;
    expect(box.cols.L).toBe(3);
    expect(box.children.map(c => c.id)).toEqual(['456', '457']); // nested under the container
    expect(result.children.map(c => c.id)).not.toContain('456'); // not also siblings on Result
  });
});

describe('F2 reset overrides (instance → template)', () => {
  // A small one-widget model whose widget overrides the template on width + name.
  const overModel = (): LModel => reconstruct(
    [
      { rid: 'r_ts', businessId: 'ts1', type: 'TabSet' },
      { rid: 'r_tab', businessId: 'tab1', type: 'Tab', parentRid: 'r_ts', columnsLargeScreen: 6, name: 'T' },
      { rid: 'r_w', businessId: 'w1', type: 'BarChart', containerRid: 'r_tab', columnsLargeScreen: 2, name: 'W' },
    ],
    { pageId: '4957', tabsetId: 'ts1' },
    new Map([['w1', ['columnsLargeScreen', 'name']]]),
  );

  it('attaches overrides to the node from the override map', () => {
    expect(findNode(overModel(), 'w1')!.node.overrides).toEqual(['columnsLargeScreen', 'name']);
  });

  it('toggleReset stages only an overridden prop, and toggles off', () => {
    const m = overModel();
    const staged = toggleReset(m, 'w1', 'columnsLargeScreen');
    expect(findNode(staged, 'w1')!.node.resets).toEqual(['columnsLargeScreen']);
    expect(findNode(toggleReset(staged, 'w1', 'columnsLargeScreen'), 'w1')!.node.resets).toBeUndefined();
    // a prop that doesn't override the template can't be staged
    expect(findNode(toggleReset(m, 'w1', 'chartHeight'), 'w1')!.node.resets).toBeUndefined();
  });

  it('diff → compile emits .reset(<prop>) for a staged reset, with no value change', () => {
    const base = overModel();
    const desired = toggleReset(toggleReset(base, 'w1', 'columnsLargeScreen'), 'w1', 'name');
    const plan = diff(base, desired);
    const upd = plan.find(s => s.kind === 'update');
    expect(upd).toMatchObject({ id: 'w1', resetProps: ['columnsLargeScreen', 'name'] });
    const { script } = compile(plan, desired);
    expect(script).toContain('t.w1.reset(columnsLargeScreen)');
    expect(script).toContain('t.w1.reset(name)');
    expect(script).not.toContain('.change(');   // a staged reset doesn't change the value
  });
});

describe('G3 style edits (setStyle → diff → ec)', () => {
  // One styled widget: header colour C_RED, no other appearance set.
  const styleModel = (): LModel => reconstruct(
    [
      { rid: 'r_ts', businessId: 'ts1', type: 'TabSet' },
      { rid: 'r_tab', businessId: 'tab1', type: 'Tab', parentRid: 'r_ts', columnsLargeScreen: 6, name: 'T' },
      { rid: 'r_w', businessId: 'w1', type: 'BarChart', containerRid: 'r_tab', columnsLargeScreen: 6, name: 'W' },
    ],
    { pageId: '4957', tabsetId: 'ts1' },
    undefined,
    new Map([['w1', { headerColorBid: 'C_RED' }]]),
  );

  it('setStyle merges a patch without mutating the baseline', () => {
    const base = styleModel();
    const next = setStyle(base, 'w1', { shadow: true, headerStyle: 'NONE' });
    expect(findNode(next, 'w1')!.node.style).toEqual({ headerColorBid: 'C_RED', shadow: true, headerStyle: 'NONE' });
    expect(findNode(base, 'w1')!.node.style).toEqual({ headerColorBid: 'C_RED' }); // baseline untouched
  });

  it('diff emits only the changed appearance fields', () => {
    const base = styleModel();
    const desired = setStyle(base, 'w1', { fontColorBid: 'C_BLUE', shadow: true, transparency: 20 });
    const upd = diff(base, desired).find(s => s.kind === 'update');
    // emit order follows the style catalog (STYLE_PROPS): …transparency, shadow… (order is immaterial to `.change()`)
    expect(upd).toMatchObject({ id: 'w1', styleAssign: [
      { prop: 'fontColor', value: 'C_BLUE' }, { prop: 'transparency', value: 20 }, { prop: 'shadow', value: true },
    ] });
  });

  it('compile emits colour links as t.<bid>, scalars typed, and "" to clear', () => {
    const base = styleModel();
    const desired = setStyle(base, 'w1', { headerColorBid: '', fontColorBid: 'C_BLUE', shadow: true, borderStyle: 'LINE', transparency: 15 });
    const { script } = compile(diff(base, desired), desired);
    expect(script).toContain('t.w1.change(');
    expect(script).toContain('headerColor := ""');   // clearing the linked colour
    expect(script).toContain('fontColor := t.C_BLUE');
    expect(script).toContain('shadow := TRUE');
    expect(script).toContain('borderStyle := "LINE"');
    expect(script).toContain('transparency := 15');
  });

  it('an unchanged style is a no-op (no update step)', () => {
    const base = styleModel();
    expect(diff(base, setStyle(base, 'w1', { headerColorBid: 'C_RED' })).length).toBe(0);
  });

  it('toggling a prop back to its default emits the default value', () => {
    const base = setStyle(styleModel(), 'w1', { shadow: true });
    const off = setStyle(base, 'w1', { shadow: false });
    const upd = diff(base, off).find(s => s.kind === 'update');
    expect(upd).toMatchObject({ styleAssign: [{ prop: 'shadow', value: false }] });
    expect(compile(diff(base, off), off).script).toContain('shadow := FALSE');
  });

  it('a widget CREATED and styled in one batch emits the style on the new var', () => {
    // The bug: a create step has no baseline, so the style would otherwise be dropped. The compiler must
    // emit a follow-up `_n0.change(...)` on the captured variable.
    const base = styleModel();
    const added = addWidget(base, 'tab1', 1, 'SimpleStatus', 'New');
    const desired = setStyle(added.model, added.id, { headerColorBid: 'C_GREEN', shadow: true, borderStyle: 'NONE' });
    const { script } = compile(diff(base, desired), desired);
    expect(script).toMatch(/_n0 := _sc\.add\(SimpleStatus/);     // the create
    expect(script).toMatch(/_n0\.change\([^)]*headerColor := t\.C_GREEN/); // …then the style on the same var
    expect(script).toContain('shadow := TRUE');
    expect(script).toContain('borderStyle := "NONE"');
  });

  it('a created widget with NO style emits no follow-up change', () => {
    const base = styleModel();
    const added = addWidget(base, 'tab1', 1, 'SimpleStatus', 'Plain');
    const { script } = compile(diff(base, added.model), added.model);
    expect(script).toMatch(/_n0 := _sc\.add\(SimpleStatus/);
    expect(script).not.toContain('_n0.change(');
  });
});

describe('G4 paintbrush — maskStyle (the painted patch)', () => {
  const src: NodeStyle = { headerColorBid: 'C_RED', shadow: true, borderStyle: 'LINE', transparency: 30 };
  const all = new Set(['headerColor', 'fontColor', 'shadow', 'headerStyle', 'borderStyle', 'transparency']);

  it('copies the held value for masked props', () => {
    const patch = maskStyle(src, new Set(['headerColor', 'shadow']));
    expect(patch).toEqual({ headerColorBid: 'C_RED', shadow: true });
  });

  it('an ABSENT source value folds to the prop default (so painting clears it on the target)', () => {
    // src has no fontColor / headerStyle → masked, they come through as the clear defaults
    const patch = maskStyle(src, all);
    expect(patch).toMatchObject({
      headerColorBid: 'C_RED', fontColorBid: '', shadow: true,
      headerStyle: '', borderStyle: 'LINE', transparency: 30,
    });
  });

  it('an empty mask paints nothing', () => {
    expect(maskStyle(src, new Set())).toEqual({});
  });

  it('preserves falsy real values (shadow:false, transparency:0) — not mis-read as absent', () => {
    const patch = maskStyle({ shadow: false, transparency: 0 }, new Set(['shadow', 'transparency']));
    expect(patch).toEqual({ shadow: false, transparency: 0 });
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
  it('restoreNode restores a deleted container subtree without duplicate re-homed widgets', () => {
    const base = demo();
    const restored = restoreNode(remove(base, 'box1'), base, 'box1');
    const box = findNode(restored, 'box1')!;
    expect(box.parent!.id).toBe('tab1');
    expect(box.node.children.map(child => child.id)).toEqual(['w1']);
    expect(restored.tabs[0].children.flatMap(child => child.id === 'w1' ? [child.id] : child.children.map(grandchild => grandchild.id)))
      .toEqual(['w1']);
  });
  it('restoreNode restores all editable fields while preserving independent child edits', () => {
    const base = demo();
    const editedChild = rename(base, 'w1', 'Edited child');
    let desired = rename(editedChild, 'box1', 'Changed box');
    desired = resize(desired, 'box1', 'L', 5);
    desired = setStyle(desired, 'box1', { shadow: true });
    const restored = restoreNode(desired, base, 'box1');
    expect(findNode(restored, 'box1')!.node).toMatchObject({ name: 'KPIs', cols: { L: 3 } });
    expect(findNode(restored, 'box1')!.node.style).toBeUndefined();
    expect(findNode(restored, 'w1')!.node.name).toBe('Edited child');
  });
  it('restoreNode is a no-op when the node\'s baseline parent is also deleted', () => {
    const base = demo();
    const withoutParent = remove(base, 'box1');
    expect(restoreNode(withoutParent, base, 'w1')).toEqual(withoutParent);
  });
  it('addWidget / addContainer / addTab mint temp ids', () => {
    const { model: m1, id } = addWidget(demo(), 'tab1', 1, 'PieChart');
    expect(id).toMatch(/^w:/);
    expect(findNode(m1, id)!.node.kind).toBe('widget');
    expect(addContainer(demo(), 'tab1', 0).id).toMatch(/^box:/);
    expect(addTab(demo(), 0).id).toMatch(/^tab:/);
  });
});

describe('container smart naming (Col N + autoName flag)', () => {
  it('auto-names a new container "Col N" for its width and flags it tool-owned', () => {
    const { model: m, id } = addContainer(demo(), 'tab1', 0, 3);
    const c = findNode(m, id)!.node;
    expect(c.name).toBe('Col 3');
    expect(c.autoName).toBe(true);
  });
  it('names a 0-width (auto) container "Col auto", never "Col 6"', () => {
    const { model: m, id } = addContainer(demo(), 'tab1', 0, 0);
    expect(findNode(m, id)!.node.name).toBe('Col auto');
  });
  it('de-dupes same-width siblings with a (2) suffix', () => {
    let r = addContainer(demo(), 'tab1', 0, 2); let m = r.model;
    r = addContainer(m, 'tab1', 0, 2); m = r.model;
    const names = findNode(m, 'tab1')!.node.children.filter(c => c.kind === 'container').map(c => c.name);
    expect(names).toContain('Col 2');
    expect(names).toContain('Col 2 (2)');
  });
  it('keeps a tool-named container in step with its width on an L-resize', () => {
    const { model: m0, id } = addContainer(demo(), 'tab1', 0, 6);
    expect(findNode(resize(m0, id, 'L', 3), id)!.node.name).toBe('Col 3');
  });
  it('an explicit rename takes name ownership — later resizes never rename', () => {
    const { model: m0, id } = addContainer(demo(), 'tab1', 0, 6);
    const m1 = rename(m0, id, 'Sidebar');
    expect(findNode(m1, id)!.node.autoName).toBeUndefined();
    expect(findNode(resize(m1, id, 'L', 2), id)!.node.name).toBe('Sidebar');
  });
  it('never hijacks a container a human happened to name "Col 3" (no autoName flag)', () => {
    const m1 = rename(demo(), 'box1', 'Col 3'); // box1 is a plain reconstructed container (no flag)
    expect(findNode(resize(m1, 'box1', 'L', 5), 'box1')!.node.name).toBe('Col 3');
  });
});

describe('tab reorder (insertRelative on tab siblings → moveAfter)', () => {
  const threeTabs = () => model(
    n({ id: 'tA', kind: 'tab', className: 'Tab', name: 'A', children: [n({ id: 'wa', kind: 'widget', className: 'BarChart', name: 'a' })] }),
    n({ id: 'tB', kind: 'tab', className: 'Tab', name: 'B', children: [n({ id: 'wb', kind: 'widget', className: 'BarChart', name: 'b' })] }),
    n({ id: 'tC', kind: 'tab', className: 'Tab', name: 'C', children: [n({ id: 'wc', kind: 'widget', className: 'BarChart', name: 'c' })] }),
  );
  it('reorders the tabs array (B to end → A, C, B) and normalize preserves it', () => {
    const moved = insertRelative(threeTabs(), 'tB', 'tC', false);
    expect(moved.tabs.map(t => t.id)).toEqual(['tA', 'tC', 'tB']);
  });
  it('a tab reorder emits a moveAfter chain that reseats the moved tab', () => {
    const base = threeTabs();
    const desired = insertRelative(base, 'tA', 'tC', false); // A after C → B, C, A
    const reorders = diff(base, desired).filter(s => s.kind === 'reorder');
    // the diff reconstructs the exact desired order as a moveAfter chain; the operative move is A→C.
    expect(reorders.length).toBeGreaterThan(0);
    expect(reorders.some(s => s.id === 'tA' && s.afterId === 'tC')).toBe(true);
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
  it('never chains the shared Result tab in a tab reorder (it is cross-tabset, pinned first)', () => {
    // RESULT (the shared default_tabset tab) leads the strip; the page tabs follow. diff.index() parents
    // ALL tabs under the page tabset, so without the isResultTab guard a page-tab reorder would emit
    // t.<pageTab>.moveAfter(t.RESULT) — a cross-tabset move that misplaces/errors.
    const base = model(
      n({ id: 'RESULT', kind: 'tab', className: 'Tab', name: 'Result' }),
      n({ id: 't1', kind: 'tab', className: 'Tab', name: 'A' }),
      n({ id: 't2', kind: 'tab', className: 'Tab', name: 'B' }),
    );
    const desired = model(
      n({ id: 'RESULT', kind: 'tab', className: 'Tab', name: 'Result' }),
      n({ id: 't2', kind: 'tab', className: 'Tab', name: 'B' }),
      n({ id: 't1', kind: 'tab', className: 'Tab', name: 'A' }),
    );
    const reorders = diff(base, desired).filter(s => s.kind === 'reorder');
    expect(reorders.length).toBeGreaterThan(0); // the page tabs DO reorder
    expect(reorders.some(s => s.id === 'RESULT' || s.afterId === 'RESULT')).toBe(false); // ...but never via RESULT
  });

  it('emits NO phantom reorder for an unchanged model with a Result tab (excluded from both orders)', () => {
    // The Result tab must be filtered from the desired group AND the natural/surviving order — excluding
    // it from only one made them mismatch and emit a spurious moveAfter for every page tab after it
    // (it showed as un-discardable "MOVED TAB" pending changes).
    const m = model(
      n({ id: 'RESULT', kind: 'tab', className: 'Tab', name: 'Result' }),
      n({ id: 't1', kind: 'tab', className: 'Tab', name: 'A' }),
      n({ id: 't2', kind: 'tab', className: 'Tab', name: 'B' }),
      n({ id: 't3', kind: 'tab', className: 'Tab', name: 'C' }),
    );
    expect(diff(m, m)).toEqual([]); // identity diff = no steps at all
  });

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
    // [A,B] → [B,A]: B moves to the front, a single moveBefore (minimal reorder — one op, not a cascade)
    expect(script).toContain('t.B.moveBefore(t.A)');
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
  it('lints empty tabs as ONE counted grey note (info), not per-tab warnings', () => {
    const m = model(
      n({ id: 'e1', kind: 'tab', className: 'Tab', name: 'Empty A', children: [] }),
      n({ id: 'e2', kind: 'tab', className: 'Tab', name: 'Empty B', children: [] }),
    );
    const msgs = lint(m, 'template', []);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].level).toBe('info');
    expect(msgs[0].text).toContain('2 tabs');
    expect(msgs[0].text).toContain('Empty A');
    expect(msgs[0].text).toContain('Empty B');
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
