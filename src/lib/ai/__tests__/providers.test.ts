import { describe, it, expect } from 'vitest';
import { PROVIDERS, AI_PROVIDER_IDS, AI_API_ORIGINS } from '../providers';

describe('providers', () => {
  it('lists the four supported providers', () => {
    expect(AI_PROVIDER_IDS).toEqual(['anthropic', 'openai', 'deepseek', 'grok']);
  });

  it('marks the three OpenAI-compatible providers', () => {
    expect(PROVIDERS.anthropic.openAiCompat).toBe(false);
    expect(PROVIDERS.openai.openAiCompat).toBe(true);
    expect(PROVIDERS.deepseek.openAiCompat).toBe(true);
    expect(PROVIDERS.grok.openAiCompat).toBe(true);
  });

  it('uses DeepSeek V4 Flash for new configurations while retaining the legacy alias as a suggestion', () => {
    expect(PROVIDERS.deepseek.defaultModel).toBe('deepseek-v4-flash');
    expect(PROVIDERS.deepseek.suggestedModels).toContain('deepseek-chat');
  });

  it('exposes each provider API origin so site-access never revokes it', () => {
    expect(AI_API_ORIGINS).toEqual([
      'https://api.anthropic.com/*',
      'https://api.openai.com/*',
      'https://api.deepseek.com/*',
      'https://api.x.ai/*',
    ]);
  });

  it('has a default model in each suggestion list', () => {
    for (const id of AI_PROVIDER_IDS) {
      const p = PROVIDERS[id];
      expect(p.suggestedModels).toContain(p.defaultModel);
    }
  });
});
