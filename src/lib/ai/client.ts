/**
 * Provider-agnostic orchestrator used by the SW handler. Builds the prompt,
 * picks the dialect, streams, and supports AbortController cancellation. The
 * decrypted API key is passed in by the handler and never stored here.
 */

import type { AiChatEvent, AiChatTurn, AiRequestPayload, AiSettings } from './types';
import { PROVIDERS } from './providers';
import { buildPrompt } from './prompt';
import { streamAnthropic, streamAnthropicTurn, anthropicTools } from './anthropic';
import type { AnthropicContentBlock, AnthropicMessage } from './anthropic';
import { streamOpenAiCompat, streamOpenAiTurn, openAiTools, listModels as listOpenAiModels } from './openai-compat';
import type { OpenAiMessage } from './openai-compat';
import type { ExecuteTool, ToolCall, ToolResult } from './tools';
import { MAX_TOOL_CALLS } from './tools';

export interface StreamCompletionOpts {
  settings: AiSettings;
  /** Decrypted API key. */
  apiKey: string;
  payload: AiRequestPayload;
  onChunk: (delta: string) => void;
  signal?: AbortSignal;
}

export async function streamCompletion(opts: StreamCompletionOpts): Promise<{ text: string }> {
  const meta = PROVIDERS[opts.settings.provider];
  const { system, user } = buildPrompt(opts.payload);
  if (meta.openAiCompat) {
    return streamOpenAiCompat({
      baseUrl: meta.baseUrl,
      model: opts.settings.model,
      apiKey: opts.apiKey,
      system,
      user,
      signal: opts.signal,
      onChunk: opts.onChunk,
    });
  }
  return streamAnthropic({
    model: opts.settings.model,
    apiKey: opts.apiKey,
    system,
    user,
    signal: opts.signal,
    onChunk: opts.onChunk,
  });
}

// ── Chat orchestrator (tool loop, both dialects) ─────────────────

export interface StreamChatOpts {
  settings: AiSettings;
  /** Decrypted API key. */
  apiKey: string;
  /** Cached persona + knowledge + tool guidance + rendered context. */
  system: string;
  /** Prior transcript turns (the panel owns it, sends it whole). */
  history: AiChatTurn[];
  /** The new user turn's text. */
  text: string;
  onEvent: (e: AiChatEvent) => void;
  executeTool: ExecuteTool;
  signal?: AbortSignal;
}

/** Run one user turn as an agentic loop: stream text, run any requested
 *  read-only tools (capped at MAX_TOOL_CALLS), feed results back, repeat until
 *  the model answers. Emits the AiChatEvent stream via onEvent. On cancellation
 *  it returns quietly (no done/error); on a real failure it emits `error`. */
