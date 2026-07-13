/**
 * Flow editing core — the plan's mandated coverage: diff isolation (pitfall 1), staging dedupe by
 * object id (pitfall 2), compiler shapes for each flow PlanStep, enum normalization on the fetch
 * parse, and tray tab-filtering. Wire fixtures mirror the live example-flow template
 * (t.template_example_flow / t.50850 / t.50865, projected 2026-07-11).
 */
import { describe, it, expect } from 'vitest';
import type { LModel, LNode, FlowProjection } from '../types';
import { diff } from '../diff';
import { compile } from '../ec';
import { createTabset } from '../edit';
import { parseFlows, parseFlowRefList, buildFlowRefListEc } from '../sync';
import { cloneModel } from '../model';
import {
  addFlowChild, reorderFlowChild, removeFlowAdd, setActionFlag, addActionButton,
  effectiveFlowChildren, findFlowContainer, flowDiff, flowSignature, trayButtons,
  stageNewFlowContainer, wireFlowRef, unwireFlowRef, effectiveRef, flowChangeCount, renameFlowObject,
} from '../flow';
import { FLOW_REF_MARKER, FLOW_META_MARKER, FLOW_CHILD_MARKER, FLOW_CPROP_MARKER, FLOW_TR_MARKER } from '../../layout-wire';

// ── factories ────────────────────────────────────────────────────────────────
const n = (p: Partial<LNode> & Pick<LNode, 'id' | 'kind' | 'className'>): LNode => ({
  name: p.id, cols: { L: 6 }, children: [], ...p,
});

/** A model shaped like the example-flow fixture: one tab, an InputView + a COV, with projections. */
function flowModel(): LModel {
  const flows: Record<string, FlowProjection> = {
    '50844': {
      ownerId: '50844', ownerRid: 'r_iv', ownerClass: 'InputView', kind: 'inputset',
      refId: '50850', refRid: 'r_is', refClass: 'InputSet', refName: 'Input set', container: 'RESULT',
      children: [
        { id: '50851', rid: 'r_ti', className: 'TextInput', name: 'Text input', dots: [{ prop: 'showExpression', set: false }, { prop: 'enableExpression', set: false }] },
        { id: '50852', rid: 'r_ni', className: 'NumberInput', name: 'Number input' },
        { id: '50858', rid: 'r_bg', className: 'ButtonGroup', name: 'Button group', children: [
          { id: '50860', rid: 'r_gb', className: 'ButtonInput', name: 'Button' },
        ] },
        { id: '50862', rid: 'r_va', className: 'Validation', name: 'Validation' },
      ],
    },
    '50845': {
      ownerId: '50845', ownerRid: 'r_cov', ownerClass: 'CreateObjectView', kind: 'editpage',
      refId: '50865', refRid: 'r_ep', refClass: 'EditPage', refName: 'Create Risk Statement',
      refParentClass: 'Category', refParentId: '50675',
      createMode: 'EDITORADD', objectType: 'Risk Statement', destExpr: 'root.ceRiskAssessment', container: 'RESULT',
      children: [
        { id: '50866', rid: 'r_e1', className: 'EditField', name: 'Edit field', prop: 'code' },
        { id: '50873', rid: 'r_pb', className: 'EditPageBreak', name: 'Page break', isBreak: true },
        { id: '50867', rid: 'r_e2', className: 'EditField', name: 'Edit field', required: true },
      ],
    },
    // a second COV sharing the SAME EditPage — drives the shared flag + dedupe scenarios
    '50848': {
      ownerId: '50848', ownerRid: 'r_cov2', ownerClass: 'CreateObjectView', kind: 'editpage',
      refId: '50865', refRid: 'r_ep', refClass: 'EditPage', refName: 'Create Risk Statement',
      createMode: 'EDITOREDIT', container: 'RESULT',
      children: [
        { id: '50866', rid: 'r_e1', className: 'EditField', name: 'Edit field' },
        { id: '50873', rid: 'r_pb', className: 'EditPageBreak', name: 'Page break', isBreak: true },
        { id: '50867', rid: 'r_e2', className: 'EditField', name: 'Edit field' },
      ],
    },
    // action-menu buttons for the tray
    '50849': { ownerId: '50849', ownerRid: 'r_ab1', ownerClass: 'ActionButton', kind: 'action', actionType: 'ACTION', displayOnActionMenu: true, displayOnAllTabs: true, container: 'RESULT', children: [], transports: [{ className: 'ExtendedTransport', name: 'Extended action', codeSet: true }] },
    '50863': { ownerId: '50863', ownerRid: 'r_ab2', ownerClass: 'ActionButton', kind: 'add', actionType: 'ADD', displayOnActionMenu: true, addItem: 'Risk Statement', container: 'tab2', children: [] },
    '50843': { ownerId: '50843', ownerRid: 'r_ab3', ownerClass: 'ActionButton', kind: 'action', actionType: 'ACTION', displayOnActionMenu: false, container: 'RESULT', children: [] },
  };
  return {
    pageId: 'template_example_flow', pageRid: 'r_page', pageClass: 'Scorecard', tabsetId: 'default_tabset',
    tabs: [n({ id: 'RESULT', kind: 'tab', className: 'Tab', name: 'Result', children: [
      n({ id: '50844', kind: 'widget', className: 'InputView', name: 'Input view' }),
      n({ id: '50845', kind: 'widget', className: 'CreateObjectView', name: 'COV Editor Add' }),
      n({ id: '50848', kind: 'widget', className: 'CreateObjectView', name: 'COV Editor Edit' }),
      n({ id: '50843', kind: 'widget', className: 'ActionButton', name: 'In page' }),
    ] })],
    target: 'instance', hasTemplate: false,
    flows,
  };
}

