/**
 * OpenAI-compatible chat-completions dialect — one implementation, three
 * providers (OpenAI, DeepSeek, Grok). They share the wire format:
 *
 *   POST {baseUrl}/chat/completions   Authorization: Bearer <key>
 *   body: { model, stream, messages:[{role:'system'...},{role:'user'...}] }
 *   SSE:  `data: {json}` lines, text at choices[0].delta.content, `data: [DONE]`
 *
 * `listModels` hits `GET {baseUrl}/models` to populate the model datalist.
 */

import { readSse } from './sse';
import type { ToolCall } from './tools';
import { toOpenAiTools, TOOL_DEFS } from './tool-contracts';
import type { AiMaxTokensParam, AiTokenUsage } from './types';

export interface OpenAiStreamOpts {
  baseUrl: string;
  model: string;
  maxTokens?: number;
  maxTokensParam?: AiMaxTokensParam;
  apiKey: string;
  system: string;
  user: string;
  signal?: AbortSignal;
  onChunk: (delta: string) => void;
}

interface OpenAiToolCallDelta {
  index?: number;
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAiChunk {
  choices?: Array<{
    delta?: { content?: string; tool_calls?: OpenAiToolCallDelta[] };
    finish_reason?: string | null;
  }>;
  error?: { message?: string };
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
    completion_tokens_details?: { reasoning_tokens?: number };
  };
}

const EMPTY_USAGE = (): AiTokenUsage => ({
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
});

function requestsStreamingUsage(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === 'openrouter.ai' || host === 'api.openai.com';
  } catch {
    return false;
  }
}

function captureUsage(target: AiTokenUsage, parsed: OpenAiChunk): void {
  const usage = parsed.usage;
  if (!usage) return;
  target.inputTokens = usage.prompt_tokens ?? target.inputTokens;
  target.cachedInputTokens = usage.prompt_tokens_details?.cached_tokens ?? target.cachedInputTokens;
  target.outputTokens = usage.completion_tokens ?? target.outputTokens;
  target.reasoningTokens = usage.completion_tokens_details?.reasoning_tokens ?? target.reasoningTokens;
}

export async function streamOpenAiCompat(opts: OpenAiStreamOpts): Promise<{ text: string; usage: AiTokenUsage }> {
  const url = `${opts.baseUrl}/chat/completions`;
  const messages: Array<{ role: string; content: string }> = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: opts.user });

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${opts.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: opts.model,
      stream: true,
      ...(requestsStreamingUsage(opts.baseUrl) ? { stream_options: { include_usage: true } } : {}),
      messages,
      ...outputLimit(opts.maxTokens, opts.maxTokensParam),
    }),
    signal: opts.signal,
  });

  if (!response.ok) throw new Error(await errorFromResponse(response));

  let text = '';
  const usage = EMPTY_USAGE();
  await readSse(response, (frame) => {
    if (!frame.data || frame.data === '[DONE]') return;
    const parsed = safeParse(frame.data);
    if (!parsed) return;
    if (parsed.error?.message) throw new Error(parsed.error.message);
    captureUsage(usage, parsed);
    const delta = parsed.choices?.[0]?.delta?.content;
    if (delta) { text += delta; opts.onChunk(delta); }
  });
  return { text, usage };
}

// ── Tool-aware turn (chat orchestrator) ──────────────────────────

/** An OpenAI message we send back on a tool turn. `tool` role carries a
 *  single tool result keyed by tool_call_id. */
export type OpenAiMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface OpenAiTurnOpts {
  baseUrl: string;
  model: string;
  maxTokens?: number;
  maxTokensParam?: AiMaxTokensParam;
  apiKey: string;
  messages: OpenAiMessage[];
  /** Omit / empty to force a tools-off final answer. */
  tools?: ReturnType<typeof toOpenAiTools>;
  /** Force the single evidence follow-up selected by the orchestrator. */
  forceTool?: string;
  /** Require one of the supplied terminal tools while leaving the semantic
   * choice to the model. Mutually exclusive with forceTool. */
  requireTool?: boolean;
  signal?: AbortSignal;
  onText: (delta: string) => void;
}

export interface OpenAiTurnResult {
  text: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
  /** The assistant message to append for the next turn. */
  assistantMessage: OpenAiMessage;
  usage: AiTokenUsage;
}

interface ToolCallAcc { id: string; name: string; args: string; }

