/**
 * Tests for fetchObjectPane (reference-edge parsing) and applyObjectChanges
 * (PANE_PROPS_SET allowlist + EC literal escaping). Both paths are
 * security-relevant — the allowlist prevents EC injection via crafted
 * property names; the escaping prevents string-literal escapes from breaking
 * out of their EC string context.
 */
import { describe, it, expect, vi } from 'vitest';
import { BmpClient, PANE_PROPS } from '../bmp-client';
import './chrome-mock';

const SEP = '<<<CREV_SEP>>>';

function makeClient(log: string) {
  const c = new BmpClient('http://localhost/Steadfast/', 'admin', 'pw');
  c.supportsLookup = true;
  const exec = vi.fn(async () => ({ ok: true, log, hasError: false, hasWarning: false }));
  (c as unknown as { executeEc: typeof exec }).executeEc = exec;
  return { c, exec };
}

function buildPaneLog(opts: {
  instRid: string;
  instId: string;
  instName: string;
  instType: string;
  refs?: Partial<Record<string, { rid: string; id: string; name: string; type: string }>>;
  code?: Partial<Record<string, string>>;
  card?: { rid: string; id: string; name: string; type: string };
  instCardRid?: string;
  /** Raw sibling rows (`rid|id|name|className|cur`). */
  siblingRows?: string[];
  /** Emitted `sibTotal` value; omit to simulate an EC without the block. */
  sibTotal?: number;
}) {
  const props: string[] = [
    `${SEP}instRid${SEP}${opts.instRid}`,
    `${SEP}instId${SEP}${opts.instId}`,
    `${SEP}instName${SEP}${opts.instName}`,
    `${SEP}instType${SEP}${opts.instType}`,
    `${SEP}parRid${SEP}MISSING`,
    `${SEP}parId${SEP}`,
    `${SEP}parName${SEP}`,
    `${SEP}parType${SEP}`,
    `${SEP}tmplRid${SEP}MISSING`,
    `${SEP}tmplId${SEP}`,
    `${SEP}tmplName${SEP}`,
    `${SEP}tmplType${SEP}`,
    `${SEP}cardRid${SEP}${opts.card?.rid ?? 'MISSING'}`,
    `${SEP}cardId${SEP}${opts.card?.id ?? ''}`,
    `${SEP}cardName${SEP}${opts.card?.name ?? ''}`,
    `${SEP}cardType${SEP}${opts.card?.type ?? ''}`,
    `${SEP}instCardRid${SEP}${opts.instCardRid ?? ''}`,
  ];
  for (const p of PANE_PROPS) {
    props.push(`${SEP}inst_${p}${SEP}`);
    props.push(`${SEP}tmpl_${p}${SEP}`);
  }
  // Code fields the panel may surface
  const codeFields = ['expression', 'afterExpression', 'defaultExpression', 'html', 'javascript', 'css'];
  for (const cf of codeFields) {
    props.push(`${SEP}code_${cf}${SEP}${opts.code?.[cf] ?? ''}`);
  }
  // Reference edges
  const refFields = ['editPage', 'destination', 'defaultObject', 'inputSet', 'actionObject', 'customvisualizationdata', 'property'];
  for (const rf of refFields) {
    const r = opts.refs?.[rf];
    props.push(`${SEP}ref_${rf}_rid${SEP}${r?.rid ?? ''}`);
    props.push(`${SEP}ref_${rf}_id${SEP}${r?.id ?? ''}`);
    props.push(`${SEP}ref_${rf}_name${SEP}${r?.name ?? ''}`);
    props.push(`${SEP}ref_${rf}_type${SEP}${r?.type ?? ''}`);
  }
  props.push(`${SEP}siblings${SEP}${(opts.siblingRows ?? []).join('\n')}`);
  if (opts.sibTotal != null) props.push(`${SEP}sibTotal${SEP}${opts.sibTotal}`);
  props.push(`${SEP}DONE`);
  return props.join('\n');
}

