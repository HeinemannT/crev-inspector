import { describe, expect, it } from 'vitest';
import {
  EC_EDITOR_PROMPT_VARIANTS,
  ecEditorSystemForVariant,
  parseEcEditorPromptVariant,
} from '../editor-prompt-variants';
import { buildEditorPrompt } from '../editor-prompt';

describe('EC editor prompt variants', () => {
  it('keeps production byte-for-byte', () => {
    expect(ecEditorSystemForVariant('production', 'current system')).toBe('current system');
  });

  it('holds the compact specification constant across framing variants', () => {
    for (const variant of EC_EDITOR_PROMPT_VARIANTS.filter(value =>
      value !== 'production' && value !== 'standalone-full' && value !== 'structured-editor')) {
      const system = ecEditorSystemForVariant(variant, 'unused');
      expect(system).toContain('# Extended Code specification');
      expect(system).toContain('list.filter(property = value)');
      expect(system).toContain('num(str(_item))');
      expect(system).toContain('root.CeRiskAssessment.children');
      expect(system).toContain('Make the smallest valid edit');
    }
  });

  it('adds examples only to the few-shot treatment', () => {
    expect(ecEditorSystemForVariant('compact-examples', 'unused')).toContain('# Positive EC patterns');
    expect(ecEditorSystemForVariant('standalone-language', 'unused')).not.toContain('# Positive EC patterns');
  });

  it('can isolate framing from knowledge compression', () => {
    const system = ecEditorSystemForVariant('standalone-full', 'unused');
    expect(system).toContain('standalone proprietary programming language');
    expect(system).toContain('<ec_language_core>');
    expect(system).toContain('<ec_sidebar_workflows>');
    expect(system).not.toContain('# Extended Code specification');
  });

  it('offers a structured coverage-preserving editor reference', () => {
    const system = ecEditorSystemForVariant('structured-editor', 'unused');
    expect(system).toContain('<ec_language_core>');
    expect(system).toContain('<ec_editor_policy>');
    expect(system).toContain('A filtered JSON-object list must be serialized and reparsed');
    expect(system).toContain('.calculate(expression)');
    expect(system).toContain('_position := _name.indexOf("Risk").whenMissing(-1)');
    expect(system).toContain('The context object\'s business ID identifies the property owner only');
    expect(system).toContain('never compare the chained `indexOf`');
    expect(system).toContain('There is no `groupBy`');
    expect(system).toContain('Repeated multi-term concatenation');
    expect(system).toContain('_default.change(template := _template)');
    expect(system).toContain('Complete every filter and sort');
    expect(system).toContain('Before returning, silently validate');
    expect(system).not.toContain('HARD NO-GO');
  });

  it('keeps the winning treatment identical to the production EC system prompt', () => {
    const production = buildEditorPrompt({
      requestId: 'test',
      intent: 'edit',
      lang: 'extended',
      code: '',
      selection: null,
      instruction: '',
      context: {},
    }).system;
    expect(ecEditorSystemForVariant('structured-editor', 'unused')).toBe(production);
  });

  it('keeps the three identity framings experimentally distinct', () => {
    expect(ecEditorSystemForVariant('standalone-language', 'unused')).toContain('standalone proprietary programming language');
    expect(ecEditorSystemForVariant('negative-contrast', 'unused')).toContain('NOT JavaScript, Python, or SQL');
    expect(ecEditorSystemForVariant('similar-but-different', 'unused')).toContain('superficially similar to JavaScript');
  });

  it('rejects unknown treatments instead of silently running production', () => {
    expect(() => parseEcEditorPromptVariant('mystery')).toThrow(/Unknown EC editor prompt variant/);
  });
});
