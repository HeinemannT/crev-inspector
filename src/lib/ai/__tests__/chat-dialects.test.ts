import { describe, it, expect, vi, afterEach } from 'vitest';
import { streamAnthropicTurn } from '../anthropic';
import { streamOpenAiTurn } from '../openai-compat';

function streamBody(parts: string[]) {
  let i = 0;
  const enc = new TextEncoder();
  return {
    getReader() {
      return {
        read: () => Promise.resolve(
          i < parts.length ? { value: enc.encode(parts[i++]), done: false } : { value: undefined, done: true },
        ),
      };
    },
  };
}
function okStream(parts: string[]): any {
  return { ok: true, status: 200, body: streamBody(parts) };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('streamAnthropicTurn — tool_use accumulation', () => {
  it('accumulates input_json_delta chunks into one parsed tool call', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(okStream([
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"read_type"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"type\\":"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"ButtonInput\\"}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ]))));

    const turn = await streamAnthropicTurn({
      model: 'claude-opus-4-8', apiKey: 'k', system: 'S', messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'read_type', description: 'd', input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false } }],
      onText: () => {},
    });

    expect(turn.stopReason).toBe('tool_use');
    expect(turn.toolCalls).toEqual([{ id: 'toolu_1', name: 'read_type', input: { type: 'ButtonInput' } }]);
    // The assistant content echoes the tool_use block for the reply turn.
    expect(turn.content).toEqual([{ type: 'tool_use', id: 'toolu_1', name: 'read_type', input: { type: 'ButtonInput' } }]);
  });

  it('streams interleaved text and returns it, no tool calls on end_turn', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(okStream([
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n',
    ]))));
    const chunks: string[] = [];
    const turn = await streamAnthropicTurn({ model: 'm', apiKey: 'k', system: '', messages: [], onText: d => chunks.push(d) });
    expect(chunks).toEqual(['Hi']);
    expect(turn.text).toBe('Hi');
    expect(turn.toolCalls).toEqual([]);
    expect(turn.stopReason).toBe('end_turn');
  });

  it('omits the tools param when none are offered (forced final answer)', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', vi.fn((_u: string, init: any) => { calls.push(init); return Promise.resolve(okStream(['event: message_stop\ndata: {}\n\n'])); }));
    await streamAnthropicTurn({ model: 'm', apiKey: 'k', system: '', messages: [], tools: [], onText: () => {} });
    expect(JSON.parse(calls[0].body).tools).toBeUndefined();
  });
});

describe('streamOpenAiTurn — delta.tool_calls accumulation', () => {
  it('accumulates streamed tool_calls by index into a parsed call', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(okStream([
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_type","arguments":"{\\"ty"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"pe\\":\\"ButtonInput\\"}"}}]}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ]))));

    const turn = await streamOpenAiTurn({
      baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.2', apiKey: 'k',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'read_type', description: 'd', parameters: { type: 'object', properties: {}, required: [], additionalProperties: false } } }],
      onText: () => {},
    });

    expect(turn.finishReason).toBe('tool_calls');
    expect(turn.toolCalls).toEqual([{ id: 'call_1', name: 'read_type', input: { type: 'ButtonInput' } }]);
    expect(turn.assistantMessage).toEqual({
      role: 'assistant', content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_type', arguments: '{"type":"ButtonInput"}' } }],
    });
  });

  it('returns a plain assistant text message when no tools are called', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(okStream([
      'data: {"choices":[{"delta":{"content":"Done"}}]}\n\n',
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]))));
    const turn = await streamOpenAiTurn({ baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'k', messages: [], onText: () => {} });
    expect(turn.text).toBe('Done');
    expect(turn.toolCalls).toEqual([]);
    expect(turn.assistantMessage).toEqual({ role: 'assistant', content: 'Done' });
  });
});
