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
      'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-opus-4-8-20260801","usage":{"input_tokens":12}}}\n\n',
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
    expect(turn.resolvedModel).toBe('claude-opus-4-8-20260801');
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

  it('places cache breakpoints on the last tool, the system block, and the last message (<= 4 total)', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', vi.fn((_u: string, init: any) => { calls.push(init); return Promise.resolve(okStream(['event: message_stop\ndata: {}\n\n'])); }));

    const tools = [
      { name: 'read_object', description: 'a', input_schema: { type: 'object' as const, properties: {}, required: [], additionalProperties: false as const } },
      { name: 'preview_ec', description: 'b', input_schema: { type: 'object' as const, properties: {}, required: [], additionalProperties: false as const } },
    ];
    await streamAnthropicTurn({
      model: 'claude-opus-4-8', apiKey: 'k', system: 'PERSONA + KNOWLEDGE',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'read_object', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'result' }] },
      ],
      tools,
      onText: () => {},
    });

    const body = JSON.parse(calls[0].body);
    const bp = { type: 'ephemeral' };

    // 1. LAST tool def carries the breakpoint; earlier ones do not.
    expect(body.tools[body.tools.length - 1].cache_control).toEqual(bp);
    expect(body.tools[0].cache_control).toBeUndefined();

    // 2. The single system block carries a breakpoint.
    expect(body.system[0].cache_control).toEqual(bp);

    // 3. The last block of the LAST message carries the turn-boundary breakpoint;
    //    earlier messages do not.
    const lastMsg = body.messages[body.messages.length - 1];
    expect(lastMsg.content[lastMsg.content.length - 1].cache_control).toEqual(bp);
    expect(JSON.stringify(body.messages[0])).not.toContain('cache_control');
    expect(JSON.stringify(body.messages[1])).not.toContain('cache_control');

    // Anthropic caps a request at 4 breakpoints; we use exactly 3.
    const total = (calls[0].body.match(/"cache_control"/g) ?? []).length;
    expect(total).toBe(3);
    expect(total).toBeLessThanOrEqual(4);
  });

  it('serializes the tool block byte-stable across calls (cache-safe)', async () => {
    const bodies: string[] = [];
    vi.stubGlobal('fetch', vi.fn((_u: string, init: any) => { bodies.push(init.body); return Promise.resolve(okStream(['event: message_stop\ndata: {}\n\n'])); }));
    const tools = [
      { name: 'read_object', description: 'a', input_schema: { type: 'object' as const, properties: {}, required: [], additionalProperties: false as const } },
      { name: 'preview_ec', description: 'b', input_schema: { type: 'object' as const, properties: {}, required: [], additionalProperties: false as const } },
    ];
    for (let i = 0; i < 2; i++) {
      await streamAnthropicTurn({ model: 'm', apiKey: 'k', system: 'S', messages: [{ role: 'user', content: `turn ${i}` }], tools, onText: () => {} });
    }
    expect(JSON.stringify(JSON.parse(bodies[0]).tools)).toBe(JSON.stringify(JSON.parse(bodies[1]).tools));
  });
});

describe('streamOpenAiTurn — delta.tool_calls accumulation', () => {
  it('accumulates streamed tool_calls by index into a parsed call', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(okStream([
      'data: {"model":"z-ai/glm-5.2","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_type","arguments":"{\\"ty"}}]}}]}\n\n',
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
    expect(turn.resolvedModel).toBe('z-ai/glm-5.2');
    expect(turn.toolCalls).toEqual([{ id: 'call_1', name: 'read_type', input: { type: 'ButtonInput' } }]);
    expect(turn.assistantMessage).toEqual({
      role: 'assistant', content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_type', arguments: '{"type":"ButtonInput"}' } }],
    });
  });

  it('keeps a byte-stable message prefix across two consecutive turns', async () => {
    // OpenAI-compat caching is automatic on a stable prefix — nothing before the
    // new turn may vary. Turn 2 = turn 1's messages + the assistant reply + a
    // fresh user turn; the shared prefix must serialize identically.
    const bodies: string[] = [];
    vi.stubGlobal('fetch', vi.fn((_u: string, init: any) => {
      bodies.push(init.body);
      return Promise.resolve(okStream([
        'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n',
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        'data: [DONE]\n\n',
      ]));
    }));

    const base: any[] = [
      { role: 'system', content: 'PERSONA + KNOWLEDGE PREFIX' },
      { role: 'user', content: 'first question' },
    ];
    await streamOpenAiTurn({ baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'k', messages: base, onText: () => {} });
    const next = [...base, { role: 'assistant', content: 'ok' }, { role: 'user', content: 'second question' }];
    await streamOpenAiTurn({ baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'k', messages: next, onText: () => {} });

    const m1 = JSON.parse(bodies[0]).messages;
    const m2 = JSON.parse(bodies[1]).messages;
    // The system block and every shared history entry are byte-identical.
    for (let i = 0; i < m1.length; i++) {
      expect(JSON.stringify(m2[i])).toBe(JSON.stringify(m1[i]));
    }
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
