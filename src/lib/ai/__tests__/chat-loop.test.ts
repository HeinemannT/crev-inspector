import { describe, it, expect, vi, afterEach } from 'vitest';
import { CHAT_MAX_OUTPUT_TOKENS, streamChat } from '../client';
import type { AiChatEvent } from '../types';
import type { ToolResult } from '../tools';
import type { AiSettings } from '../types';

function streamBody(parts: string[]) {
  let i = 0;
  const enc = new TextEncoder();
  return { getReader() { return { read: () => Promise.resolve(i < parts.length ? { value: enc.encode(parts[i++]), done: false } : { value: undefined, done: true }) }; } };
}
function okStream(parts: string[]): any { return { ok: true, status: 200, body: streamBody(parts) }; }

const TOOL_TURN = [
  'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"t","name":"read_type"}}\n\n',
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"type\\":\\"ButtonInput\\"}"}}\n\n',
  'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
  'event: message_stop\ndata: {"type":"message_stop"}\n\n',
];
function toolTurn(type: string, id: string): string[] {
  return TOOL_TURN.map(frame => frame
    .replace('"id":"t"', `"id":"${id}"`)
    .replace('ButtonInput', type));
}
function multiToolTurn(count: number): string[] {
  const frames: string[] = [];
  for (let i = 0; i < count; i++) {
    frames.push(
      `event: content_block_start\ndata: {"type":"content_block_start","index":${i},"content_block":{"type":"tool_use","id":"t${i}","name":"read_type"}}\n\n`,
      `event: content_block_delta\ndata: {"type":"content_block_delta","index":${i},"delta":{"type":"input_json_delta","partial_json":"{\\"type\\":\\"Type${i}\\"}"}}\n\n`,
      `event: content_block_stop\ndata: {"type":"content_block_stop","index":${i}}\n\n`,
    );
  }
  frames.push(
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  );
  return frames;
}
const TEXT_TURN = [
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Final"}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
];
const OPENAI_TEXT_TURN = [
  'data: {"choices":[{"delta":{"content":"Final"}}]}\n\n',
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
  'data: [DONE]\n\n',
];

const settings: AiSettings = { provider: 'anthropic', model: 'claude-opus-4-8', apiKeyEnc: '' };

/** fetch mock: tool_use whenever tools are offered, text otherwise. */
function toolThenText() {
  let turn = 0;
  return vi.fn((_u: string, init: any) => {
    const body = JSON.parse(init.body);
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    turn++;
    return Promise.resolve(okStream(hasTools ? toolTurn(`ButtonInput${turn}`, `t${turn}`) : TEXT_TURN));
  });
}

afterEach(() => { vi.restoreAllMocks(); });

import { MAX_TOOL_CALLS, MAX_TOOL_ROUNDS, TOOL_BUDGET_EXHAUSTED_NOTE } from '../tools';

