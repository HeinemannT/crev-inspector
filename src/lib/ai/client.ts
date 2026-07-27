/**
 * Provider-agnostic orchestrator used by the SW handler. Builds the prompt,
 * picks the dialect, streams, and supports AbortController cancellation. The
 * decrypted API key is passed in by the handler and never stored here.
 */

import type { AiChatEvent, AiChatTurn, AiRequestPayload, AiSettings } from './types';
import { resolveProvider } from './providers';
import { buildPrompt } from './prompt';
import { streamAnthropic, streamAnthropicTurn, anthropicTools } from './anthropic';
import type { AnthropicContentBlock, AnthropicMessage } from './anthropic';
import { streamOpenAiCompat, streamOpenAiTurn, openAiTools, listModels as listOpenAiModels } from './openai-compat';
import type { OpenAiMessage } from './openai-compat';
import type { ExecuteTool, ToolCall, ToolResult } from './tools';
import { MAX_TOOL_CALLS, TOOL_BUDGET_EXHAUSTED_NOTE, truncateToolResult } from './tools';
import { ToolMarkupScrubber } from './scrub';

export interface StreamCompletionOpts {
  settings: AiSettings;
  /** Decrypted API key. */
  apiKey: string;
  payload: AiRequestPayload;
  onChunk: (delta: string) => void;
  signal?: AbortSignal;
}

export async function streamCompletion(opts: StreamCompletionOpts): Promise<{ text: string }> {
  const meta = resolveProvider(opts.settings);
  const { system, user } = buildPrompt(opts.payload);
  if (meta.openAiCompat) {
    return streamOpenAiCompat({
      baseUrl: meta.baseUrl,
      model: opts.settings.model,
      maxTokens: meta.maxOutputTokens,
      maxTokensParam: meta.maxTokensParam,
      apiKey: opts.apiKey,
      system,
      user,
      signal: opts.signal,
      onChunk: opts.onChunk,
    });
  }
  return streamAnthropic({
    baseUrl: meta.baseUrl,
    model: opts.settings.model,
    maxTokens: meta.maxOutputTokens,
    apiKey: opts.apiKey,
    system,
    user,
    signal: opts.signal,
    onChunk: opts.onChunk,
  });
}

// ── Chat orchestrator (tool loop, both dialects) ─────────────────

/** Hard ceiling for each tool-using chat turn. The prompt carries the tighter
 * prose limit; this prevents a provider from producing an unbounded answer. */
export const CHAT_MAX_OUTPUT_TOKENS = 2048;

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
  const meta = resolveProvider(opts.settings);
  const maxTokens = Math.min(meta.maxOutputTokens ?? CHAT_MAX_OUTPUT_TOKENS, CHAT_MAX_OUTPUT_TOKENS);
  try {
    if (meta.openAiCompat) await runOpenAiChat(opts, meta.baseUrl, maxTokens, meta.maxTokensParam);
    else await runAnthropicChat(opts, meta.baseUrl, maxTokens);
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
    case 'read_code': return `read_code ${arg('ref') ?? ''}.${arg('property') ?? ''}`.trim();
    case 'query_context': return `query_context ${arg('type') ?? arg('templateQuery') ?? ''}`.trim();
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
  appendFinalNote: () => void,
  opts: StreamChatOpts,
): Promise<void> {
  let used = 0;
  let notedFinal = false;
  const priorResults = new Map<string, ToolResult>();
  for (;;) {
    if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const allowTools = used < MAX_TOOL_CALLS;
    // On the forced tools-off turn, tell the model WHY tools vanished so it
    // answers instead of emitting tool-call syntax as plain text (Issue A).
    if (!allowTools && !notedFinal) { appendFinalNote(); notedFinal = true; }
    const toolCalls = await runTurn(allowTools);
    // A tools-off turn (or a turn that asked for nothing) is the final answer.
    if (!allowTools || toolCalls.length === 0) return;
    const results: Array<{ call: ToolCall; result: ToolResult }> = [];
    for (const call of toolCalls) {
      if (opts.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const summary = summarizeCall(call);
      opts.onEvent({ kind: 'tool-start', name: call.name, summary });
      let result: ToolResult;
      if (used >= MAX_TOOL_CALLS) {
        result = { content: TOOL_BUDGET_EXHAUSTED_NOTE, isError: true };
      } else {
        used++;
        const fingerprint = toolCallFingerprint(call);
        const prior = priorResults.get(fingerprint);
        if (prior) {
          result = {
            content: truncateToolResult(
              'Duplicate tool call suppressed. Reuse the result already returned for these exact arguments and answer now if it is sufficient.\n\n' + prior.content,
            ),
            isError: prior.isError,
          };
        } else {
          result = await opts.executeTool(call, opts.signal);
          priorResults.set(fingerprint, result);
        }
      }
      opts.onEvent({
        kind: 'tool-end',
        name: call.name,
        summary,
        ok: !result.isError,
        objects: result.objects,
      });
      results.push({ call, result });
    }
    appendResults(results);
  }
}

/** Stable across provider key ordering so semantically identical calls share
 *  one backend result. Tool call ids are deliberately excluded. */
function toolCallFingerprint(call: ToolCall): string {
  const stable = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`)
        .join(',')}}`;
    }
    return JSON.stringify(value);
  };
  return `${call.name}:${stable(call.input)}`;
}

