import { describe, it, expect } from 'vitest';
import { buildPrompt, selectPacks, selectChatPacks, extractCodeBlock, looksLikeProse, buildChatSystem } from '../prompt';
import type { AiRequestPayload, AiContextEnvelope } from '../types';

function payload(over: Partial<AiRequestPayload> = {}): AiRequestPayload {
  return {
    requestId: 'r1',
    intent: 'ask',
    lang: 'extended',
    code: 'output(t.foo.name)',
    selection: null,
    instruction: 'What does this do?',
    context: { objectType: 'ExtendedExpression', businessId: 'calc_1', name: 'Calc' },
    ...over,
  };
}

describe('selectPacks', () => {
  it('always includes bmp-core, plus ec for the extended language', () => {
    expect(selectPacks(payload({ lang: 'extended' }))).toEqual(['bmpCore', 'ec']);
  });

  it('includes cvo for a CustomVisualization', () => {
    const p = payload({ lang: 'javascript', context: { objectType: 'CustomVisualization' } });
    expect(selectPacks(p)).toEqual(['bmpCore', 'cvo']);
  });

  it('includes html-text for a TextElement', () => {
    const p = payload({ lang: 'html', context: { objectType: 'TextElement' } });
    expect(selectPacks(p)).toEqual(['bmpCore', 'htmlText']);
  });

  it('keeps a stable order: bmp-core, then ec, then the type pack', () => {
    // An EC lang on a CVO would still list ec before cvo.
    const p = payload({ lang: 'extended', context: { objectType: 'CustomVisualization' } });
    expect(selectPacks(p)).toEqual(['bmpCore', 'ec', 'cvo']);
  });
});

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

describe('buildPrompt', () => {
  it('puts the persona + packs in system, and object context in the user message', () => {
    const { system, user, packs } = buildPrompt(payload());
    expect(packs).toEqual(['bmpCore', 'ec']);
    expect(system).toContain('CREV Inspector');
    expect(system).toContain('Extended Code'); // ec pack content
    expect(user).toContain('Calc');
    expect(user).toContain('calc_1');
    expect(user).toContain('output(t.foo.name)');
    expect(user).toContain('What does this do?');
  });

  it('requires the model to implement supplied inputs instead of assuming variables', () => {
    const { system } = buildPrompt(payload());
    expect(system).toContain('Implement every input and initialization stated by the user');
    expect(system).toContain('never silently assume that a variable or parsed object already exists');
  });

  it('for edit intent, instructs a single fenced code block only', () => {
    const { user } = buildPrompt(payload({ intent: 'edit', instruction: 'Add a fallback' }));
    expect(user).toContain('Return ONLY the revised replacement');
    expect(user).toContain('EXACTLY ONE fenced code block');
    // Hardened against the "quote the original first" no-op.
    expect(user).toContain('Do NOT quote, repeat, or show the original code first');
  });

  it('marks the selected region and scopes an edit to it', () => {
    const p = payload({
      intent: 'edit',
      code: 'AAA BBB CCC',
      selection: { from: 4, to: 7, text: 'BBB' },
    });
    const { user } = buildPrompt(p);
    expect(user).toContain('«SELECTION_START»BBB«SELECTION_END»');
    expect(user).toContain('the selected region only');
  });
});

describe('extractCodeBlock', () => {
  it('takes the (only) fenced block', () => {
    const reply = 'Sure, here it is:\n```extended\noutput(t.x.name)\n```\nHope that helps.';
    expect(extractCodeBlock(reply)).toEqual({ code: 'output(t.x.name)' });
  });

  it('prefers the LAST fenced block when several exist', () => {
    // Models sometimes quote the broken original first, then the fix.
    const reply = 'The bug is here:\n```\nold_broken()\n```\nFixed version:\n```\nnew_fixed()\n```';
    expect(extractCodeBlock(reply)).toEqual({ code: 'new_fixed()' });
  });

  it('falls back to an earlier fence when the last one merely re-quotes the input', () => {
    const current = 'output(t.x.name)';
    // Corrected code first, then the model echoes the original at the end.
    const reply = '```\noutput(t.x.name.whenMissing(""))\n```\nOriginal:\n```\noutput(t.x.name)\n```';
    expect(extractCodeBlock(reply, current)).toEqual({ code: 'output(t.x.name.whenMissing(""))' });
  });

  it('returns the same-as-input code when every fence equals the input (a no-op the UI detects)', () => {
    const current = 'output(t.x.name)';
    const reply = '```\noutput(t.x.name)\n```';
    expect(extractCodeBlock(reply, current)).toEqual({ code: current });
  });

  it('treats a bare code-looking reply as code', () => {
    const reply = 'output(t.x.name.whenMissing(""))';
    expect(extractCodeBlock(reply)).toEqual({ code: 'output(t.x.name.whenMissing(""))' });
  });

  it('errors on a prose-only reply with no fence', () => {
    const r = extractCodeBlock('This expression reads the name. It returns the display value.');
    expect(r.code).toBeNull();
    expect(r.error).toMatch(/did not contain code/);
  });

  it('errors on an empty reply', () => {
    expect(extractCodeBlock('   ').code).toBeNull();
  });
});

