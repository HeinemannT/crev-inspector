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
import { lint } from '../constraints';
import { parseFlows } from '../sync';
import { cloneModel } from '../model';
import {
  addFlowChild, reorderFlowChild, removeFlowAdd, setActionFlag, addActionButton,
  effectiveFlowChildren, findFlowContainer, flowDiff, flowSignature, trayButtons,
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
      createMode: 'EDITOREDIT', shared: true, container: 'RESULT',
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
  // mark the shared EditPage on both its projections (parseFlows does this from ref counts)
  flows['50845'].shared = true;
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
    // reorder back to natural → flowDiff sees order == natural → no steps
    const m3 = reorderFlowChild(m2, '50850', '50852', '50851');
    expect(flowDiff(base, m3)).toEqual([]);
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

  it('a staged add + reorder chains the moveAfter through the captured var', () => {
    const base = flowModel();
    let m2 = addFlowChild(base, '50850', 'NumberInput', 'Severity', '50851').model;
    const { script } = compile(flowDiff(base, m2), m2);
    const lines = script.split('\n');
    expect(lines[0]).toBe('_ff0 := t.50850.add(NumberInput, name := "Severity") // BMP assigns id');
    expect(lines).toContain('_ff0.moveAfter(t.50851)');   // the new node addressed by its var
    expect(lines).toContain('t.50852.moveAfter(_ff0)');   // and referenced by the follower
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
    `${FLOW_REF_MARKER}50845|r_cov|CreateObjectView|editpage|50865|r_ep|EditPage|CreateMode.editorAdd||||RESULT|Create Risk Statement`,
    `${FLOW_META_MARKER}50845|objectType|Risk Statement`,
    `${FLOW_META_MARKER}50845|destExpr|root.ceRiskAssessment`,
    `${FLOW_CHILD_MARKER}50845||50866|r_e1|EditField|1|0|0,0,1,0,0,|Edit field`,
    `${FLOW_CPROP_MARKER}50845|50866|risk_code`,
    `${FLOW_CHILD_MARKER}50845||50873|r_pb|EditPageBreak|0|1|0,0,0,0,0,|Page break`,
    `${FLOW_REF_MARKER}50848|r_cov2|CreateObjectView|editpage|50865|r_ep|EditPage|CreateMode.editorEdit||||RESULT|Create Risk Statement`,
    `${FLOW_REF_MARKER}50849|r_ab|ActionButton|action|||||ActionType.action|true|true|RESULT|`,
    `${FLOW_TR_MARKER}50849|1|ExtendedTransport|Extended action`,
    `${FLOW_REF_MARKER}50844|r_iv|InputView|inputset|50850|r_is|InputSet|||||RESULT|Input set`,
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

  it('marks a reference used by two on-page widgets as SHARED', () => {
    const flows = parseFlows(log);
    expect(flows.get('50845')?.shared).toBe(true);
    expect(flows.get('50848')?.shared).toBe(true);
    expect(flows.get('50844')?.shared).toBeUndefined(); // single-use InputSet
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
describe('flowSignature + shared lint', () => {
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

  it('lint warns once per SHARED reference behind staged flow edits, naming it', () => {
    const base = flowModel();
    const edited = addFlowChild(base, '50865', 'EditField').model;
    const msgs = lint(edited, 'instance', flowDiff(base, edited));
    const warnMsgs = msgs.filter(x => x.level === 'warn');
    expect(warnMsgs).toHaveLength(1);
    expect(warnMsgs[0].text).toContain('"Create Risk Statement" is shared');
    // an edit on the UN-shared InputSet stays quiet
    const quiet = addFlowChild(base, '50850', 'TextInput').model;
    expect(lint(quiet, 'instance', flowDiff(base, quiet)).filter(x => x.level === 'warn')).toEqual([]);
  });
});
