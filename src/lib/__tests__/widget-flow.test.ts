/**
 * Tests for the Flow walker EC paths in BmpClient.
 * Verifies parsing of InputView, ActionButton, and Label flow responses,
 * and that the literal-key cross-reference detection works.
 */
import { describe, it, expect, vi } from 'vitest';
import { BmpClient } from '../bmp-client';
import './chrome-mock';

function makeClient(log: string) {
  const c = new BmpClient('http://localhost/Steadfast/', 'admin', 'pw');
  c.supportsLookup = true;
  // bypass network — stub executeEc to return a canned log
  (c as unknown as { executeEc: (..._: unknown[]) => Promise<unknown> }).executeEc =
    vi.fn(async () => ({ ok: true, log, hasError: false, hasWarning: false }));
  return c;
}

const SEP = '<<<CREV_SEP>>>';

describe('fetchFlowChain — InputView', () => {
  it('parses InputView → InputSet → children with key + EC', async () => {
    const log = [
      `${SEP}iv${SEP}1000|iv_create|Create Risk|InputView`,
      `${SEP}is${SEP}1001|is_create|is_create|InputSet`,
      `${SEP}children${SEP}\n1002|in_title|Title|TextInput|title\n1003|in_notes|Notes|TextInput|notes\n1004|bi_submit|Submit|ButtonInput|\n`,
      `${SEP}child_afterExpression_1002${SEP}`,
      `${SEP}child_expression_1002${SEP}`,
      `${SEP}child_defaultExpression_1002${SEP}`,
      `${SEP}child_afterExpression_1003${SEP}`,
      `${SEP}child_expression_1003${SEP}`,
      `${SEP}child_defaultExpression_1003${SEP}`,
      `${SEP}child_afterExpression_1004${SEP}\n_o := root.add(t.risk, this.input.title)\n_o.notes := this.input.notes\n`,
      `${SEP}child_expression_1004${SEP}`,
      `${SEP}child_defaultExpression_1004${SEP}`,
      `${SEP}DONE`,
    ].join('\n');
    const c = makeClient(log);
    const chain = await c.fetchFlowChain('1000', 'InputView');
    expect(chain).not.toBeNull();
    expect(chain!.steps).toHaveLength(1);
    const iv = chain!.steps[0];
    expect(iv.identity.type).toBe('InputView');
    expect(iv.children).toHaveLength(1);
    const is = iv.children![0];
    expect(is.identity.type).toBe('InputSet');
    expect(is.edgeLabel).toBe('inputSet');
    expect(is.children).toHaveLength(3);

    // First two children are TextInputs with keys; no EC
    const titleChild = is.children!.find(c => c.inputKey === 'title')!;
    expect(titleChild.inputKey).toBe('title');
    expect(titleChild.codeFields).toBeUndefined();

    // Submit ButtonInput has afterExpression and reads both keys
    const submitChild = is.children!.find(c => c.identity.type === 'ButtonInput')!;
    expect(submitChild.codeFields).toBeDefined();
    const after = submitChild.codeFields!.find(c => c.prop === 'afterExpression');
    expect(after).toBeDefined();
    expect(after!.reads).toBeDefined();
    expect(after!.reads!.map(r => r.key).sort()).toEqual(['notes', 'title']);
  });

  it('nests a ButtonGroup\'s buttons and a ButtonInput\'s action graph (t.153 shape)', async () => {
    const log = [
      `${SEP}iv${SEP}1000|iv_t|Input view|InputView`,
      `${SEP}is${SEP}1001|is_t|Input set|InputSet`,
      // direct children: an action ButtonInput + a ButtonGroup
      `${SEP}children${SEP}\n1002|btn_act|Button|ButtonInput|\n1003|grp|Button group|ButtonGroup|\n`,
      `${SEP}child_expression_1002${SEP}`,
      // ButtonGroup's nested buttons (groupRid|childRid|id|name|className|key)
      `${SEP}groupkids${SEP}\n1003|1004|btn_a|Button|ButtonInput|\n1003|1005|btn_b|Button|ButtonInput|\n`,
      `${SEP}child_expression_1004${SEP}\nt.x := 1\n`,
      // action subtree: btn 1002 → NTG 2000 → 2 transports
      `${SEP}actiongroups${SEP}\n1002|2000|101|Action group|NotificationTransportGroup\n`,
      `${SEP}actiontransports${SEP}\n2000|2001|148|Extended action|ExtendedTransport\n2000|2002|146|Update object property|ChangePropertyTransport\n`,
      `${SEP}child_expression_2001${SEP}\nrecipient := t.owner.email\n`,
      `${SEP}child_value_2002${SEP}\n"Pending"\n`,
      `${SEP}child_function_2002${SEP}`,
      `${SEP}DONE`,
    ].join('\n');
    const c = makeClient(log);
    const chain = await c.fetchFlowChain('1000', 'InputView');
    const is = chain!.steps[0].children![0];
    expect(is.children).toHaveLength(2);

    // action button → actionObject (NTG) → transports
    const actBtn = is.children!.find(ch => ch.identity.rid === '1002')!;
    expect(actBtn.children).toHaveLength(1);
    const ntg = actBtn.children![0];
    expect(ntg.identity.type).toBe('NotificationTransportGroup');
    expect(ntg.children).toHaveLength(2);
    const ext = ntg.children!.find(t => t.identity.type === 'ExtendedTransport')!;
    expect(ext.codeFields!.map(f => f.prop)).toEqual(['expression']);
    const cpt = ntg.children!.find(t => t.identity.type === 'ChangePropertyTransport')!;
    // value populated, function empty → only value surfaces
    expect(cpt.codeFields!.map(f => f.prop)).toEqual(['value']);

    // ButtonGroup → 2 nested buttons (one carries EC)
    const grp = is.children!.find(ch => ch.identity.type === 'ButtonGroup')!;
    expect(grp.children).toHaveLength(2);
    expect(grp.children!.every(b => b.identity.type === 'ButtonInput')).toBe(true);
    const withEc = grp.children!.find(b => b.identity.rid === '1004')!;
    expect(withEc.codeFields!.some(f => f.prop === 'expression')).toBe(true);
  });

  it('fans a shared actionObject out to every owning button (direct + group)', async () => {
    // A direct button AND a group button both fire the SAME transport group.
    // Each owner must get its own full copy of the group + transports.
    const log = [
      `${SEP}iv${SEP}1000|iv_t|Input view|InputView`,
      `${SEP}is${SEP}1001|is_t|Input set|InputSet`,
      `${SEP}children${SEP}\n1002|btn_act|Button|ButtonInput|\n1003|grp|Button group|ButtonGroup|\n`,
      `${SEP}child_expression_1002${SEP}`,
      `${SEP}groupkids${SEP}\n1003|1004|btn_a|Button|ButtonInput|\n`,
      `${SEP}child_expression_1004${SEP}`,
      // both 1002 and 1004 → the same NTG 2000 (emitted once per owner)
      `${SEP}actiongroups${SEP}\n1002|2000|101|Action group|NotificationTransportGroup\n1004|2000|101|Action group|NotificationTransportGroup\n`,
      // transports repeat per owner (deduped by the parser)
      `${SEP}actiontransports${SEP}\n2000|2001|148|Extended action|ExtendedTransport\n2000|2001|148|Extended action|ExtendedTransport\n`,
      `${SEP}child_expression_2001${SEP}\nrecipient := t.owner.email\n`,
      `${SEP}DONE`,
    ].join('\n');
    const c = makeClient(log);
    const chain = await c.fetchFlowChain('1000', 'InputView');
    const is = chain!.steps[0].children![0];

    const directBtn = is.children!.find(ch => ch.identity.rid === '1002')!;
    const groupBtn = is.children!.find(ch => ch.identity.type === 'ButtonGroup')!.children!
      .find(b => b.identity.rid === '1004')!;
    // Each owner gets its OWN nested NTG with the single (deduped) transport.
    for (const owner of [directBtn, groupBtn]) {
      expect(owner.children).toHaveLength(1);
      const ntg = owner.children![0];
      expect(ntg.identity.rid).toBe('2000');
      expect(ntg.children).toHaveLength(1); // deduped, not 2
      expect(ntg.children![0].codeFields!.map(f => f.prop)).toEqual(['expression']);
    }
  });

  it('absorbs a | inside an object name without shifting columns', async () => {
    // BMP names can't be escaped in EC; the parser anchors name between the
    // fixed leading ids and trailing className/key so a pipe in the name is
    // absorbed rather than corrupting the columns after it.
    const log = [
      `${SEP}iv${SEP}1000|iv_t|Create|InputView`,
      `${SEP}is${SEP}1001|is_t|Set|InputSet`,
      `${SEP}children${SEP}\n1002|in_x|Risk | Impact|TextInput|impact\n`,
      `${SEP}DONE`,
    ].join('\n');
    const c = makeClient(log);
    const chain = await c.fetchFlowChain('1000', 'InputView');
    const child = chain!.steps[0].children![0].children![0];
    expect(child.identity.name).toBe('Risk | Impact');
    expect(child.identity.type).toBe('TextInput');
    expect(child.inputKey).toBe('impact');
  });

  it('returns IV-only step when inputSet is unset', async () => {
    const log = [
      `${SEP}iv${SEP}1000|iv_floating|Lone IV|InputView`,
      `${SEP}DONE`,
    ].join('\n');
    const c = makeClient(log);
    const chain = await c.fetchFlowChain('1000', 'InputView');
    expect(chain).not.toBeNull();
    expect(chain!.steps[0].children).toBeUndefined();
  });
});