async function runAnthropicChat(opts: StreamChatOpts, baseUrl: string, maxTokens?: number): Promise<void> {
  const messages: AnthropicMessage[] = [];
  for (const turn of opts.history) messages.push({ role: turn.role, content: turn.text });
  messages.push({ role: 'user', content: opts.text });

  const runTurn = async (allowTools: boolean): Promise<ToolCall[]> => {
    // Scrub DSML-style tool markup from text before it reaches the transcript.
    // One scrubber per turn (clean state; flushed at turn end). Deltas may
    // split a marker across chunks — the scrubber buffers a suspicious tail.
    const scrub = new ToolMarkupScrubber();
    const turn = await streamAnthropicTurn({
      baseUrl,
      model: opts.settings.model,
      maxTokens,
      apiKey: opts.apiKey,
      system: opts.system,
      messages,
      tools: allowTools ? anthropicTools() : [],
      signal: opts.signal,
      onText: (d) => { const clean = scrub.feed(d); if (clean) opts.onEvent({ kind: 'text-delta', delta: clean }); },
    });
    const tail = scrub.flush();
    if (tail) opts.onEvent({ kind: 'text-delta', delta: tail });
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

  // Anthropic requires alternating roles — fold the note into the last
  // tool_result user turn when present, else push a fresh user turn.
  const appendFinalNote = (): void => {
    const last = messages[messages.length - 1];
    if (last && last.role === 'user' && Array.isArray(last.content)) {
      last.content.push({ type: 'text', text: TOOL_BUDGET_EXHAUSTED_NOTE });
    } else {
      messages.push({ role: 'user', content: TOOL_BUDGET_EXHAUSTED_NOTE });
    }
  };

  await runToolLoop(runTurn, appendResults, appendFinalNote, opts);
}

async function runOpenAiChat(
  opts: StreamChatOpts,
  baseUrl: string,
  maxTokens?: number,
  maxTokensParam?: 'max_tokens' | 'max_completion_tokens',
): Promise<void> {
  const messages: OpenAiMessage[] = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  for (const turn of opts.history) messages.push({ role: turn.role, content: turn.text });
  messages.push({ role: 'user', content: opts.text });

  const runTurn = async (allowTools: boolean): Promise<ToolCall[]> => {
    // Per-turn DSML scrubber (see runAnthropicChat) — DeepSeek is the provider
    // that actually leaks tool markup as text once tools are dropped.
    const scrub = new ToolMarkupScrubber();
    const turn = await streamOpenAiTurn({
      baseUrl,
      model: opts.settings.model,
      maxTokens,
      maxTokensParam,
      apiKey: opts.apiKey,
      messages,
      tools: allowTools ? openAiTools() : [],
      signal: opts.signal,
      onText: (d) => { const clean = scrub.feed(d); if (clean) opts.onEvent({ kind: 'text-delta', delta: clean }); },
    });
    const tail = scrub.flush();
    if (tail) opts.onEvent({ kind: 'text-delta', delta: tail });
    messages.push(turn.assistantMessage);
    return turn.toolCalls;
  };

  const appendResults = (results: Array<{ call: ToolCall; result: ToolResult }>): void => {
    for (const r of results) messages.push({ role: 'tool', tool_call_id: r.call.id, content: r.result.content });
  };

  // OpenAI-compat allows a user turn after tool results — the plainest place
  // for the note.
  const appendFinalNote = (): void => {
    messages.push({ role: 'user', content: TOOL_BUDGET_EXHAUSTED_NOTE });
  };

  await runToolLoop(runTurn, appendResults, appendFinalNote, opts);
}

/** One-shot "does this key work" probe. Sends a tiny request and reports
 *  success/failure with the provider's error message. */
export async function testConnection(settings: AiSettings, apiKey: string, signal?: AbortSignal): Promise<{ ok: boolean; error?: string }> {
  const meta = resolveProvider(settings);
  const user = 'Reply with the single word: OK';
  try {
    let got = '';
    const onChunk = (d: string) => { got += d; };
    if (meta.openAiCompat) {
      await streamOpenAiCompat({
        baseUrl: meta.baseUrl,
        model: settings.model,
        maxTokens: meta.maxOutputTokens,
        maxTokensParam: meta.maxTokensParam,
        apiKey,
        system: '',
        user,
        signal,
        onChunk,
      });
    } else {
      await streamAnthropic({ baseUrl: meta.baseUrl, model: settings.model, maxTokens: meta.maxOutputTokens, apiKey, system: '', user, signal, onChunk });
    }
    return { ok: got.length > 0 };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** List models for an OpenAI-compatible provider. Throws for Anthropic (no
 *  listing endpoint — callers use the static suggestion list). */
export async function listModels(settings: AiSettings, apiKey: string, signal?: AbortSignal): Promise<string[]> {
  const meta = resolveProvider(settings);
  if (!meta.openAiCompat) throw new Error('Model listing is not available for this provider');
  return listOpenAiModels(meta.baseUrl, apiKey, signal);
}