// ── pitfall 1: diff isolation ────────────────────────────────────────────────
describe('flow diff isolation (pitfall 1)', () => {
  it('a model WITH flow projections diffs byte-identically to the same model WITHOUT them', () => {
    const withFlow = flowModel();
    const withoutFlow: LModel = { ...cloneModel(withFlow) };
    delete withoutFlow.flows;
    const base = cloneModel(withFlow);
    expect(JSON.stringify(diff(base, withFlow))).toBe(JSON.stringify(diff(base, withoutFlow)));
    expect(diff(base, withFlow)).toEqual([]); // and it's empty — projections never leak into the layout diff
  });

  it('staged flow edits leave the LAYOUT diff empty (flow rides its own diff)', () => {
    const base = flowModel();
    const edited = addFlowChild(base, '50850', 'NumberInput', 'Severity').model;
    expect(diff(base, edited)).toEqual([]);            // layout diff untouched
    expect(flowDiff(base, edited)).toHaveLength(1);    // the flow diff carries it
  });

  it('flowDiff is empty on a freshly-loaded model (no flowEdits)', () => {
    const m = flowModel();
    expect(flowDiff(m, m)).toEqual([]);
  });
});

// ── pitfall 2: staging dedupe by object id ───────────────────────────────────
describe('flow staging dedupe (pitfall 2)', () => {
  it('an add staged on a shared EditPage (from either COV cell) stages ONCE and compiles ONCE', () => {
    const base = flowModel();
    // Both COVs (50845, 50848) reference EditPage 50865 — the edit is keyed by the PAGE's id, so
    // whichever cell the user adds from, there is exactly one staged edit and one compiled add.
    const edited = addFlowChild(base, '50865', 'EditField', 'New field').model;
    expect(Object.keys(edited.flowEdits!)).toEqual(['50865']);
    const steps = flowDiff(base, edited);
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({ kind: 'flowCreate', parentId: '50865', parentClass: 'EditPage' });
    // both projections RENDER the staged child (same effective children via the shared key)
    const eff = effectiveFlowChildren(edited, '50865').map(c => c.name);
    expect(eff[eff.length - 1]).toBe('New field');
  });

  it('a reorder staged via one cell is visible through the other cell (same key)', () => {
    const base = flowModel();
    const edited = reorderFlowChild(base, '50865', '50867', null); // move 50867 to the front
    expect(effectiveFlowChildren(edited, '50865').map(c => c.id)).toEqual(['50867', '50866', '50873']);
    const steps = flowDiff(base, edited);
    expect(steps.every(s => s.kind === 'flowReorder')).toBe(true);
    expect(new Set(steps.map(s => s.kind === 'flowReorder' ? s.parentId : ''))).toEqual(new Set(['50865']));
  });
});

// ── flow edit ops ────────────────────────────────────────────────────────────
describe('flow edit ops', () => {
  it('addFlowChild appends with an auto name and a temp id', () => {
    const { model: m2, id } = addFlowChild(flowModel(), '50850', 'DateInput');
    expect(id).toContain(':');
    const eff = effectiveFlowChildren(m2, '50850');
    expect(eff[eff.length - 1]).toMatchObject({ id, className: 'DateInput', name: 'New DateInput' });
  });

  it('addFlowChild afterId places the new child right after that sibling', () => {
    const { model: m2, id } = addFlowChild(flowModel(), '50850', 'NumberInput', 'Severity', '50851');
    expect(effectiveFlowChildren(m2, '50850').map(c => c.id)).toEqual(['50851', id, '50852', '50858', '50862']);
  });

  it('addFlowChild targets a nested ButtonGroup', () => {
    const { model: m2, id } = addFlowChild(flowModel(), '50858', 'ButtonInput');
    expect(effectiveFlowChildren(m2, '50858').map(c => c.id)).toEqual(['50860', id]);
    const steps = flowDiff(flowModel(), m2);
    expect(steps[0]).toMatchObject({ kind: 'flowCreate', parentId: '50858', parentClass: 'ButtonGroup', parentRid: 'r_bg' });
  });

  it('removeFlowAdd cancels a staged add (and only staged adds)', () => {
    const base = flowModel();
    const { model: m2, id } = addFlowChild(base, '50850', 'TextInput');
    const m3 = removeFlowAdd(m2, '50850', id);
    expect(m3.flowEdits ?? {}).toEqual({});
    expect(removeFlowAdd(base, '50850', '50851')).toBe(base); // an existing child is untouched
  });

  it('reorderFlowChild records the full desired order; a no-op order emits no steps', () => {
    const base = flowModel();
    const m2 = reorderFlowChild(base, '50850', '50852', '50858');
    expect(effectiveFlowChildren(m2, '50850').map(c => c.id)).toEqual(['50851', '50858', '50852', '50862']);
    // reorder back to natural → the entry COLLAPSES (no phantom pending, not just an empty diff)
    const m3 = reorderFlowChild(m2, '50850', '50852', '50851');
    expect(flowDiff(base, m3)).toEqual([]);
    expect(m3.flowEdits?.['50850']).toBeUndefined();
    expect(flowChangeCount(m3)).toBe(0);
  });

  it('setActionFlag stages a flip and clears when toggled back to the projection value', () => {
    const base = flowModel();
    const flipped = setActionFlag(base, '50843', 'displayOnActionMenu', true);
    expect(flowDiff(base, flipped)).toEqual([
      { kind: 'flowFlag', id: '50843', className: 'ActionButton', prop: 'displayOnActionMenu', value: true, rid: 'r_ab3' },
    ]);
    const back = setActionFlag(flipped, '50843', 'displayOnActionMenu', false);
    expect(back.flowEdits ?? {}).toEqual({});
  });

  it('addActionButton stages a page-level menu-button create born displayOnActionMenu', () => {
    const base = flowModel();
    const { model: m2, id } = addActionButton(base, 'RESULT', 'Escalate');
    const steps = flowDiff(base, m2);
    expect(steps.map(s => s.kind)).toEqual(['flowCreate', 'flowFlag']);
    expect(steps[0]).toMatchObject({ kind: 'flowCreate', parentId: '*page*' });
    expect(steps[1]).toMatchObject({ kind: 'flowFlag', id, prop: 'displayOnActionMenu', value: true });
  });

  it('findFlowContainer resolves refs and nested groups, and rejects unknowns', () => {
    const m = flowModel();
    expect(findFlowContainer(m, '50850')?.className).toBe('InputSet');
    expect(findFlowContainer(m, '50865')?.className).toBe('EditPage');
    expect(findFlowContainer(m, '50858')?.className).toBe('ButtonGroup');
    expect(findFlowContainer(m, 'nope')).toBeNull();
  });
});

