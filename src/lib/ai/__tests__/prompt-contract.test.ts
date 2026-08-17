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
    expect(digestPrompt(prompt.system, prompt.user)).toBe('e81081bfa093a12c4a64f17458ec409ae69b091c41436abaeb32f91599fb95eb');
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
    expect(digestPrompt(prompt.system)).toBe('bf858e2c7e8b53b24aa2ef2b4faa52ae8adef1c612d3d54be15579d2ae812661');
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
    expect(digestPrompt(prompt.system)).toBe('f20f2529f70d4b5a26786617874b368175e792ff26fa44157ee41b6c9be58c25');
  });
});
