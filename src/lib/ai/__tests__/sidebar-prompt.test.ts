import { describe, it, expect } from 'vitest';
import { buildChatSystem, selectChatPacks } from '../sidebar-prompt';
import type { AiContextEnvelope } from '../types';

describe('selectChatPacks', () => {
  const srv = { id: 's1', url: 'u' };
  function env(sources: AiContextEnvelope['sources']): AiContextEnvelope {
    return { v: 1, server: srv, sources };
  }

  it('ships bmp-core + ec with no attached sources', () => {
    expect(selectChatPacks(env([]))).toEqual(['bmpCore', 'ec']);
  });

  it('KEEPS the ec pack for a selection-kind source with no slot (the Inspect flow)', () => {
    // Regression: selectChatPacks used to drop ec here (no `extended` slot,
    // sources.length > 0), which measured 14% vs 73% on EC tasks. EC is always
    // relevant to a workspace conversation, so the pack is always shipped.
    const e = env([{ kind: 'selection', object: { rid: '9', businessId: '4761', name: 'Control Register', type: 'Scorecard' } }]);
    expect(selectChatPacks(e)).toEqual(['bmpCore', 'ec']);
  });

  it('appends cvo for a CustomVisualization source, after ec', () => {
    const e = env([{ kind: 'selection', object: { rid: '9', businessId: 'cv_1', name: 'CVO', type: 'CustomVisualization' } }]);
    expect(selectChatPacks(e)).toEqual(['bmpCore', 'ec', 'cvo']);
  });

  it('appends html-text for a TextElement source, after ec', () => {
    const e = env([{ kind: 'selection', object: { rid: '9', businessId: 'te_1', name: 'Text', type: 'TextElement' } }]);
    expect(selectChatPacks(e)).toEqual(['bmpCore', 'ec', 'htmlText']);
  });

  it('keeps a stable order: bmp-core, ec, then the type pack', () => {
    const e = env([{ kind: 'editor', object: { rid: '9', businessId: 'cv_1', name: 'CVO', type: 'CustomVisualization' }, slot: { name: 'javascript', lang: 'javascript', code: '' } }]);
    expect(selectChatPacks(e)).toEqual(['bmpCore', 'ec', 'cvo']);
  });
});