describe('streamChat tool loop', () => {
  it('applies the hard chat output cap to Anthropic', async () => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn((_u: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      return Promise.resolve(okStream(TEXT_TURN));
    }));

    await streamChat({ settings, apiKey: 'k', system: 'S', history: [], text: 'go', onEvent: () => {}, executeTool: vi.fn() });

    expect(bodies[0].max_tokens).toBe(CHAT_MAX_OUTPUT_TOKENS);
  });

  it('applies the hard chat output cap with the provider-specific OpenAI field', async () => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn((_u: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      return Promise.resolve(okStream(OPENAI_TEXT_TURN));
    }));
    const openAiSettings: AiSettings = { provider: 'openai', model: 'gpt-5.2', apiKeyEnc: '' };

    await streamChat({ settings: openAiSettings, apiKey: 'k', system: 'S', history: [], text: 'go', onEvent: () => {}, executeTool: vi.fn() });

    expect(bodies[0].max_completion_tokens).toBe(CHAT_MAX_OUTPUT_TOKENS);
    expect(bodies[0].max_tokens).toBeUndefined();
  });

  it('keeps a custom model limit when it is below the chat ceiling', async () => {
    const bodies: any[] = [];
    vi.stubGlobal('fetch', vi.fn((_u: string, init: any) => {
      bodies.push(JSON.parse(init.body));
      return Promise.resolve(okStream(OPENAI_TEXT_TURN));
    }));
    const customSettings: AiSettings = {
      provider: 'custom', model: 'small', apiKeyEnc: '',
      customProvider: {
        name: 'Custom', vendor: 'Vendor', apiType: 'openai',
        models: [{ id: 'small', name: 'Small', url: 'https://ai.example.test/v1', toolCalling: true, maxOutputTokens: 768, maxTokensParam: 'max_tokens' }],
      },
    };

    await streamChat({ settings: customSettings, apiKey: 'k', system: 'S', history: [], text: 'go', onEvent: () => {}, executeTool: vi.fn() });

    expect(bodies[0].max_tokens).toBe(768);
  });

  it('caps serial plans at MAX_TOOL_ROUNDS, then forces a tools-off final answer', async () => {
    vi.stubGlobal('fetch', toolThenText());
    const events: AiChatEvent[] = [];
    let toolCount = 0;
    const executeTool = vi.fn(async (): Promise<ToolResult> => { toolCount++; return { content: 'ok', isError: false }; });

    await streamChat({ settings, apiKey: 'k', system: 'S', history: [], text: 'go', onEvent: e => events.push(e), executeTool });

    expect(toolCount).toBe(MAX_TOOL_ROUNDS);
    expect(events.filter(e => e.kind === 'tool-start')).toHaveLength(MAX_TOOL_ROUNDS);
    expect(events.filter(e => e.kind === 'tool-end')).toHaveLength(MAX_TOOL_ROUNDS);
    expect(events.at(-1)).toEqual({ kind: 'done' });
    // The forced final turn streamed text.
    expect(events.some(e => e.kind === 'text-delta' && e.delta === 'Final')).toBe(true);
  });

  it('appends the tool-budget note on the forced final turn (and only then)', async () => {
    let turn = 0;
    const bodies: any[] = [];
    const fetchMock = vi.fn((_u: string, init: any) => {
      const body = JSON.parse(init.body);
      bodies.push(body);
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      turn++;
      return Promise.resolve(okStream(hasTools ? toolTurn(`ButtonInput${turn}`, `t${turn}`) : TEXT_TURN));
    });
    vi.stubGlobal('fetch', fetchMock);
    const executeTool = vi.fn(async (): Promise<ToolResult> => ({ content: 'ok', isError: false }));
    await streamChat({ settings, apiKey: 'k', system: 'S', history: [], text: 'go', onEvent: () => {}, executeTool });

    // The last request is the forced tools-off turn: no tools, and the note is
    // present in its message array (folded into the last user turn for Anthropic).
    const final = bodies.at(-1);
    expect(final.tools).toBeUndefined();
    const flat = JSON.stringify(final.messages);
    expect(flat).toContain(TOOL_BUDGET_EXHAUSTED_NOTE);
    // Tool-bearing turns before the cap must NOT carry the note.
    const withTools = bodies.filter(b => Array.isArray(b.tools) && b.tools.length > 0);
    for (const b of withTools) expect(JSON.stringify(b.messages)).not.toContain(TOOL_BUDGET_EXHAUSTED_NOTE);
  });

  it('never executes more than the budget when one provider turn requests a large batch', async () => {
    vi.stubGlobal('fetch', vi.fn((_u: string, init: any) => {
      const body = JSON.parse(init.body);
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      return Promise.resolve(okStream(hasTools ? multiToolTurn(MAX_TOOL_CALLS + 3) : TEXT_TURN));
    }));
    const executeTool = vi.fn(async (): Promise<ToolResult> => ({ content: 'ok', isError: false }));

    await streamChat({ settings, apiKey: 'k', system: 'S', history: [], text: 'go', onEvent: () => {}, executeTool });

    expect(executeTool).toHaveBeenCalledTimes(MAX_TOOL_CALLS);
  });

  it('stops immediately when the model answers with no tools', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(okStream(TEXT_TURN))));
    const events: AiChatEvent[] = [];
    const executeTool = vi.fn(async (): Promise<ToolResult> => ({ content: 'ok', isError: false }));
    await streamChat({ settings, apiKey: 'k', system: 'S', history: [], text: 'go', onEvent: e => events.push(e), executeTool });
    expect(executeTool).not.toHaveBeenCalled();
    expect(events.at(-1)).toEqual({ kind: 'done' });
  });

  it('suppresses identical backend calls while returning a result for every model request', async () => {
    vi.stubGlobal('fetch', vi.fn((_u: string, init: any) => {
      const body = JSON.parse(init.body);
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      return Promise.resolve(okStream(hasTools ? TOOL_TURN : TEXT_TURN));
    }));
    const events: AiChatEvent[] = [];
    const executeTool = vi.fn(async (): Promise<ToolResult> => ({ content: 'same result', isError: false }));

    await streamChat({ settings, apiKey: 'k', system: 'S', history: [], text: 'go', onEvent: e => events.push(e), executeTool });

    expect(executeTool).toHaveBeenCalledTimes(1);
    expect(events.filter(e => e.kind === 'tool-start')).toHaveLength(MAX_TOOL_ROUNDS);
    expect(events.filter(e => e.kind === 'tool-end')).toHaveLength(MAX_TOOL_ROUNDS);
    expect(events.at(-1)).toEqual({ kind: 'done' });
  });

  it('cancels mid-loop: aborting during a tool halts the loop with no done event', async () => {
    vi.stubGlobal('fetch', toolThenText());
    const controller = new AbortController();
    const events: AiChatEvent[] = [];
    let toolCount = 0;
    const executeTool = vi.fn(async (): Promise<ToolResult> => {
      toolCount++;
      controller.abort(); // cancel after the first tool runs
      return { content: 'ok', isError: false };
    });

    await streamChat({ settings, apiKey: 'k', system: 'S', history: [], text: 'go', onEvent: e => events.push(e), executeTool, signal: controller.signal });

    expect(toolCount).toBe(1);
    expect(events.some(e => e.kind === 'done')).toBe(false);
    expect(events.some(e => e.kind === 'error')).toBe(false);
  });

  it('surfaces a provider failure as an error event', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve('boom') })));
    const events: AiChatEvent[] = [];
    const executeTool = vi.fn(async (): Promise<ToolResult> => ({ content: 'ok', isError: false }));
    await streamChat({ settings, apiKey: 'k', system: 'S', history: [], text: 'go', onEvent: e => events.push(e), executeTool });
    expect(events.some(e => e.kind === 'error')).toBe(true);
    expect(events.some(e => e.kind === 'done')).toBe(false);
  });
});