describe('fetchObjectPane — reference parsing', () => {
  it('resolves a single populated reference edge to its identity', async () => {
    const log = buildPaneLog({
      instRid: '100', instId: 'iv_create', instName: 'Create Risk', instType: 'InputView',
      refs: { inputSet: { rid: '101', id: 'is_create_risk', name: 'is_create_risk', type: 'InputSet' } },
    });
    const { c } = makeClient(log);
    const data = await c.fetchObjectPane('100');
    expect(data).not.toBeNull();
    expect(data!.references.inputSet).toEqual({
      rid: '101', businessId: 'is_create_risk', name: 'is_create_risk', type: 'InputSet',
    });
    expect(data!.references.editPage).toBeUndefined();
  });

  it('resolves the effective card and flags it as inherited from the template', async () => {
    // Enterprise object: its own card is empty; the effective card came from
    // its EnterpriseTemplate (instCardRid empty → viaTemplate true).
    const log = buildPaneLog({
      instRid: '500', instId: 'risk_x', instName: 'FX Risk', instType: 'CeRiskAssessment',
      card: { rid: '900', id: 'card_test', name: 'test', type: 'Card' },
      instCardRid: '',
    });
    const { c } = makeClient(log);
    const data = await c.fetchObjectPane('500');
    expect(data!.card).toEqual({
      rid: '900', businessId: 'card_test', name: 'test', type: 'Card', viaTemplate: true,
    });
  });

  it('flags a card as owned (not via template) when the instance has its own', async () => {
    const log = buildPaneLog({
      instRid: '600', instId: 'sc_main', instName: 'Main', instType: 'Scorecard',
      card: { rid: '901', id: 'card_default', name: 'Default card', type: 'Card' },
      instCardRid: '901',
    });
    const { c } = makeClient(log);
    const data = await c.fetchObjectPane('600');
    expect(data!.card!.viaTemplate).toBe(false);
    expect(data!.card!.name).toBe('Default card');
  });

  it('emits no card when none resolves', async () => {
    const log = buildPaneLog({ instRid: '700', instId: 'x', instName: 'X', instType: 'TextElement' });
    const { c } = makeClient(log);
    const data = await c.fetchObjectPane('700');
    expect(data!.card).toBeNull();
  });

  it('emits all populated refs and omits unset ones', async () => {
    const log = buildPaneLog({
      instRid: '200', instId: 'cov_risk', instName: 'Create Risk Form', instType: 'CreateObjectView',
      refs: {
        editPage: { rid: '201', id: 'ep_risk_edit', name: 'Risk Edit', type: 'EditPage' },
        destination: { rid: '202', id: 'org_risks', name: 'Risks', type: 'Organisation' },
        defaultObject: { rid: '203', id: 'risk_master', name: 'Risk Master', type: 'Risk' },
      },
    });
    const { c } = makeClient(log);
    const data = await c.fetchObjectPane('200');
    expect(data!.references.editPage?.businessId).toBe('ep_risk_edit');
    expect(data!.references.destination?.type).toBe('Organisation');
    expect(data!.references.defaultObject?.name).toBe('Risk Master');
    expect(data!.references.inputSet).toBeUndefined();
    expect(data!.references.actionObject).toBeUndefined();
  });

  it('surfaces non-empty code fields and skips empty ones', async () => {
    const log = buildPaneLog({
      instRid: '300', instId: 'cvo_chart', instName: 'My Chart', instType: 'CustomVisualization',
      code: { html: '<div>chart</div>', javascript: 'console.log(1)' },
    });
    const { c } = makeClient(log);
    const data = await c.fetchObjectPane('300');
    expect(data!.codeFields.html).toBe('<div>chart</div>');
    expect(data!.codeFields.javascript).toBe('console.log(1)');
    expect(data!.codeFields.css).toBeUndefined();
    expect(data!.codeFields.expression).toBeUndefined();
  });
});

describe('fetchObjectPane — sibling cap', () => {
  it('reports the true total from sibTotal when the list is capped', async () => {
    const rows = Array.from({ length: 50 }, (_, i) =>
      `${100 + i}|b${i}|Sib ${i}|ExtendedTable|${i === 0 ? '1' : '0'}`);
    const log = buildPaneLog({
      instRid: '100', instId: 'b0', instName: 'Sib 0', instType: 'ExtendedTable',
      siblingRows: rows, sibTotal: 312,
    });
    const { c } = makeClient(log);
    const data = await c.fetchObjectPane('100');
    expect(data!.siblings).toHaveLength(50);   // capped slice
    expect(data!.siblingTotal).toBe(312);      // true count for "showing 50 of 312"
  });

  it('falls back to the row count when sibTotal is absent or smaller', async () => {
    const rows = ['100|b0|Sib 0|ExtendedTable|1', '101|b1|Sib 1|ExtendedTable|0'];
    const log = buildPaneLog({
      instRid: '100', instId: 'b0', instName: 'Sib 0', instType: 'ExtendedTable',
      siblingRows: rows, // no sibTotal
    });
    const { c } = makeClient(log);
    const data = await c.fetchObjectPane('100');
    expect(data!.siblingTotal).toBe(2);
  });
});

