/**
 * Anthropic Messages API dialect. Streaming only.
 *
 * POST https://api.anthropic.com/v1/messages
 *   headers: x-api-key, anthropic-version, content-type,
 *            anthropic-dangerous-direct-browser-access
 *   body: { model, max_tokens, stream, system:[...], messages:[...] }
 *
 * We do NOT set temperature / top_p / thinking — current models reject or don't
 * need them. Prompt caching: the system is one text block carrying the stable
 * persona + knowledge prefix, marked cache_control ephemeral; volatile
 * per-request context rides in the user message.
 */

import { PROVIDERS } from './providers';
import { readSse } from './sse';
import type { ToolCall } from './tools';
import { toAnthropicTools, TOOL_DEFS } from './tools';

const ANTHROPIC_VERSION = '2023-06-01';
const MAX_TOKENS = 8192;

export interface AnthropicStreamOpts {
  model: string;
  apiKey: string;
  /** Stable persona + knowledge prefix (empty string = no system block). */
  system: string;
  /** Volatile user message. */
  user: string;
  signal?: AbortSignal;
  onChunk: (delta: string) => void;
}

interface AnthropicDelta {
  type?: string;
  index?: number;
  content_block?: { type?: string; id?: string; name?: string };
  delta?: { type?: string; text?: string; partial_json?: string; stop_reason?: string };
  error?: { type?: string; message?: string };
}

/** Anthropic message content block we send back on a tool turn. */
export type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export type AnthropicMessage = { role: 'user' | 'assistant'; content: string | AnthropicContentBlock[] };

/** A 5-minute ephemeral cache breakpoint. Anthropic caps a request at 4 of
 *  these; the tool turn uses at most 3 (tools, system, turn boundary). */
const CACHE_CONTROL = { type: 'ephemeral' } as const;

/** A content block that may carry a cache breakpoint (wire shape only). */
type WireBlock = AnthropicContentBlock & { cache_control?: typeof CACHE_CONTROL };
type WireMessage = { role: 'user' | 'assistant'; content: string | WireBlock[] };
type WireTool = ReturnType<typeof toAnthropicTools>[number] & { cache_control?: typeof CACHE_CONTROL };

/** Put a cache breakpoint on the LAST tool definition. Tool defs serialize as
 *  one unit before system, so one breakpoint at the tail caches all of them —
 *  provided the set stays byte-stable across the session (it does: TOOL_DEFS is
 *  a fixed-order constant). */
function withToolCacheBreakpoint(tools: ReturnType<typeof toAnthropicTools>): WireTool[] {
  return tools.map((t, i) => (i === tools.length - 1 ? { ...t, cache_control: CACHE_CONTROL } : { ...t }));
}

/** Put a cache breakpoint on the last content block of the FINAL message — the
 *  standard multi-turn pattern. This moves the breakpoint forward every request
 *  so consecutive requests inside the tool loop (and across user turns) re-read
 *  the prefix instead of falling outside the 20-block lookback window. A plain
 *  string content is promoted to a single text block so the marker has a home. */
function withHistoryCacheBreakpoint(messages: AnthropicMessage[]): WireMessage[] {
  if (messages.length === 0) return messages;
  const out: WireMessage[] = messages.slice();
  const last = out[out.length - 1];
  const blocks: WireBlock[] = typeof last.content === 'string'
    ? [{ type: 'text', text: last.content }]
    : last.content.map(b => ({ ...b }));
  if (blocks.length === 0) return out;
  blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: CACHE_CONTROL };
  out[out.length - 1] = { role: last.role, content: blocks };
  return out;
}

export async function streamAnthropic(opts: AnthropicStreamOpts): Promise<{ text: string }> {
  const url = `${PROVIDERS.anthropic.baseUrl}/v1/messages`;
  const system = opts.system
    ? [{ type: 'text', text: opts.system, cache_control: CACHE_CONTROL }]
    : undefined;
  const body = {
    model: opts.model,
    max_tokens: MAX_TOKENS,
    stream: true,
    ...(system ? { system } : {}),
    messages: [{ role: 'user', content: opts.user }],
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'x-api-key': opts.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!response.ok) throw new Error(await errorFromResponse(response));

  let text = '';
  await readSse(response, (frame) => {
    if (frame.event === 'error') {
      const parsed = safeParse(frame.data);
      throw new Error(parsed?.error?.message ?? 'Anthropic streaming error');
    }
    if (frame.event === 'message_stop') return;
    if (!frame.data || frame.data === '[DONE]') return;
    const parsed = safeParse(frame.data);
    if (!parsed) return;
    if (parsed.type === 'content_block_delta' && parsed.delta?.type === 'text_delta' && parsed.delta.text) {
      text += parsed.delta.text;
      opts.onChunk(parsed.delta.text);
    }
  });
  return { text };
}

// ── Tool-aware turn (chat orchestrator) ──────────────────────────

export interface AnthropicTurnOpts {
  model: string;
  apiKey: string;
  /** Cached persona + knowledge + tool guidance + rendered context. */
  system: string;
  messages: AnthropicMessage[];
  /** Omit / empty to force a tools-off final answer. */
  tools?: ReturnType<typeof toAnthropicTools>;
  signal?: AbortSignal;
  /** Streamed assistant text deltas. */
  onText: (delta: string) => void;
}