function outputLimit(maxTokens?: number, param: AiMaxTokensParam = 'max_completion_tokens'): Partial<Record<AiMaxTokensParam, number>> {
  return maxTokens ? { [param]: maxTokens } : {};
}

/** Run ONE OpenAI-compatible turn with optional tools. Streams text via
 *  onText and accumulates streamed `delta.tool_calls` (by index) into parsed
 *  ToolCalls. Returns the finish reason + the assistant message to replay. */
export async function streamOpenAiTurn(opts: OpenAiTurnOpts): Promise<OpenAiTurnResult> {
  const url = `${opts.baseUrl}/chat/completions`;
  const useTools = opts.tools && opts.tools.length > 0;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${opts.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: opts.model,
      stream: true,
      ...(requestsStreamingUsage(opts.baseUrl) ? { stream_options: { include_usage: true } } : {}),
      messages: opts.messages,
      ...outputLimit(opts.maxTokens, opts.maxTokensParam),
      ...(useTools ? {
        tools: opts.tools,
        parallel_tool_calls: false,
        ...(opts.forceTool
          ? { tool_choice: { type: 'function', function: { name: opts.forceTool } } }
          : opts.requireTool ? { tool_choice: 'required' } : {}),
      } : {}),
    }),
    signal: opts.signal,
  });

  if (!response.ok) throw new Error(await errorFromResponse(response));

  let text = '';
  let finishReason: string | null = null;
  const calls = new Map<number, ToolCallAcc>();
  const usage = EMPTY_USAGE();

  await readSse(response, (frame) => {
    if (!frame.data || frame.data === '[DONE]') return;
    const parsed = safeParse(frame.data);
    if (!parsed) return;
    if (parsed.error?.message) throw new Error(parsed.error.message);
    captureUsage(usage, parsed);
    const choice = parsed.choices?.[0];
    if (!choice) return;
    if (choice.delta?.content) { text += choice.delta.content; opts.onText(choice.delta.content); }
    for (const tc of choice.delta?.tool_calls ?? []) {
      const idx = tc.index ?? 0;
      const acc = calls.get(idx) ?? { id: '', name: '', args: '' };
      if (tc.id) acc.id = tc.id;
      if (tc.function?.name) acc.name = tc.function.name;
      if (tc.function?.arguments) acc.args += tc.function.arguments;
      calls.set(idx, acc);
    }
    if (choice.finish_reason) finishReason = choice.finish_reason;
  });

  const toolCalls: ToolCall[] = [];
  const rawCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];
  for (const idx of [...calls.keys()].sort((a, b) => a - b)) {
    const acc = calls.get(idx)!;
    const id = acc.id || `call_${idx}`;
    toolCalls.push({ id, name: acc.name, input: parseToolArgs(acc.args) });
    rawCalls.push({ id, type: 'function', function: { name: acc.name, arguments: acc.args || '{}' } });
  }

  const assistantMessage: OpenAiMessage = rawCalls.length
    ? { role: 'assistant', content: text || null, tool_calls: rawCalls }
    : { role: 'assistant', content: text };

  return { text, toolCalls, finishReason, assistantMessage, usage };
}

function parseToolArgs(args: string): Record<string, unknown> {
  const trimmed = args.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** Convenience: the default OpenAI tool projection. */
export function openAiTools(): ReturnType<typeof toOpenAiTools> {
  return toOpenAiTools(TOOL_DEFS);
}

interface ModelsResponse {
  data?: Array<{ id?: string }>;
  error?: { message?: string };
}

/** List available model ids. Best-effort — the text input still works if this
 *  fails. */
export async function listModels(baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<string[]> {
  const response = await fetch(`${baseUrl}/models`, {
    headers: { 'Authorization': `Bearer ${apiKey}` },
    signal,
  });
  if (!response.ok) throw new Error(await errorFromResponse(response));
  const json = (await response.json()) as ModelsResponse;
  if (json.error?.message) throw new Error(json.error.message);
  return (json.data ?? [])
    .map(m => m.id)
    .filter((id): id is string => !!id)
    .sort();
}

function safeParse(data: string): OpenAiChunk | null {
  try { return JSON.parse(data) as OpenAiChunk; } catch { return null; }
}

async function errorFromResponse(response: Response): Promise<string> {
  let detail = '';
  try {
    const raw = await response.text();
    const json = raw ? (JSON.parse(raw) as OpenAiChunk) : null;
    detail = json?.error?.message ?? raw;
  } catch { /* not JSON */ }
  return detail ? `${response.status}: ${detail}` : `Request failed (${response.status})`;
}