describe('buildObjectPaneEc — sibling cap', () => {
  it('emits a counted, capped sibling loop plus the true total', async () => {
    const { buildObjectPaneEc, SIBLING_CAP } = await import('../ec-codegen');
    const ec = buildObjectPaneEc('lookup(100)', PANE_PROPS);
    expect(ec).toContain('_sibN := _sibN + 1');
    expect(ec).toContain(`IF _sibN <= ${SIBLING_CAP} THEN`);
    expect(ec).toContain('"sibTotal"');
  });
});

describe('applyObjectChanges — PANE_PROPS_SET allowlist', () => {
  it('rejects unknown property names without sending EC', async () => {
    const { c, exec } = makeClient('');
    const result = await c.applyObjectChanges('100', 'instance', {
      headerColor: '#fff',
      arbitrary_prop_attacker_chose: 'pwned',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not allowed/);
    expect(exec).not.toHaveBeenCalled();
  });

  it('accepts whitelisted props; colours link by bid, values stay literal', async () => {
    const { c, exec } = makeClient('Result : 0');
    const result = await c.applyObjectChanges('100', 'instance', {
      headerColor: 'df12 Clear orange', // "<bid> <name>" from the picker
      width: 200,
      shadow: true,
    });
    expect(result.ok).toBe(true);
    expect(exec).toHaveBeenCalledTimes(1);
    const ec = (exec.mock.calls[0] as unknown as [string])[0];
    expect(ec).toContain('headerColor := t.df12'); // linked, not "df12 Clear orange"
    expect(ec).toMatch(/width\s*:=\s*200/);
  });

  it('rejects a malformed colour id (no EC sent)', async () => {
    const { c, exec } = makeClient('');
    const result = await c.applyObjectChanges('100', 'instance', { headerColor: '#fff' });
    expect(result.ok).toBe(false);
    expect(exec).not.toHaveBeenCalled();
  });

  it('returns ok=true with no EC call when changes is empty', async () => {
    const { c, exec } = makeClient('');
    const result = await c.applyObjectChanges('100', 'instance', {});
    expect(result.ok).toBe(true);
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('applyObjectChanges — EC literal escaping', () => {
  it('escapes backslashes, double quotes, CR, LF in string values', async () => {
    const { c, exec } = makeClient('Result : 0');
    await c.applyObjectChanges('100', 'instance', {
      headerStyle: 'foo\\bar"baz\nqux\rend',
    });
    const ec = (exec.mock.calls[0] as unknown as [string])[0];
    // The EC should contain the escaped form, not raw quote/newline that would
    // break out of the string literal.
    expect(ec).toContain('foo\\\\bar\\"baz\\nqux\\rend');
    expect(ec).not.toContain('foo\\bar"baz\nqux\rend');
  });

  it('emits TRUE/FALSE for booleans, not quoted strings', async () => {
    const { c, exec } = makeClient('Result : 0');
    // `hidden` was removed from PANE_PROPS in 0.18.1 (BMP uses `visible`
    // boolean instead); test the visibility prop that actually exists.
    await c.applyObjectChanges('100', 'instance', { shadow: true, visible: false });
    const ec = (exec.mock.calls[0] as unknown as [string])[0];
    expect(ec).toMatch(/shadow\s*:=\s*TRUE/);
    expect(ec).toMatch(/visible\s*:=\s*FALSE/);
  });

  it('emits numeric literals without quotes', async () => {
    const { c, exec } = makeClient('Result : 0');
    await c.applyObjectChanges('100', 'instance', { width: 200, transparency: 0.4 });
    const ec = (exec.mock.calls[0] as unknown as [string])[0];
    expect(ec).toMatch(/width\s*:=\s*200(\b|$)/);
    expect(ec).toMatch(/transparency\s*:=\s*0\.4(\b|$)/);
  });
});

describe('applyObjectChanges — template target', () => {
  it('routes through _o.linkedTo for template target', async () => {
    const { c, exec } = makeClient('Result : 0');
    await c.applyObjectChanges('100', 'template', { width: 200 });
    const ec = (exec.mock.calls[0] as unknown as [string])[0];
    expect(ec).toContain('_o.linkedTo');
    expect(ec).toContain('_o.template');
  });

  it('emits instance change without touching linkedTo for instance target', async () => {
    const { c, exec } = makeClient('Result : 0');
    await c.applyObjectChanges('100', 'instance', { width: 200 });
    const ec = (exec.mock.calls[0] as unknown as [string])[0];
    expect(ec).not.toContain('_o.linkedTo');
    expect(ec).toContain('_o.change(');
  });
});