// ── compiler shapes ──────────────────────────────────────────────────────────
describe('flow compiler shapes', () => {
  it('flowCreate compiles to <parent>.add(Class, name := …) with var capture', () => {
    const base = flowModel();
    const edited = addFlowChild(base, '50850', 'NumberInput', 'Severity').model;
    const { script } = compile(flowDiff(base, edited), edited);
    expect(script).toBe('_ff0 := t.50850.add(NumberInput, name := "Severity") // BMP assigns id');
  });

  it('a staged mid-list add emits its create + ONE minimal reorder (no follower cascade)', () => {
    const base = flowModel();
    const m2 = addFlowChild(base, '50850', 'NumberInput', 'Severity', '50851').model;
    const { script } = compile(flowDiff(base, m2), m2);
    const lines = script.split('\n');
    expect(lines[0]).toBe('_ff0 := t.50850.add(NumberInput, name := "Severity") // BMP assigns id');
    // the new node (appended by the create) is the ONLY displaced item — one moveAfter, addressed by var
    expect(lines).toContain('_ff0.moveAfter(t.50851)');
    expect(lines).toHaveLength(2);                        // create + one move — no redundant follower move
    expect(script).not.toContain('t.50852.moveAfter');   // the follower stays put (minimal)
  });

  it('flowFlag compiles to change(prop := TRUE/FALSE)', () => {
    const base = flowModel();
    const edited = setActionFlag(base, '50849', 'displayOnAllTabs', false);
    const { script } = compile(flowDiff(base, edited), edited);
    expect(script).toBe('t.50849.change(displayOnAllTabs := FALSE)');
  });

  it('a new action-menu button compiles to _sc.add(ActionButton, container := …) + the flag', () => {
    const base = flowModel();
    const m2 = addActionButton(base, 'RESULT', 'Escalate').model;
    const { script } = compile(flowDiff(base, m2), m2);
    const lines = script.split('\n');
    expect(lines[0]).toBe('_sc := t.template_example_flow');
    expect(lines[1]).toBe('_ff0 := _sc.add(ActionButton, name := "Escalate", container := t.RESULT) // BMP assigns id');
    expect(lines[2]).toBe('_ff0.change(displayOnActionMenu := TRUE)');
  });

  it('a hostile name is escaped through ec-guards (pitfall 8)', () => {
    const base = flowModel();
    const edited = addFlowChild(base, '50850', 'TextInput', 'He said "hi"\nand left').model;
    const { script } = compile(flowDiff(base, edited), edited);
    expect(script).toContain('name := "He said \\"hi\\"\\nand left"'); // quotes + newline escaped
  });

  it('a businessId-less flow parent falls back to lookup(rid) (pitfall 5)', () => {
    const base = flowModel();
    const proj = base.flows!['50844'];
    proj.refId = '999999999999999999901'; proj.refRid = '999999999999999999901'; // id === rid convention
    const edited = addFlowChild(base, '999999999999999999901', 'TextInput', 'X').model;
    const { script } = compile(flowDiff(base, edited), edited);
    expect(script).toContain('lookup(999999999999999999901).add(TextInput');
  });
});