export async function streamChat(opts: StreamChatOpts): Promise<void> {
  const meta = PROVIDERS[opts.settings.provider];
  try {
    if (meta.openAiCompat) await runOpenAiChat(opts, meta.baseUrl);
    else await runAnthropicChat(opts);
    opts.onEvent({ kind: 'done' });
  } catch (e) {
    if (opts.signal?.aborted) return; // caller cancelled — UI already reset
    opts.onEvent({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
  }
}

/** A short human summary of a tool call for the transcript's tool trace. */
function summarizeCall(call: ToolCall): string {
  const arg = (k: string): string | undefined => {
    const v = call.input[k];
    return typeof v === 'string' ? v : undefined;
  };
  switch (call.name) {
    case 'read_object': return `read_object ${arg('ref') ?? ''}`.trim();
    case 'read_type': return `read_type ${arg('type') ?? ''}`.trim();
    case 'search_objects': return `search_objects "${arg('query') ?? ''}"`;
    case 'code_search': return `code_search "${arg('pattern') ?? ''}"`;
    case 'read_layout': return `read_layout ${arg('pageRid') ?? ''}`.trim();
    case 'preview_ec': {
      const code = arg('code') ?? '';
      const lines = code ? code.split('\n').length : 0;
      return `preview_ec (${lines} line${lines === 1 ? '' : 's'})`;
    }
    default: return call.name;
  }
}

/** The shared tool loop, driven by two dialect closures. `runTurn` streams one
 *  provider turn (appending the assistant message to its own message array) and
 *  returns the tool calls it requested; `appendResults` records the tool
 *  results for the next turn. */
async function runToolLoop(
  runTurn: (allowTools: boolean) => Promise<ToolCall[]>,
  appendResults: (results: Array<{ call: ToolCall; result: ToolResult }>) => void,
  opts: StreamChatOpts,
): Promise<void> {
  let used = 0;
  for (;;) {
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const allowTools = used < MAX_TOOL_CALLS;
    const toolCalls = await runTurn(allowTools);
    // A tools-off turn (or a turn that asked for nothing) is the final answer.
    if (!allowTools || toolCalls.length === 0) return;
    const results: Array<{ call: ToolCall; result: ToolResult }> = [];
    for (const call of toolCalls) {
      if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const summary = summarizeCall(call);
      opts.onEvent({ kind: 'tool-start', name: call.name, summary });
      const result = await opts.executeTool(call, opts.signal);
      opts.onEvent({ kind: 'tool-end', name: call.name, summary, ok: !result.isError });
      results.push({ call, result });
      used++;
    }
    appendResults(results);
  }
}

async function runAnthropicChat(opts: StreamChatOpts): Promise<void> {
  const messages: AnthropicMessage[] = [];
  for (const turn of opts.history) messages.push({ role: turn.role, content: turn.text });
  messages.push({ role: 'user', content: opts.text });

  const runTurn = async (allowTools: boolean): Promise<ToolCall[]> => {
    const turn = await streamAnthropicTurn({
      model: opts.settings.model,
      apiKey: opts.apiKey,
      system: opts.system,
      messages,
      tools: allowTools ? anthropicTools() : [],
      signal: opts.signal,
      onText: (d) => opts.onEvent({ kind: 'text-delta', delta: d }),
    });
    if (turn.content.length) messages.push({ role: 'assistant', content: turn.content });
    return turn.toolCalls;
  };

  const appendResults = (results: Array<{ call: ToolCall; result: ToolResult }>): void => {
    const content: AnthropicContentBlock[] = results.map(r => ({
      type: 'tool_result',
      tool_use_id: r.call.id,
      content: r.result.content,
      ...(r.result.isError ? { is_error: true } : {}),
    }));
    messages.push({ role: 'user', content });
  };

  await runToolLoop(runTurn, appendResults, opts);
}

async function runOpenAiChat(opts: StreamChatOpts, baseUrl: string): Promise<void> {
  const messages: OpenAiMessage[] = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  for (const turn of opts.history) messages.push({ role: turn.role, content: turn.text });
  messages.push({ role: 'user', content: opts.text });

  const runTurn = async (allowTools: boolean): Promise<ToolCall[]> => {
    const turn = await streamOpenAiTurn({
      baseUrl,
      model: opts.settings.model,
      apiKey: opts.apiKey,
      messages,
      tools: allowTools ? openAiTools() : [],
      signal: opts.signal,
      onText: (d) => opts.onEvent({ kind: 'text-delta', delta: d }),
    });
    messages.push(turn.assistantMessage);
    return turn.toolCalls;
  };

  const appendResults = (results: Array<{ call: ToolCall; result: ToolResult }>): void => {
    for (const r of results) messages.push({ role: 'tool', tool_call_id: r.call.id, content: r.result.content });
  };

  await runToolLoop(runTurn, appendResults, opts);
}

/** One-shot "does this key work" probe. Sends a tiny request and reports
 *  success/failure with the provider's error message. */
export async function testConnection(settings: AiSettings, apiKey: string, signal?: AbortSignal): Promise<{ ok: boolean; error?: string }> {
  const meta = PROVIDERS[settings.provider];
  const user = 'Reply with the single word: OK';
  try {
    let got = '';
    const onChunk = (d: string) => { got += d; };
    if (meta.openAiCompat) {
      await streamOpenAiCompat({ baseUrl: meta.baseUrl, model: settings.model, apiKey, system: '', user, signal, onChunk });
    } else {
      await streamAnthropic({ model: settings.model, apiKey, system: '', user, signal, onChunk });
    }
    return { ok: got.length > 0 };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** List models for an OpenAI-compatible provider. Throws for Anthropic (no
 *  listing endpoint — callers use the static suggestion list). */
export async function listModels(settings: AiSettings, apiKey: string, signal?: AbortSignal): Promise<string[]> {
  const meta = PROVIDERS[settings.provider];
  if (!meta.openAiCompat) throw new Error('Model listing is not available for this provider');
  return listOpenAiModels(meta.baseUrl, apiKey, signal);
}
