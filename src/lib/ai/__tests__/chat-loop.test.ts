import { describe, it, expect, vi, afterEach } from 'vitest';
import { streamChat } from '../client';
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
const TEXT_TURN = [
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Final"}}\n\n',
  'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
];

const settings: AiSettings = { provider: 'anthropic', model: 'claude-opus-4-8', apiKeyEnc: '' };

/** fetch mock: tool_use whenever tools are offered, text otherwise. */
function toolThenText() {
  return vi.fn((_u: string, init: any) => {
    const body = JSON.parse(init.body);
    const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
    return Promise.resolve(okStream(hasTools ? TOOL_TURN : TEXT_TURN));
  });
}

afterEach(() => { vi.restoreAllMocks(); });

describe('streamChat tool loop', () => {
  it('caps tool calls at 8, then forces a tools-off final answer', async () => {
    vi.stubGlobal('fetch', toolThenText());
    const events: AiChatEvent[] = [];
    let toolCount = 0;
    const executeTool = vi.fn(async (): Promise<ToolResult> => { toolCount++; return { content: 'ok', isError: false }; });

    await streamChat({ settings, apiKey: 'k', system: 'S', history: [], text: 'go', onEvent: e => events.push(e), executeTool });

    expect(toolCount).toBe(8);
    expect(events.filter(e => e.kind === 'tool-start')).toHaveLength(8);
    expect(events.filter(e => e.kind === 'tool-end')).toHaveLength(8);
    expect(events.at(-1)).toEqual({ kind: 'done' });
    // The forced final turn streamed text.
    expect(events.some(e => e.kind === 'text-delta' && e.delta === 'Final')).toBe(true);
  });

  it('stops immediately when the model answers with no tools', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(okStream(TEXT_TURN))));
    const events: AiChatEvent[] = [];
    const executeTool = vi.fn(async (): Promise<ToolResult> => ({ content: 'ok', isError: false }));
    await streamChat({ settings, apiKey: 'k', system: 'S', history: [], text: 'go', onEvent: e => events.push(e), executeTool });
    expect(executeTool).not.toHaveBeenCalled();
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