// ── enum normalization on the fetch parse ────────────────────────────────────
describe('parseFlows enum normalization + wire parsing (pitfalls 3/4)', () => {
  const log = [
    `${FLOW_REF_MARKER}50845|r_cov|CreateObjectView|editpage|50865|r_ep|EditPage|CreateMode.editorAdd||||RESULT|Category|50675|Create Risk Statement`,
    `${FLOW_META_MARKER}50845|objectType|Risk Statement`,
    `${FLOW_META_MARKER}50845|destExpr|root.ceRiskAssessment`,
    `${FLOW_CHILD_MARKER}50845||50866|r_e1|EditField|1|0|0,0,1,0,0,|Edit field`,
    `${FLOW_CPROP_MARKER}50845|50866|risk_code`,
    `${FLOW_CHILD_MARKER}50845||50873|r_pb|EditPageBreak|0|1|0,0,0,0,0,|Page break`,
    `${FLOW_REF_MARKER}50848|r_cov2|CreateObjectView|editpage|50865|r_ep|EditPage|CreateMode.editorEdit||||RESULT|Category|50675|Create Risk Statement`,
    `${FLOW_REF_MARKER}50849|r_ab|ActionButton|action|||||ActionType.action|true|true|RESULT|||`,
    `${FLOW_TR_MARKER}50849|1|ExtendedTransport|Extended action`,
    `${FLOW_REF_MARKER}50844|r_iv|InputView|inputset|50850|r_is|InputSet|||||RESULT|Category|50675|Input set`,
    `${FLOW_CHILD_MARKER}50844||50858|r_bg|ButtonGroup|0|0|0,0,0,0,0,|Button group`,
    `${FLOW_CHILD_MARKER}50844|50858|50860|r_gb|ButtonInput|0|0|1,0,0,0,0,|Button`,
  ].join('\n');

  it('normalizes BMP EnumName.value forms to bare uppercase members', () => {
    const flows = parseFlows(log);
    expect(flows.get('50845')?.createMode).toBe('EDITORADD'); // CreateMode.editorAdd
    expect(flows.get('50848')?.createMode).toBe('EDITOREDIT');
    expect(flows.get('50849')?.actionType).toBe('ACTION');    // ActionType.action
  });

  it('parses children with required/break/dots/caption, nesting grandchildren under the ButtonGroup', () => {
    const flows = parseFlows(log);
    const cov = flows.get('50845')!;
    expect(cov.objectType).toBe('Risk Statement');
    expect(cov.destExpr).toBe('root.ceRiskAssessment');
    const [ef, pb] = cov.children;
    expect(ef).toMatchObject({ id: '50866', className: 'EditField', required: true, prop: 'risk_code' });
    expect(ef.dots).toEqual([{ prop: 'showExpression', set: true }, { prop: 'enableExpression', set: false }]);
    expect(pb.isBreak).toBe(true);
    const iv = flows.get('50844')!;
    expect(iv.children.map(c => c.id)).toEqual(['50858']);
    expect(iv.children[0].children?.map(c => c.id)).toEqual(['50860']);
    expect(iv.children[0].children?.[0].dots).toEqual([{ prop: 'expression', set: true }, { prop: 'afterExpression', set: false }]);
  });

  it('keeps transports as read-only rows with code presence', () => {
    const flows = parseFlows(log);
    expect(flows.get('50849')?.transports).toEqual([{ className: 'ExtendedTransport', name: 'Extended action', codeSet: true }]);
  });
});

// ── tray filtering ───────────────────────────────────────────────────────────
describe('trayButtons tab filtering', () => {
  it('shows the viewed tab\'s buttons + all-tabs + RESULT-bound; counts the rest honestly', () => {
    const m = flowModel();
    const t1 = trayButtons(m, 'tab1');
    // 50849 (all tabs, RESULT) shown; 50863 bound to tab2, NOT all-tabs → other count
    expect(t1.shown.map(e => e.p.ownerId)).toEqual(['50849']);
    expect(t1.otherTabs).toBe(1);
    const t2 = trayButtons(m, 'tab2');
    expect(t2.shown.map(e => e.p.ownerId).sort()).toEqual(['50849', '50863']);
    expect(t2.otherTabs).toBe(0);
  });

  it('excludes in-grid buttons, and respects a STAGED displayOnActionMenu flip both ways', () => {
    const base = flowModel();
    expect(trayButtons(base, 'tab2').shown.some(e => e.p.ownerId === '50843')).toBe(false); // in-grid
    const moved = setActionFlag(base, '50843', 'displayOnActionMenu', true);
    expect(trayButtons(moved, 'tab2').shown.some(e => e.p.ownerId === '50843')).toBe(true);
    // staged to the grid: the card STAYS (flagged leaving) — it has no grid cell until Apply
    const pulled = setActionFlag(base, '50849', 'displayOnActionMenu', false);
    const entry = trayButtons(pulled, 'tab2').shown.find(e => e.p.ownerId === '50849');
    expect(entry?.leaving).toBe(true);
  });
});