describe('buildChatSystem workspace primer', () => {
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

  it('places the workspace block BEFORE the volatile context region', () => {
    const withCtx: AiContextEnvelope = {
      v: 1, server: { id: 's1', url: 'u' },
      sources: [{ kind: 'selection', object: { rid: '9', businessId: 'sc_x', name: 'X', type: 'Scorecard' } }],
    };
    const { system } = buildChatSystem(withCtx, primer);
    expect(system.indexOf('</workspace>')).toBeLessThan(system.indexOf('<context server='));
  });

  it('makes attached context authoritative and routes scoped queries to query_context', () => {
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
    expect(system).toContain('output contains both bid= and rid=');
    expect(system).toContain('Numeric BIDs are not RIDs');
    expect(system).toContain('successful semantic query_context is');
    expect(system).toContain('Do not preview/re-run stored table code');
  });

  it('answers self-contained EC tasks directly and ships the advanced EC rules', () => {
    const { system } = buildChatSystem(env);
    expect(system).toContain('For a self-contained coding task');
    expect(system).toContain('The ONLY parser is uppercase `JSON(string)`');
    expect(system).toContain('wrapped NodeValues');
    expect(system).toContain('Table property arguments are BARE properties');
    expect(system).toContain('object properties must be changed through `_o.change(property := value)`');
    expect(system).toContain('never write `_o.property := value`');
    expect(system).toContain('`.card` references the `Card`');
    expect(system).toContain('`WHILE` / `ENDWHILE`');
    expect(system).toContain('Stored ExtendedExpression utilities are workspace-authored configuration');
    expect(system).not.toContain('t.json_set.expression');
    expect(system).not.toContain('str_split');
  });

  it('instructs the model to embed object chips as natural prose', () => {
    const { system } = buildChatSystem(env);
    const prose = system.replace(/\s+/g, ' ');
    expect(prose).toContain('The search returned [[object:RID]].');
    expect(prose).toContain('Do NOT announce a "verified UI object');
    expect(prose).toContain('The rendered chip already communicates identity');
    expect(prose).toContain('OBJECT CHIP OUTPUT IS A HARD FINAL-ANSWER FORMAT RULE');
    expect(prose).toContain('For a simple find/locate request, answer "Found [[object:RID]]." and stop.');
    expect(prose).toContain('Do not offer follow-up actions after a simple find/locate answer.');
  });

  it('sets a measurable concise-answer default', () => {
    const { system } = buildChatSystem(env);
    expect(system).toContain('use at most 200 words and no more than');
    expect(system).toContain('omit preambles, repeated tool output, identity');
    expect(system).toContain('user explicitly asks for a detailed explanation');
  });

  it('ignores an empty / whitespace primer', () => {
    expect(buildChatSystem(env, '   ').system).not.toContain('</workspace>');
    expect(buildChatSystem(env, null).system).not.toContain('</workspace>');
  });
});

describe('looksLikeProse', () => {
  it('flags natural language', () => {
    expect(looksLikeProse('This returns the name. It is safe.')).toBe(true);
    expect(looksLikeProse('Here is what it does.')).toBe(true);
  });

  it('does not flag code', () => {
    expect(looksLikeProse('_x := t.foo.name')).toBe(false);
    expect(looksLikeProse('<div class="cvo"></div>')).toBe(false);
    expect(looksLikeProse('const x = 1;')).toBe(false);
  });
});