describe('fetchFlowChain — ActionButton', () => {
  it('parses ActionButton with actionType=ADD (expression is the EC)', async () => {
    const log = [
      `${SEP}ab${SEP}2000|ab_inline|Inline AB|ActionButton|ADD`,
      `${SEP}ab_expression${SEP}\nroot.foo()\n`,
      `${SEP}ab_initExpression${SEP}`,
      `${SEP}ab_afterExpression${SEP}`,
      `${SEP}ab_showExpression${SEP}`,
      `${SEP}DONE`,
    ].join('\n');
    const c = makeClient(log);
    const chain = await c.fetchFlowChain('2000', 'ActionButton');
    expect(chain).not.toBeNull();
    const ab = chain!.steps[0];
    expect(ab.codeFields).toBeDefined();
    expect(ab.codeFields!.map(c => c.prop)).toContain('expression');
    expect(ab.children).toBeUndefined();
    expect(ab.hint).toBeUndefined();
  });

  it('parses ActionButton with actionType=ACTION → transport group → ExtendedTransport children', async () => {
    const log = [
      `${SEP}ab${SEP}2000|ab_wf|WF Button|ActionButton|ACTION`,
      `${SEP}ab_expression${SEP}`,
      `${SEP}ab_initExpression${SEP}`,
      `${SEP}ab_afterExpression${SEP}`,
      `${SEP}ab_showExpression${SEP}`,
      `${SEP}act${SEP}3000|wf_submit|Submit Workflow|NotificationTransportGroup`,
      `${SEP}actchildren${SEP}\n3001|ec_process|Order processor|ExtendedTransport\n`,
      `${SEP}actchild_expression_3001${SEP}\n_o := root.create(t.order)\n`,
      `${SEP}DONE`,
    ].join('\n');
    const c = makeClient(log);
    const chain = await c.fetchFlowChain('2000', 'ActionButton');
    expect(chain).not.toBeNull();
    const ab = chain!.steps[0];
    expect(ab.children).toHaveLength(1);
    const grp = ab.children![0];
    expect(grp.edgeLabel).toBe('actionObject (transport group)');
    expect(grp.identity.type).toBe('NotificationTransportGroup');
    expect(grp.children).toHaveLength(1);
    expect(grp.children![0].identity.name).toBe('Order processor');
    expect(grp.children![0].codeFields![0].prop).toBe('expression');
  });

  it('normalizes live BMP enum return "ActionType.action" → ACTION (no expression-driven fallback)', async () => {
    // Live BMP returns actionType as `"ActionType.action"`, NOT `"ACTION"`.
    // Pre-fix, the walker compared against `"ACTION"` and silently bailed,
    // showing "No action set" on every ACTION-mode button.
    const log = [
      `${SEP}ab${SEP}2000|ab_live|Live AB|ActionButton|ActionType.action`,
      `${SEP}ab_expression${SEP}`,
      `${SEP}ab_initExpression${SEP}`,
      `${SEP}ab_afterExpression${SEP}`,
      `${SEP}ab_showExpression${SEP}`,
      `${SEP}act${SEP}3000|ntg_submit|Submit|NotificationTransportGroup`,
      `${SEP}actchildren${SEP}\n3001|xt_main|Main transport|ExtendedTransport\n`,
      `${SEP}actchild_expression_3001${SEP}\nroot.add(t.order)\n`,
      `${SEP}DONE`,
    ].join('\n');
    const c = makeClient(log);
    const chain = await c.fetchFlowChain('2000', 'ActionButton');
    expect(chain).not.toBeNull();
    const ab = chain!.steps[0];
    expect(ab.hint).toBeUndefined();
    expect(ab.children).toHaveLength(1);
    expect(ab.children![0].identity.type).toBe('NotificationTransportGroup');
  });

  it('surfaces indirect showExpression EC on the button card', async () => {
    const log = [
      `${SEP}ab${SEP}2000|ab_gate|Gated AB|ActionButton|ADD`,
      `${SEP}ab_expression${SEP}\nroot.foo()\n`,
      `${SEP}ab_initExpression${SEP}`,
      `${SEP}ab_afterExpression${SEP}`,
      `${SEP}ab_showExpression${SEP}\nthis.org.isAdmin\n`,
      `${SEP}DONE`,
    ].join('\n');
    const c = makeClient(log);
    const chain = await c.fetchFlowChain('2000', 'ActionButton');
    expect(chain).not.toBeNull();
    const ab = chain!.steps[0];
    const showField = ab.codeFields!.find(c => c.prop === 'showExpression');
    expect(showField).toBeDefined();
    expect(showField!.firstLine).toContain('via showExpression');
  });

  it('hints "No action set" when actionType=ACTION but neither expression nor actionObject present', async () => {
    const log = [
      `${SEP}ab${SEP}2000|ab_dead|Dead Button|ActionButton|ACTION`,
      `${SEP}ab_expression${SEP}`,
      `${SEP}ab_initExpression${SEP}`,
      `${SEP}ab_afterExpression${SEP}`,
      `${SEP}ab_showExpression${SEP}`,
      `${SEP}DONE`,
    ].join('\n');
    const c = makeClient(log);
    const chain = await c.fetchFlowChain('2000', 'ActionButton');
    expect(chain).not.toBeNull();
    expect(chain!.steps[0].hint).toMatch(/No action set/);
  });
});

describe('fetchFlowChain — Label', () => {
  it('returns single step with defaultExpression', async () => {
    const log = [
      `${SEP}lbl${SEP}4000|lbl_hdr|Header|Label`,
      `${SEP}lbl_defaultExpression${SEP}\n"<h1>" + this.parent.name + "</h1>"\n`,
      `${SEP}lbl_expression${SEP}`,
      `${SEP}DONE`,
    ].join('\n');
    const c = makeClient(log);
    const chain = await c.fetchFlowChain('4000', 'Label');
    expect(chain).not.toBeNull();
    const lbl = chain!.steps[0];
    expect(lbl.codeFields).toHaveLength(1);
    expect(lbl.codeFields![0].prop).toBe('defaultExpression');
  });
});

describe('fetchFlowChain — unsupported type', () => {
  it('returns null for non-flow types', async () => {
    const c = makeClient('');
    const chain = await c.fetchFlowChain('500', 'Scorecard');
    expect(chain).toBeNull();
  });
});