// ── signature + lint ─────────────────────────────────────────────────────────
describe('flowSignature', () => {
  it('signature is stable across clones and changes on membership/order/flag drift', () => {
    const m = flowModel();
    expect(flowSignature(cloneModel(m))).toBe(flowSignature(m));
    // cloneModel SHARES projection objects (flows are read-only by contract), so a "changed" model
    // must REPLACE the projection, not mutate it — same as a fresh fetch producing new projections.
    const grew = cloneModel(m);
    grew.flows!['50844'] = { ...grew.flows!['50844'], children: [...grew.flows!['50844'].children, { id: 'x', className: 'TextInput', name: 'X' }] };
    expect(flowSignature(grew)).not.toBe(flowSignature(m));
    const flagged = cloneModel(m);
    flagged.flows!['50849'] = { ...flagged.flows!['50849'], displayOnAllTabs: false };
    expect(flowSignature(flagged)).not.toBe(flowSignature(m));
  });

  it('signature includes NAMES, so a rename-only apply is not misread as a rollback', () => {
    // A committed rename changes a child's / reference's NAME but no id, membership, order or flag. If
    // the signature ignored names the silent-rollback guard would declare a successful rename discarded.
    const m = flowModel();
    const childRenamed = cloneModel(m);
    childRenamed.flows!['50844'] = { ...childRenamed.flows!['50844'],
      children: childRenamed.flows!['50844'].children.map(c => c.id === '50851' ? { ...c, name: 'Owner' } : c) };
    expect(flowSignature(childRenamed)).not.toBe(flowSignature(m));
    const refRenamed = cloneModel(m);
    refRenamed.flows!['50844'] = { ...refRenamed.flows!['50844'], refName: 'Renamed set' };
    expect(flowSignature(refRenamed)).not.toBe(flowSignature(m));
    // a name containing the old delimiters can't forge a collision (JSON, not string-join)
    const tricky = cloneModel(m);
    tricky.flows!['50844'] = { ...tricky.flows!['50844'],
      children: tricky.flows!['50844'].children.map(c => c.id === '50851' ? { ...c, name: 'a:b|c,d' } : c) };
    expect(flowSignature(tricky)).not.toBe(flowSignature(m));
  });

});