export interface AnthropicTurnResult {
  text: string;
  toolCalls: ToolCall[];
  stopReason: string | null;
  /** The assistant content blocks (text + tool_use) to append for the next
   *  turn — echoed verbatim so the tool_result user turn is well-formed. */
  content: AnthropicContentBlock[];
}

/** Accumulator for one streamed content block (text or tool_use). */
interface BlockAcc {
  type: 'text' | 'tool_use';
  text: string;
  id?: string;
  name?: string;
  json: string;
}

/** Run ONE Anthropic turn with optional tools. Streams text via onText and
 *  accumulates streamed tool_use blocks (input_json_delta) into parsed
 *  ToolCalls. Returns the stop reason + the assistant content blocks so the
 *  caller can drive the tool loop. */
export async function streamAnthropicTurn(opts: AnthropicTurnOpts): Promise<AnthropicTurnResult> {
  const url = `${PROVIDERS.anthropic.baseUrl}/v1/messages`;
  // Prompt-cache breakpoints (max 4 per request; Anthropic reads = 0.1x input).
  // The stable prefix serializes as tools → system → messages, so we place at
  // most THREE ephemeral breakpoints, one per prefix segment:
  //   1. the LAST tool definition  → caches the whole (byte-stable) tools block
  //   2. the system block          → caches tools + system together
  //   3. the last block of the last message → a moving turn-boundary breakpoint
  // (3) is essential: Anthropic's cache lookback only walks 20 content blocks
  // back from a breakpoint, and one tool loop can emit far more than 20
  // tool_use/tool_result blocks, so without a fresh breakpoint at the tail the
  // NEXT request silently misses the prefix cache.
  const system = opts.system
    ? [{ type: 'text', text: opts.system, cache_control: CACHE_CONTROL }]
    : undefined;
  const useTools = opts.tools && opts.tools.length > 0;
  const tools = useTools ? withToolCacheBreakpoint(opts.tools!) : undefined;
  const messages = withHistoryCacheBreakpoint(opts.messages);
  const body = {
    model: opts.model,
    max_tokens: MAX_TOKENS,
    stream: true,
    ...(system ? { system } : {}),
    ...(tools ? { tools } : {}),
    messages,
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'x-api-key': opts.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });

  if (!response.ok) throw new Error(await errorFromResponse(response));

  const blocks = new Map<number, BlockAcc>();
  let stopReason: string | null = null;

  await readSse(response, (frame) => {
    if (frame.event === 'error') {
      const parsed = safeParse(frame.data);
      throw new Error(parsed?.error?.message ?? 'Anthropic streaming error');
    }
    if (!frame.data || frame.data === '[DONE]') return;
    const parsed = safeParse(frame.data);
    if (!parsed) return;
    switch (parsed.type) {
      case 'content_block_start': {
        const idx = parsed.index ?? 0;
        const cb = parsed.content_block;
        if (cb?.type === 'tool_use') {
          blocks.set(idx, { type: 'tool_use', text: '', id: cb.id, name: cb.name, json: '' });
        } else {
          blocks.set(idx, { type: 'text', text: '', json: '' });
        }
        break;
      }
      case 'content_block_delta': {
        const idx = parsed.index ?? 0;
        const acc = blocks.get(idx) ?? { type: 'text', text: '', json: '' };
        if (parsed.delta?.type === 'text_delta' && parsed.delta.text) {
          acc.text += parsed.delta.text;
          opts.onText(parsed.delta.text);
        } else if (parsed.delta?.type === 'input_json_delta' && parsed.delta.partial_json != null) {
          acc.json += parsed.delta.partial_json;
        }
        blocks.set(idx, acc);
        break;
      }
      case 'message_delta':
        if (parsed.delta?.stop_reason) stopReason = parsed.delta.stop_reason;
        break;
      default:
        break;
    }
  });

  let text = '';
  const content: AnthropicContentBlock[] = [];
  const toolCalls: ToolCall[] = [];
  for (const idx of [...blocks.keys()].sort((a, b) => a - b)) {
    const acc = blocks.get(idx)!;
    if (acc.type === 'text') {
      if (acc.text) { text += acc.text; content.push({ type: 'text', text: acc.text }); }
    } else {
      const input = parseToolInput(acc.json);
      const id = acc.id ?? `tool_${idx}`;
      const name = acc.name ?? '';
      content.push({ type: 'tool_use', id, name, input });
      toolCalls.push({ id, name, input });
    }
  }

  return { text, toolCalls, stopReason, content };
}

/** Parse an accumulated tool-input JSON blob. Empty / malformed → `{}` so a
 *  bad delta never crashes the loop. */
function parseToolInput(json: string): Record<string, unknown> {
  const trimmed = json.trim();
  if (!trimmed) return {};
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/** Convenience: the default tool projection, exported so the client can pass
 *  it without re-importing tools.ts. */
export function anthropicTools(): ReturnType<typeof toAnthropicTools> {
  return toAnthropicTools(TOOL_DEFS);
}

function safeParse(data: string): AnthropicDelta | null {
  try { return JSON.parse(data) as AnthropicDelta; } catch { return null; }
}

/** Turn a non-2xx Anthropic response into a human-readable message. */
export async function errorFromResponse(response: Response): Promise<string> {
  let detail = '';
  try {
    const raw = await response.text();
    const json = raw ? (JSON.parse(raw) as AnthropicDelta) : null;
    detail = json?.error?.message ?? raw;
  } catch { /* body already consumed / not JSON */ }
  return detail ? `Anthropic ${response.status}: ${detail}` : `Anthropic request failed (${response.status})`;
}