describe('buildChatSystem workspace primer', () => {
  it('ships the structural target-selection contract without assigning policy to read_layout', () => {
    const system = buildChatSystem({
      v: 1,
      server: { id: 'test', url: 'https://example.test/' },
      sources: [],
    }).system;
    expect(system).toContain('<change-target-policy>');
    expect(system).toContain('exact target or receiver supplied by the user or verified context is authoritative');
    expect(system).toContain('linkedTemplateRid');
    expect(system).toContain('pageOwnerRid');
    expect(system).toContain('call `add(...)` on the resolved page/template');
    expect(system).toContain('Pass `container := ...` only when placement was requested or verified');
    expect(system).toContain('a Container is never the `add` receiver');
    expect(system).toContain('Call `moveBefore`/`moveAfter` on the new widget');
    expect(system).toContain('[[object:RID]] is display syntax');
    expect(system).toContain('executable EC uses the supplied symbolic reference or lookup("RID")');
    expect(system).not.toContain('as target and receiver');
    expect(system).not.toContain('a container is only the `container :=` value');
    expect(system).not.toContain('destination container node\'s rid as the placement receiver');
    expect(system).toContain('When the user identifies the subject contextually and read_layout supplies structural facts');
    expect(system).not.toContain('reason=local-widget-only');
  });

  const env: AiContextEnvelope = { v: 1, server: { id: 's1', url: 'u' }, sources: [] };
  const primer = 'objects=1117\nclasses: Task=400, Scorecard=45\nunits: Group (org_group, Organisation);\ntemplates(277 distinct): § Risk Register (3226) x2;';

  // NB: the persona prose also mentions the token "<workspace>", so presence of
  // the injected BLOCK is keyed on the closing tag, which only the block emits.
  it('omits the <workspace> block when no primer is given', () => {
    const { system } = buildChatSystem(env);
    expect(system).not.toContain('</workspace>');
  });

  it('injects the primer inside a <workspace> block', () => {
    const { system } = buildChatSystem(env, primer);
    expect(system).toContain('</workspace>');
    expect(system).toContain('objects=1117');
    expect(system).toContain('§ Risk Register (3226)');
  });

  it('is deterministic + stable for a fixed (envelope, primer) pair', () => {
    expect(buildChatSystem(env, primer).system).toBe(buildChatSystem(env, primer).system);
  });

  it('keeps the workspace in the stable system layer and context separate', () => {
    const withCtx: AiContextEnvelope = {
      v: 1, server: { id: 's1', url: 'u' },
      sources: [{ kind: 'selection', object: { rid: '9', businessId: 'sc_x', name: 'X', type: 'Scorecard' } }],
    };
    const { system, context } = buildChatSystem(withCtx, primer);
    expect(system).toContain('</workspace>');
    expect(system).not.toContain('<context server=');
    expect(context).toContain('<context server=');
  });

  it('uses progressive property discovery without reconfirming self-contained exact changes', () => {
    const { system } = buildChatSystem(env);
    expect(system).toContain('Preserve exact supplied targets, receivers, property IDs');
    expect(system).toContain('read_object only for a requested current value');
    expect(system).toContain('use one narrow read_type query');
    expect(system).toContain('self-contained exact changes');
    expect(system).toContain('need no rediscovery');
    expect(system).toContain('use read_code for a located object\'s complete stored source');
  });

  it('defaults vague linked-page changes from structural facts and keeps target metadata minimal', () => {
    const { system } = buildChatSystem(env);
    expect(system).toContain('Use lookup("rid") only when the user explicitly asks for this/local/one copy');
    expect(system).toContain('Do not volunteer a local override');
    expect(system).toContain('briefly state that the change affects the shared template');
    expect(system).not.toContain('An instance-only alternative is available on request.');
    expect(system).not.toContain('followed exactly by');
    expect(system).not.toContain('target: one exact [[object:RID]] or exact supplied symbolic target');
    expect(system).toContain('its schema owns the exact fields');
    expect(system).toContain('Existing widget: if linkedTemplateRid exists');
    expect(system).toContain('[[object:RID]] is display syntax for ticket targets and prose');
    expect(system).toContain('Never expose internal field names or routing labels');
  });

  it.skip('legacy verbose prompt assertions: makes attached context authoritative and routes scoped queries to query_context', () => {
    const withCtx: AiContextEnvelope = {
      v: 1, server: { id: 's1', url: 'u' },
      sources: [{ kind: 'selection', object: { rid: '9', businessId: 'sc_x', name: 'X', type: 'Scorecard' } }],
    };
    const { system } = buildChatSystem(withCtx, primer);
    expect(system).toContain('NEVER use search_objects to rediscover that source');
    expect(system).toContain('call query_context first');
    expect(system).toContain('“process” does not imply `Task`');
    expect(system).toContain('Enterprise Ce*');
    expect(system).toContain('read_code on its numeric rid with property="expression"');
    expect(system).toContain('currently viewed tabRid');
    expect(system).toContain('tabRid as its focusRid');
    expect(system).toContain('output contains both bid= and rid=');
    expect(system).toContain('When a verified result supplies ecRef=, copy that exact');
    expect(system).toContain('preview its deferred expression by');
    expect(system).toContain('does not execute the table');
    expect(system).toContain('organisation.link(masterScorecard)');
    expect(system).toContain('never call an EnterpriseTemplate complete until its Default/instance');
    expect(system).toContain('Numeric BIDs are not RIDs');
    expect(system).toContain('successful semantic query_context is');
    expect(system).toContain('Do not preview/re-run stored table code');
    expect(system).toContain('Tool results remain valid for the whole turn');
    expect(system).toContain('read_layout once when placement is still needed');
    expect(system).toContain('Define any row collection inside the quoted expression only');
    expect(system).toContain('Do not assign an add/change result unless later statements reuse it');
    expect(system).toContain('Do not include id unless the user asks for an identity/code column');
    expect(system).toContain('collection.table(name, owner, ...)');
    expect(system).toContain('createtable("Risk", "Owner", ...)');
    expect(system.match(/custom headings/g)).toHaveLength(1);
    expect(system).not.toContain('root.VerifiedClass.children.table(id, name, verifiedProperty)');
  });

  it.skip('legacy verbose prompt assertions: answers self-contained EC tasks directly and ships the advanced EC rules', () => {
    const { system } = buildChatSystem(env);
    expect(system).toContain('For a self-contained coding task');
    expect(system).toContain('treat it as an already');
    expect(system).toContain('do not resolve or redeclare it');
    expect(system).toContain('Copy it');
    expect(system).toContain('byte-for-byte into the change script');
    expect(system).toContain('The ONLY parser is uppercase `JSON(string)`');
    expect(system).toContain('wrapped NodeValues');
    expect(system).toContain('Table property arguments are BARE properties');
    expect(system).toContain('object properties must be changed through `_o.change(property := value)`');
    expect(system).toContain('never write `_o.property := value`');
    expect(system).toContain('`.card` is a reference property pointing to a `Card` object');
    expect(system).toContain('`visible=false` or `L=false|M=false|S=false` as hidden');
    expect(system).toContain('`WHILE` / `ENDWHILE`');
    expect(system).toContain('Stored ExtendedExpression utilities are workspace-authored configuration');
    expect(system).not.toContain('t.json_set.expression');
    expect(system).not.toContain('str_split');
  });

  it.skip('legacy verbose prompt assertions: ships the exact configuration creation API and Change Ticket boundary', () => {
    const { system } = buildChatSystem(env);
    expect(system).toContain('The API is `parent.add(Type, named arguments)`');
    expect(system).toContain('Never invent');
    expect(system).toContain('`createChild`');
    expect(system).toContain('Chain creations through the variables returned by `add`');
    expect(system).toContain('output(t.tbl_example.expression)');
    expect(system).toContain('Preview a proposed table expression by itself before embedding it');
    expect(system).toContain('BMP configuration uses a 0–6 scale');
    expect(system).toContain('Creating and linking templates (two different models)');
    expect(system).toContain('Use the literal separator');
    expect(system).not.toContain('---verify---');
    expect(system).toContain('`move` for reparenting');
    expect(system).toContain('`container :=` reference is always operation');
    expect(system).toContain('_templateCategory.add(EnterpriseTemplate');
    expect(system).toContain('second transaction');
    expect(system).toContain('An imperative request such as create, add, move, fix');
    expect(system).toContain('One Change Ticket represents one commit phase');
  });

  it('requires verified object tokens in place of plain identity text', () => {
    const { system } = buildChatSystem(env);
    const prose = system.replace(/\s+/g, ' ');
    expect(prose).toContain('<verified-object-output>');
    expect(prose).toContain('rendered name, not an optional citation');
    expect(prose).toContain('use the exact token in place of its plain name');
    expect(prose).toContain('Do not show the token and plain name together');
    expect(prose).not.toContain('BID or RID');
    expect(prose).toContain('You need not mention every supplied object');
    expect(prose).toContain('For one locate result, answer exactly: Found [[object:RID]].');
    expect(prose).toContain('Wrong: Owner: Process Register ([[object:RID]]).');
    expect(prose).toContain('</verified-object-output>');
  });

  it.skip('legacy verbose prompt assertions: sets a measurable concise-answer default', () => {
    const { system } = buildChatSystem(env);
    expect(system).toContain('use at most 200 words and no more than');
    expect(system).toContain('omit preambles, repeated tool output, identity');
    expect(system).toContain('user explicitly asks for a detailed explanation');
  });

  it.skip('legacy verbose prompt assertions: allows only preview_ec to dry-run a requested mutation while keeping probes read-only', () => {
    const { system } = buildChatSystem(env);
    const prose = system.replace(/\s+/g, ' ');
    expect(prose).toContain('preview_ec runs only code YOU write for the USER\'s request');
    expect(prose).toContain('never reach outside the workspace or use outbound HTTP');
    expect(prose).toContain('Ordinary investigative probes must be read-only');
    expect(prose).toContain('explicitly asks for a configuration change, you may');
    expect(prose).toContain('dry-run the complete mutating script with preview_ec because preview never');
    expect(prose).toContain('present it only after the preview succeeds, inside a crev-change ticket');
  });

  it('ships the measured lean orchestration contract', () => {
    const { system } = buildChatSystem(env);
    expect(system.length).toBeLessThanOrEqual(31_300);
    expect(system).toContain('<decision-policy>');
    expect(system).toContain('Attached context is authoritative');
    expect(system).toContain('Supplied code is the complete subject of an explain/review request');
    expect(system).toContain('references inside it are data dependencies, not reasons to inspect other objects');
    expect(system).toContain('Never Preview an outer mutation');
    expect(system).toContain('After the final successful read for a change, the next action must be the actual submit_change_ticket function call through the API');
    expect(system).toContain('stop reading when the mutation owner');
    expect(system).toContain('Current values are required only when asked');
    expect(system).toContain('a Container is never the `add` receiver');
    expect(system).toContain('Call `moveBefore`/`moveAfter` on the new widget only when sibling ordering was requested');
    expect(system).toContain('no comments, diagnostics, state reads');
    expect(system).toContain('check requested object count');
    expect(system).not.toContain('summary: one visible outcome under 140 characters');
    expect(system).toContain('The outer Preview proves only that the source can be stored');
    expect(system).toContain('Preview the inner expression separately when an uncertain join/group/aggregate');
    expect(system).toContain('An `ExtendedTable` gets rows and columns from its stored `expression`');
    expect(system).not.toContain('extracts and Previews that expression against real rows');
    expect(system).toContain('BMP responsive widths use 0–6');
    expect(system).toContain('Zero is class-dependent');
    expect(system).toContain('organisation.link(masterScorecard)');
    expect(system).toContain('**EnterpriseTemplate:** use two committed phases');
    expect(system).toContain('invoke it once; its schema owns the exact fields');
    expect(system).toContain('One ticket is one commit phase');
    expect(system).toContain('normally under 30 lines');
  });

  it('ignores an empty / whitespace primer', () => {
    expect(buildChatSystem(env, '   ').system).not.toContain('</workspace>');
    expect(buildChatSystem(env, null).system).not.toContain('</workspace>');
  });
});
