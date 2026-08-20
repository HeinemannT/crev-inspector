import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildEditorPrompt } from '../editor-prompt';
import { buildChatSystem } from '../sidebar-prompt';
import type { AiContextEnvelope, AiRequestPayload } from '../types';

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function digestPrompt(system: string, user = ''): string {
  return digest(`${system}\n<user-message>\n${user}`);
}

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

describe('model-visible prompt contracts', () => {
  it('shares one EC core while keeping surface policies isolated', () => {
    const sidebar = buildChatSystem({
      v: 1,
      server: { id: 'steadfast', url: 'https://example.test/' },
      sources: [],
    }).system;
    const editor = buildEditorPrompt({
      requestId: 'editor-ec-routing',
      intent: 'edit',
      lang: 'extended',
      code: 'output(t.risk.name)',
      selection: null,
      instruction: 'Keep the result.',
      context: { objectType: 'ExtendedExpression' },
    }).system;

    expect(occurrences(sidebar, '<ec_language_core>')).toBe(1);
    expect(sidebar).toContain('<ec_sidebar_workflows>');
    expect(sidebar).not.toContain('<ec_editor_policy>');
    expect(occurrences(editor, '<ec_language_core>')).toBe(1);
    expect(editor).toContain('<ec_editor_policy>');
    expect(editor).not.toContain('<ec_sidebar_workflows>');
  });

  it('keeps the EC editor prompt stable during architectural refactors', () => {
    const payload: AiRequestPayload = {
      requestId: 'editor-ec',
      intent: 'ask',
      lang: 'extended',
      code: 'output(t.risk.name)',
      selection: null,
      instruction: 'Explain this expression.',
      context: {
        objectType: 'ExtendedExpression',
        businessId: 'risk_name',
        name: 'Risk name',
        slotName: 'expression',
      },
    };
    const prompt = buildEditorPrompt(payload);
    expect(digestPrompt(prompt.system, prompt.user)).toBe('113545a2d2f8b46254cf748ee44718d569400fb31f3a070d5d1a21016c53f87e');
  });

  it('keeps the selected JavaScript editor prompt stable during architectural refactors', () => {
    const payload: AiRequestPayload = {
      requestId: 'editor-js',
      intent: 'edit',
      lang: 'javascript',
      code: 'const value = oldValue;\nreturn value;',
      selection: { from: 14, to: 22, text: 'oldValue' },
      instruction: 'Use the new value.',
      context: {
        objectType: 'CustomVisualization',
        businessId: 'risk_view',
        name: 'Risk view',
        slotName: 'javascript',
      },
    };
    const prompt = buildEditorPrompt(payload);
    expect(digestPrompt(prompt.system, prompt.user)).toBe('c814be29e1912309111cf42ee4ecfbb8659dc5f1b1615a2477cac16b2d437f7f');
  });

  it('keeps the context-free sidebar prompt stable during architectural refactors', () => {
    const envelope: AiContextEnvelope = {
      v: 1,
      server: { id: 'steadfast', url: 'https://example.test/' },
      sources: [],
    };
    const prompt = buildChatSystem(envelope);
    expect(digestPrompt(prompt.system, prompt.context)).toBe('66a962232a5f3da954a87c584c038edea85081d35ab29a59aafceaf31f46166f');
  });

  it('keeps the contextual sidebar prompt stable during architectural refactors', () => {
    const envelope: AiContextEnvelope = {
      v: 1,
      server: { id: 'steadfast', url: 'https://example.test/' },
      sources: [{
        kind: 'selection',
        object: {
          rid: '726548820039520945',
          businessId: 'landing_page',
          name: 'Landing Page',
          type: 'Scorecard',
        },
      }],
    };
    const prompt = buildChatSystem(envelope, 'objects=12\nclasses: Scorecard=2, Risk=10');
    expect(digestPrompt(prompt.system, prompt.context)).toBe('a2739f5fa7fe172ebb9c2f22de9a7d58afe94695823516929c710cbf2ef5bae3');
  });
});