// ── staged-new references (create a NEW InputSet / EditPage from blueprint) ──
describe('staged-new InputSet / EditPage + reference wiring', () => {
  it('stageNewFlowContainer stages a temp-keyed container + the widget wire; children stage underneath', () => {
    const base = flowModel();
    const { model: m2, id } = stageNewFlowContainer(base, '50844', 'inputSet', 'Owner input set');
    expect(id).toContain(':');
    expect(m2.flowEdits?.[id]?.newContainer).toEqual({ className: 'InputSet', name: 'Owner input set' });
    expect(m2.flowEdits?.['50844']?.wireRef).toMatchObject({ prop: 'inputSet', targetId: id, targetClass: 'InputSet' });
    // the temp key resolves as a flow container with EMPTY original children — adds stage right away
    expect(findFlowContainer(m2, id)).toMatchObject({ className: 'InputSet', original: [] });
    const m3 = addFlowChild(m2, id, 'TextInput', 'Name').model;
    expect(effectiveFlowChildren(m3, id).map(c => c.name)).toEqual(['Name']);
  });

  it('a COV gaining an editPage in ADD mode stages the EDITORADD flip; EDITOR* modes do not', () => {
    const base = flowModel();
    // 50842-style: a COV in ADD mode (no projection entry in the fixture has ADD; craft one)
    base.flows!['50842'] = { ownerId: '50842', ownerClass: 'CreateObjectView', kind: 'editpage', createMode: 'ADD', children: [] };
    const flip = stageNewFlowContainer(base, '50842', 'editPage', 'P').model;
    expect(flip.flowEdits?.['50842']?.wireRef?.setCreateMode).toBe(true);
    // 50848 is EDITOREDIT — wiring a page must NOT flip its mode
    const keep = wireFlowRef(base, '50848', 'editPage', '50865x', 'EditPage', 'Other page');
    expect(keep.flowEdits?.['50848']?.wireRef?.setCreateMode).toBeUndefined();
  });

  it('wireFlowRef back to the live reference clears; unwireFlowRef cascades the staged-new container', () => {
    const base = flowModel();
    const wired = wireFlowRef(base, '50844', 'inputSet', 'is_other', 'InputSet', 'Other set');
    expect(effectiveRef(wired, '50844')).toMatchObject({ id: 'is_other', staged: true, isNew: false });
    expect(wireFlowRef(base, '50844', 'inputSet', '50850', 'InputSet').flowEdits ?? {}).toEqual({}); // no-op wire
    const { model: m2, id } = stageNewFlowContainer(base, '50844', 'inputSet', 'S');
    const m3 = addFlowChild(m2, id, 'TextInput').model;
    expect(unwireFlowRef(m3, '50844').flowEdits ?? {}).toEqual({}); // wire + container + its adds all gone
  });

  it('re-wiring a widget away from a staged-new container drops the orphaned container', () => {
    const base = flowModel();
    const { model: m2, id } = stageNewFlowContainer(base, '50844', 'inputSet', 'S');
    const m3 = wireFlowRef(m2, '50844', 'inputSet', 'is_other', 'InputSet');
    expect(m3.flowEdits?.[id]).toBeUndefined();
    expect(m3.flowEdits?.['50844']?.wireRef?.targetId).toBe('is_other');
  });

  it('compiles: co-locates the new container into the on-page reference Category, then children, then the wire', () => {
    const base = flowModel();
    const { model: m2, id } = stageNewFlowContainer(base, '50844', 'inputSet', 'Owner input set');
    const m3 = addFlowChild(m2, id, 'TextInput', 'Name').model;
    const { script } = compile(flowDiff(base, m3), m3);
    const lines = script.split('\n');
    // Category 50675 hosts the fixture's set+page (refParentClass) → co-locate there
    expect(lines[0]).toBe('_ff0 := t.50675.add(InputSet, name := "Owner input set") // BMP assigns id');
    expect(lines[1]).toBe('_ff1 := _ff0.add(TextInput, name := "Name") // BMP assigns id');
    expect(lines[lines.length - 1]).toBe('t.50844.change(inputSet := _ff0)');
  });

  it('compiles: with NO on-page Category, ONE support Category is created and REUSED for a set + a page', () => {
    const base = flowModel();
    // strip the Category parents so the landing falls back to the new support folder
    for (const k of Object.keys(base.flows!)) {
      base.flows![k] = { ...base.flows![k], refParentClass: undefined, refParentId: undefined };
    }
    let m2 = stageNewFlowContainer(base, '50844', 'inputSet', 'S').model;
    m2 = stageNewFlowContainer(m2, '50845', 'editPage', 'P').model;
    const { script } = compile(flowDiff(base, m2), m2);
    const catLines = script.split('\n').filter(l => l.includes('root.portal.add(Category'));
    expect(catLines).toHaveLength(1); // created once, reused
    // named after the page (display name → falls back to pageId here); NOT "<pageId> support" anymore
    expect(catLines[0]).toContain('name := "template_example_flow"');
    expect(script).toContain('_fcat.add(InputSet, name := "S")');
    expect(script).toContain('_fcat.add(EditPage, name := "P")');
  });

  it('compiles: uses the page DISPLAY NAME for the support Category when the model carries one', () => {
    const base = flowModel();
    base.pageName = 'Example Flow objects';
    for (const k of Object.keys(base.flows!)) {
      base.flows![k] = { ...base.flows![k], refParentClass: undefined, refParentId: undefined };
    }
    const m2 = stageNewFlowContainer(base, '50844', 'inputSet', 'S').model;
    const { script } = compile(flowDiff(base, m2), m2);
    expect(script).toContain('root.portal.add(Category, name := "Example Flow objects")');
  });

  it('compiles: a NEW tabset + a NEW InputSet in ONE apply share a SINGLE support Category', () => {
    // RESULT-only page with a reference-less InputView → create a tabset AND a new set in one apply.
    const base: LModel = {
      pageId: 'pg_flow', pageName: 'My Page', pageClass: 'Scorecard', tabsetId: 'default_tabset',
      target: 'instance', hasTemplate: false, resultOnly: true,
      tabs: [n({ id: 'RESULT', kind: 'tab', className: 'Tab', name: 'Result', children: [
        n({ id: 'iv1', kind: 'widget', className: 'InputView', name: 'IV' }),
      ] })],
      flows: { iv1: { ownerId: 'iv1', ownerClass: 'InputView', kind: 'inputset', children: [] } },
    };
    const staged = createTabset(base);                       // virtual tabset + Main tab, widget rehomed
    const withRef = stageNewFlowContainer(staged.model, 'iv1', 'inputSet', 'New set');
    const plan = [...diff(base, withRef.model), ...flowDiff(base, withRef.model)];
    const { script } = compile(plan, withRef.model);
    const catLines = script.split('\n').filter(l => l.includes('root.portal.add(Category'));
    expect(catLines).toHaveLength(1);                        // ONE Category for both landings
    expect(catLines[0]).toContain('name := "My Page"');      // named after the page display name
    expect(script).toContain('_ts := _fcat.add(TabSet');     // tabset lands in it
    expect(script).toContain('_fcat.add(InputSet, name := "New set")'); // the new set lands in it too
  });

  it('compiles: co-locates a NEW tabset into an EXISTING on-page reference Category (no duplicate)', () => {
    // Same shape but the InputView already references an on-page set living in Category cat9 → the new
    // tabset must reuse cat9, NOT create a fresh support Category.
    const base: LModel = {
      pageId: 'pg2', pageName: 'Page 2', pageClass: 'Scorecard', tabsetId: 'default_tabset',
      target: 'instance', hasTemplate: false, resultOnly: true,
      tabs: [n({ id: 'RESULT', kind: 'tab', className: 'Tab', name: 'Result', children: [
        n({ id: 'iv2', kind: 'widget', className: 'InputView', name: 'IV' }),
      ] })],
      flows: { iv2: { ownerId: 'iv2', ownerClass: 'InputView', kind: 'inputset',
        refId: 'is9', refClass: 'InputSet', refName: 'Set', refParentClass: 'Category', refParentId: 'cat9', refParentName: 'Support', children: [] } },
    };
    const staged = createTabset(base);
    const { script } = compile(diff(base, staged.model), staged.model);
    expect(script).not.toContain('root.portal.add(Category'); // reuse, don't duplicate
    expect(script).toContain('_ts := t.cat9.add(TabSet');     // lands in the existing Category
  });

  it('compiles: var-to-var wiring — a STAGED widget wired to a STAGED container', () => {
    const base = flowModel();
    // a freshly-staged InputView from the grid picker (temp layout id), wired to a staged-new set
    const widgetId = 'w:9';
    base.tabs[0].children.push(n({ id: widgetId, kind: 'widget', className: 'InputView', name: 'New view' }));
    const desired = cloneModel(base);
    desired.tabs[0] = base.tabs[0]; // keep the added widget in desired only
    const { model: m2 } = stageNewFlowContainer(desired, widgetId, 'inputSet', 'S');
    // compose layout + flow plans the way applyModel does — the layout create runs first and captures _n0
    const pristine = flowModel();
    const plan = [...diff(pristine, m2), ...flowDiff(pristine, m2)];
    const { script } = compile(plan, m2);
    expect(script).toContain('_n0 := _sc.add(InputView'); // layout create captures the widget var
    expect(script).toContain(`.add(InputSet, name := "S")`);
    expect(script.split('\n').pop()).toBe('_n0.change(inputSet := _ff0)'); // var-to-var wire, last
  });

  it('compiles: the EDITORADD flip folds into the SAME change() as the wire', () => {
    const base = flowModel();
    base.flows!['50842'] = { ownerId: '50842', ownerRid: 'r_cov0', ownerClass: 'CreateObjectView', kind: 'editpage', createMode: 'ADD', children: [] };
    const wired = wireFlowRef(base, '50842', 'editPage', '50865', 'EditPage', 'Create Risk Statement');
    const { script } = compile(flowDiff(base, wired), wired);
    expect(script).toBe('t.50842.change(editPage := t.50865, createMode := "EDITORADD")');
  });

  it('a wired existing off-page reference resolves its on-demand children; adds + reorders layer on top', () => {
    const base = flowModel();
    // wire InputView 50844 to an OFF-page InputSet, then inject its fetched children (FIX 2 cache)
    let m = wireFlowRef(base, '50844', 'inputSet', 'ext_is', 'InputSet', 'Shared set');
    m = { ...m, flowRefChildren: { ext_is: { className: 'InputSet', rid: 'r_ext', children: [
      { id: 'x1', className: 'TextInput', name: 'Existing A' },
      { id: 'x2', className: 'NumberInput', name: 'Existing B' },
    ] } } };
    expect(findFlowContainer(m, 'ext_is')).toMatchObject({ className: 'InputSet', rid: 'r_ext' });
    expect(effectiveFlowChildren(m, 'ext_is').map(c => c.name)).toEqual(['Existing A', 'Existing B']);
    // an add lands under the fetched children (cloneModel carries flowRefChildren forward)
    const m2 = addFlowChild(m, 'ext_is', 'TextInput', 'New C').model;
    expect(effectiveFlowChildren(m2, 'ext_is').map(c => c.name)).toEqual(['Existing A', 'Existing B', 'New C']);
    // reorder rides the SAME engine — move the new child to the front
    const newId = effectiveFlowChildren(m2, 'ext_is')[2].id;
    const m3 = reorderFlowChild(m2, 'ext_is', newId, null);
    expect(effectiveFlowChildren(m3, 'ext_is')[0].name).toBe('New C');
    // compiles: the add targets the existing set by id + a single move (New C to the front → moveBefore)
    const { script } = compile(flowDiff(base, m3), m3);
    expect(script).toContain('t.ext_is.add(TextInput, name := "New C")');
    expect(script).toContain('_ff0.moveBefore(t.x1)');
  });

  it('flowSignature covers refId so a pure wire apply is not misread as a rollback', () => {
    const m = flowModel();
    const rewired = cloneModel(m);
    rewired.flows!['50844'] = { ...rewired.flows!['50844'], refId: 'is_other' };
    expect(flowSignature(rewired)).not.toBe(flowSignature(m));
  });

  it('parseFlows reads the reference parent (Category co-location source)', () => {
    const log = `${FLOW_REF_MARKER}50844|r_iv|InputView|inputset|50850|r_is|InputSet|||||RESULT|Category|50675|Input set`;
    const flows = parseFlows(log);
    expect(flows.get('50844')).toMatchObject({ refParentClass: 'Category', refParentId: '50675' });
  });

  it('parseFlowRefList reads the wire-to-existing rows (name last, pipes survive)', () => {
    const log = [
      '<<<CREV_FLST>>>is1|111|InputSet|Cat A|Owner set',
      '<<<CREV_FLST>>>ep1|222|EditPage|Cat B|Create X | pipe',
      '<<<CREV_FLST>>>|333|InputSet||dropped (no bid)',
    ].join('\n');
    const rows = parseFlowRefList(log);
    expect(rows).toEqual([
      { id: 'is1', rid: '111', className: 'InputSet', category: 'Cat A', name: 'Owner set' },
      { id: 'ep1', rid: '222', className: 'EditPage', category: 'Cat B', name: 'Create X | pipe' },
    ]);
    expect(buildFlowRefListEc('EditPage')).toContain('SELECT EditPage FROM root.portal');
  });
});

