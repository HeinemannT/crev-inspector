/**
 * Provider metadata — base URLs, host-permission origins, default + suggested
 * models. Pure data with no runtime dependencies, so it is safe to import from
 * the service worker (client, handler), the low-level site-access module, and
 * the sidepanel UI alike.
 */

import type { AiApiType, AiCustomProvider, AiProviderId, AiSettings } from './types';

export type BuiltinProviderId = Exclude<AiProviderId, 'custom'>;

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
  /** Optional selected-model limits from a custom catalogue. */
  maxOutputTokens?: number;
}

export const PROVIDERS: Record<BuiltinProviderId, ProviderMeta> = {
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

export const AI_PROVIDER_IDS: BuiltinProviderId[] = ['anthropic', 'openai', 'deepseek', 'grok'];

/** Every provider API origin. site-access keeps these granted so a profile
 *  reconcile never revokes a key's host permission. */
export const AI_API_ORIGINS: string[] = AI_PROVIDER_IDS.map(id => PROVIDERS[id].origin);

export function providerMeta(id: BuiltinProviderId): ProviderMeta {
  return PROVIDERS[id];
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function optionalPositiveInteger(value: unknown, field: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) <= 0) throw new Error(`${field} must be a positive integer`);
  return value as number;
}

function apiBaseUrl(value: unknown, field: string): string {
  const raw = nonEmptyString(value, field).replace(/\/+$/, '');
  let parsed: URL;
  try { parsed = new URL(raw); } catch { throw new Error(`${field} must be a valid URL`); }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error(`${field} must use http or https`);
  return raw;
}

/** Parse the technical-user JSON format. The returned provider is safe to
 * persist; the plaintext key is returned separately for immediate encryption. */
export function parseCustomProviderJson(json: string): { provider: AiCustomProvider; apiKey?: string } {
  let raw: unknown;
  try { raw = JSON.parse(json); } catch (e) {
    throw new Error(`Invalid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Provider JSON must be an object');
  const input = raw as Record<string, unknown>;
  const apiType = input.apiType;
  if (apiType !== 'openai' && apiType !== 'anthropic') throw new Error('apiType must be "openai" or "anthropic"');
  if (!Array.isArray(input.models) || input.models.length === 0) throw new Error('models must contain at least one model');
  const models = input.models.map((item, index) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`models[${index}] must be an object`);
    const model = item as Record<string, unknown>;
    if (typeof model.toolCalling !== 'boolean') throw new Error(`models[${index}].toolCalling must be true or false`);
    if (model.vision !== undefined && typeof model.vision !== 'boolean') throw new Error(`models[${index}].vision must be true or false`);
    return {
      id: nonEmptyString(model.id, `models[${index}].id`),
      name: nonEmptyString(model.name, `models[${index}].name`),
      url: apiBaseUrl(model.url, `models[${index}].url`),
      toolCalling: model.toolCalling,
      ...(model.vision !== undefined ? { vision: model.vision } : {}),
      ...(optionalPositiveInteger(model.maxInputTokens, `models[${index}].maxInputTokens`) !== undefined
        ? { maxInputTokens: model.maxInputTokens as number } : {}),
      ...(optionalPositiveInteger(model.maxOutputTokens, `models[${index}].maxOutputTokens`) !== undefined
        ? { maxOutputTokens: model.maxOutputTokens as number } : {}),
    };
  });
  if (new Set(models.map(model => model.id)).size !== models.length) throw new Error('Model ids must be unique');
  if (!models.some(model => model.toolCalling)) throw new Error('At least one model must support tool calling');
  const key = input.apiKey;
  if (key !== undefined && typeof key !== 'string') throw new Error('apiKey must be a string');
  return {
    provider: {
      name: nonEmptyString(input.name, 'name'),
      vendor: nonEmptyString(input.vendor, 'vendor'),
      apiType: apiType as AiApiType,
      models,
    },
    ...(typeof key === 'string' && key.trim() ? { apiKey: key.trim() } : {}),
  };
}

/** Resolve the selected settings into the same runtime shape as a built-in. */
export function resolveProvider(settings: Pick<AiSettings, 'provider' | 'model' | 'customProvider'>): ProviderMeta {
  if (settings.provider !== 'custom') return PROVIDERS[settings.provider];
  const custom = settings.customProvider;
  if (!custom) throw new Error('Custom provider configuration is missing');
  const model = custom.models.find(item => item.id === settings.model);
  if (!model) throw new Error(`Model "${settings.model}" is not in the custom provider JSON`);
  if (!model.toolCalling) throw new Error(`Model "${settings.model}" does not support tool calling`);
  return {
    id: 'custom',
    label: custom.name,
    baseUrl: model.url,
    origin: `${new URL(model.url).origin}/*`,
    defaultModel: custom.models.find(item => item.toolCalling)?.id ?? custom.models[0].id,
    suggestedModels: custom.models.filter(item => item.toolCalling).map(item => item.id),
    openAiCompat: custom.apiType === 'openai',
    maxOutputTokens: model.maxOutputTokens,
  };
}

export function customProviderOrigins(provider: AiCustomProvider | undefined): string[] {
  if (!provider) return [];
  return [...new Set(provider.models.map(model => `${new URL(model.url).origin}/*`))];
}
