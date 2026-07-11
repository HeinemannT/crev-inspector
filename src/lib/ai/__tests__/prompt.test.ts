import { describe, it, expect } from 'vitest';
import { buildPrompt, selectPacks, extractCodeBlock, looksLikeProse } from '../prompt';
import type { AiRequestPayload } from '../types';

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