// The chip's Apply/Discard/tray gate on this count (view.ts:pendingCount). It regressed once because
// pendingCount summed only layout changes — a flow-only session read "0 pending" and could not be
// applied. These lock the count that fix now depends on: it must be non-zero for every flow edit kind.
describe('flowChangeCount (drives Apply/Discard/tray enablement)', () => {
  it('is 0 for an unedited model', () => {
    expect(flowChangeCount(flowModel())).toBe(0);
  });

  it('counts a flow-only session so Apply unlocks without any layout change', () => {
    const base = flowModel();
    expect(flowChangeCount(addFlowChild(base, '50850', 'TextInput').model)).toBe(1);
    // a GENUINE reorder (50852 after 50858, not its natural slot) — a no-op drop collapses to 0
    expect(flowChangeCount(reorderFlowChild(base, '50850', '50852', '50858'))).toBe(1);
    expect(flowChangeCount(setActionFlag(base, '50843', 'displayOnActionMenu', true))).toBe(1);
    // Staging a NEW container touches TWO flow objects — the new container itself and the widget whose
    // reference is wired to it — so the count is 2. Either way it's > 0, which is what unlocks Apply.
    expect(flowChangeCount(stageNewFlowContainer(base, '50844', 'inputSet', 'S').model)).toBe(2);
  });

  it('counts each touched flow object once (dedupe by object id, pitfall 2)', () => {
    const base = flowModel();
    // two adds to the SAME set = one touched object; a second, different set = two.
    let m2 = addFlowChild(base, '50850', 'TextInput', 'A').model;
    m2 = addFlowChild(m2, '50850', 'NumberInput', 'B').model;
    expect(flowChangeCount(m2)).toBe(1);
    m2 = addFlowChild(m2, '50865', 'EditField', 'C').model;
    expect(flowChangeCount(m2)).toBe(2);
  });
});

