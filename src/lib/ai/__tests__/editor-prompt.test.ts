import { describe, expect, it } from 'vitest';
import { buildEditorPrompt, selectEditorPacks } from '../editor-prompt';
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

describe('selectEditorPacks', () => {
  it('always includes bmp-editor, plus ec for the extended language', () => {
    expect(selectEditorPacks(payload({ lang: 'extended' }))).toEqual(['bmpEditor', 'ecEditor']);
  });

  it('includes cvo for a CustomVisualization', () => {
    const p = payload({ lang: 'javascript', context: { objectType: 'CustomVisualization' } });
    expect(selectEditorPacks(p)).toEqual(['bmpEditor', 'cvo']);
  });

  it('includes html-text for a TextElement', () => {
    const p = payload({ lang: 'html', context: { objectType: 'TextElement' } });
    expect(selectEditorPacks(p)).toEqual(['bmpEditor', 'htmlText']);
  });

  it('keeps a stable order: bmp-editor, then ec, then the type pack', () => {
    const p = payload({ lang: 'extended', context: { objectType: 'CustomVisualization' } });
    expect(selectEditorPacks(p)).toEqual(['bmpEditor', 'ecEditor', 'cvo']);
  });
});

describe('buildEditorPrompt', () => {
  it('puts the persona + packs in system, and object context in the user message', () => {
    const { system, user, packs } = buildEditorPrompt(payload());
    expect(packs).toEqual(['bmpEditor', 'ecEditor']);
    expect(system).toContain('CREV Inspector');
    expect(system).toContain('Extended Code');
    expect(user).toContain('Calc');
    expect(user).not.toContain('calc_1');
    expect(user).not.toContain('businessId (context only; never substitute into source)');
    expect(user).toContain('output(t.foo.name)');
    expect(user).toContain('What does this do?');
  });

  it('labels owner business IDs as context on non-EC editor requests', () => {
    const { user } = buildEditorPrompt(payload({ lang: 'javascript' }));
    expect(user).toContain('calc_1');
    expect(user).toContain('businessId (context only; never substitute into source)');
  });

  it('requires the model to implement supplied inputs instead of assuming variables', () => {
    const { system } = buildEditorPrompt(payload());
    expect(system).toContain('Implement every input and initialization stated by the user');
    expect(system).toContain('never silently assume that a variable or parsed object already exists');
  });

  it('for edit intent, instructs a single fenced code block only', () => {
    const { user } = buildEditorPrompt(payload({ intent: 'edit', instruction: 'Add a fallback' }));
    expect(user).toContain('containing only the revised replacement');
    expect(user).toContain('EXACTLY ONE fenced code block');
    expect(user).toContain('Do NOT quote, repeat, or show the original code first');
  });

  it('marks the selected region and scopes an edit to it', () => {
    const p = payload({
      intent: 'edit',
      code: 'AAA BBB CCC',
      selection: { from: 4, to: 7, text: 'BBB' },
    });
    const { user } = buildEditorPrompt(p);
    expect(user).toContain('«SELECTION_START»BBB«SELECTION_END»');
    expect(user).toContain('the selected region only');
  });
});
