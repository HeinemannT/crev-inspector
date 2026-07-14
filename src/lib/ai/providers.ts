/**
 * Provider metadata — base URLs, host-permission origins, default + suggested
 * models. Pure data with no runtime dependencies, so it is safe to import from
 * the service worker (client, handler), the low-level site-access module, and
 * the sidepanel UI alike.
 */

import type { AiProviderId } from './types';

export interface ProviderMeta {
  id: AiProviderId;
  label: string;
  /** Base URL. For OpenAI-compatible providers this already includes `/v1`;
   *  the request appends `/chat/completions`. For Anthropic the request appends
   *  `/v1/messages`. */
  baseUrl: string;
  /** Host-permission match pattern requested when a key is saved. */
  origin: string;
  /** Suggested default model (editable). */
  defaultModel: string;
  /** Static suggestion list for the model datalist. */
  suggestedModels: string[];
  /** True for the OpenAI `/chat/completions` dialect (openai / deepseek / grok). */
  openAiCompat: boolean;
}

export const PROVIDERS: Record<AiProviderId, ProviderMeta> = {
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    baseUrl: 'https://api.anthropic.com',
    origin: 'https://api.anthropic.com/*',
    defaultModel: 'claude-opus-4-8',
    suggestedModels: ['claude-opus-4-8', 'claude-sonnet-5', 'claude-haiku-4-5'],
    openAiCompat: false,
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    origin: 'https://api.openai.com/*',
    defaultModel: 'gpt-5.2',
    suggestedModels: ['gpt-5.2', 'gpt-5-mini'],
    openAiCompat: true,
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    origin: 'https://api.deepseek.com/*',
    defaultModel: 'deepseek-v4-flash',
    suggestedModels: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-chat'],
    openAiCompat: true,
  },
  grok: {
    id: 'grok',
    label: 'Grok',
    baseUrl: 'https://api.x.ai/v1',
    origin: 'https://api.x.ai/*',
    defaultModel: 'grok-4',
    suggestedModels: ['grok-4'],
    openAiCompat: true,
  },
};

export const AI_PROVIDER_IDS: AiProviderId[] = ['anthropic', 'openai', 'deepseek', 'grok'];

/** Every provider API origin. site-access keeps these granted so a profile
 *  reconcile never revokes a key's host permission. */
export const AI_API_ORIGINS: string[] = AI_PROVIDER_IDS.map(id => PROVIDERS[id].origin);

export function providerMeta(id: AiProviderId): ProviderMeta {
  return PROVIDERS[id];
}