// ── rename a flow object (inline rename, shared machinery) ───────────────────
describe('renameFlowObject', () => {
  it('renames an EXISTING child: stages a per-object rename, overlays the display, compiles a change()', () => {
    const base = flowModel();
    const m1 = renameFlowObject(base, '50851', 'Renamed field')!;
    expect(m1.flowEdits?.['50851']?.rename).toBe('Renamed field');
    // the effective children show the new name (renderer + reorder-id source both read this)
    expect(effectiveFlowChildren(m1, '50850').find(c => c.id === '50851')?.name).toBe('Renamed field');
    // layout diff stays empty; the flow diff carries exactly one rename → change(name := …)
    expect(diff(base, m1)).toEqual([]);
    const plan = flowDiff(base, m1);
    // rid threaded from the child projection (lookup() fallback for a businessId-less row)
    expect(plan).toEqual([{ kind: 'flowRename', id: '50851', name: 'Renamed field', rid: 'r_ti' }]);
    expect(compile(plan, m1).script).toBe('t.50851.change(name := "Renamed field")');
    expect(flowChangeCount(m1)).toBe(1); // a rename-only edit unlocks Apply
  });

  it('dedupes repeated renames of one object, and clears when renamed back to the original', () => {
    const base = flowModel();
    let m = renameFlowObject(base, '50851', 'First')!;
    m = renameFlowObject(m, '50851', 'Second')!;
    expect(Object.keys(m.flowEdits ?? {})).toEqual(['50851']); // one key, not two
    expect(flowDiff(base, m).filter(s => s.kind === 'flowRename')).toHaveLength(1);
    const back = renameFlowObject(m, '50851', 'Text input')!; // the fixture's original name
    expect(back.flowEdits?.['50851']).toBeUndefined();
  });

  it('a staged rename SURVIVES a later unrelated edit (clone must carry rename)', () => {
    // regression: cloneFlowEdits dropped `rename`, so a rename on A vanished the moment ANY second
    // action cloned the model — leaving the rename un-applied and a phantom empty entry for A.
    const base = flowModel();
    const renamed = renameFlowObject(base, '50851', 'Kept name')!;
    expect(cloneModel(renamed).flowEdits?.['50851']?.rename).toBe('Kept name'); // clone alone must keep it
    const then = addFlowChild(renamed, '50865', 'EditField', 'New field').model; // a DIFFERENT edit clones
    expect(then.flowEdits?.['50851']?.rename).toBe('Kept name');
    expect(effectiveFlowChildren(then, '50850').find(c => c.id === '50851')?.name).toBe('Kept name');
    expect(flowDiff(base, then).some(s => s.kind === 'flowRename' && s.id === '50851')).toBe(true);
  });

  it('renames a STAGED-ADD child in place (name rides the create — no separate rename step)', () => {
    const base = flowModel();
    const { model: m1, id } = addFlowChild(base, '50850', 'TextInput', 'Auto');
    const m2 = renameFlowObject(m1, id, 'Chosen name')!;
    // the add node itself carries the new name; there is NO flowRename step, just the create
    const plan = flowDiff(base, m2);
    expect(plan.filter(s => s.kind === 'flowRename')).toHaveLength(0);
    const create = plan.find(s => s.kind === 'flowCreate')!;
    expect(create.kind === 'flowCreate' && create.node.name).toBe('Chosen name');
    expect(compile(plan, m2).script).toContain('.add(TextInput, name := "Chosen name")');
  });

  it('renames a STAGED-NEW container: updates its name + the wiring label; no rename step', () => {
    const base = flowModel();
    const { model: m1, id } = stageNewFlowContainer(base, '50844', 'inputSet', 'Auto set');
    const m2 = renameFlowObject(m1, id, 'Owner input set')!;
    expect(m2.flowEdits?.[id]?.newContainer?.name).toBe('Owner input set');
    expect(m2.flowEdits?.['50844']?.wireRef?.targetName).toBe('Owner input set'); // band label follows
    expect(effectiveRef(m2, '50844')?.name).toBe('Owner input set');
    const plan = flowDiff(base, m2);
    expect(plan.filter(s => s.kind === 'flowRename')).toHaveLength(0); // name rides the create
    expect(compile(plan, m2).script).toContain('.add(InputSet, name := "Owner input set")');
  });

  it('renames an EXISTING reference (InputSet), and escapes a hostile name', () => {
    const base = flowModel();
    const m = renameFlowObject(base, '50850', 'Danger" set')!;
    const plan = flowDiff(base, m);
    expect(plan).toHaveLength(1);
    expect(compile(plan, m).script).toBe('t.50850.change(name := "Danger\\" set")');
  });

  it('is a no-op for an empty name', () => {
    expect(renameFlowObject(flowModel(), '50851', '   ')).toBeNull();
  });
});
