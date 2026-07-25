import { describe, it, expect, vi, afterEach } from 'vitest';
import { streamAnthropic } from '../anthropic';
import { streamOpenAiCompat, listModels } from '../openai-compat';

// ── Fake fetch Response helpers (avoid depending on the runtime's ReadableStream
//    / Response construction — readSse only uses response.body.getReader()). ──

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
function errBody(status: number, body: string): any {
  return { ok: false, status, text: () => Promise.resolve(body) };
}
function jsonOk(obj: unknown): any {
  return { ok: true, status: 200, json: () => Promise.resolve(obj) };
}

afterEach(() => { vi.restoreAllMocks(); });

describe('streamAnthropic', () => {
  it('shapes the request and streams text_delta frames', async () => {
    const calls: any[] = [];
    const fetchMock = vi.fn((url: string, init: any) => { calls.push({ url, init }); return Promise.resolve(okStream([
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hel"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"lo"}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ])); });
    vi.stubGlobal('fetch', fetchMock);

    const chunks: string[] = [];
    const { text } = await streamAnthropic({ model: 'claude-opus-4-8', apiKey: 'sk-a', system: 'SYS', user: 'USR', onChunk: d => chunks.push(d) });

    expect(text).toBe('Hello');
    expect(chunks).toEqual(['Hel', 'lo']);
    const { url, init } = calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.headers['x-api-key']).toBe('sk-a');
    expect(init.headers['anthropic-version']).toBe('2023-06-01');
    expect(init.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    const body = JSON.parse(init.body);
    expect(body.model).toBe('claude-opus-4-8');
    expect(body.max_tokens).toBe(8192);
    expect(body.stream).toBe(true);
    expect(body.temperature).toBeUndefined();
    expect(body.system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(body.system[0].text).toBe('SYS');
    expect(body.messages).toEqual([{ role: 'user', content: 'USR' }]);
  });

  it('rejects on an SSE error frame with the provider message', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(okStream([
      'event: error\ndata: {"error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
    ]))));
    await expect(streamAnthropic({ model: 'm', apiKey: 'k', system: '', user: 'u', onChunk: () => {} }))
      .rejects.toThrow('Overloaded');
  });

  it('rejects on a non-2xx with the body message', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(errBody(401, '{"error":{"message":"invalid key"}}'))));
    await expect(streamAnthropic({ model: 'm', apiKey: 'bad', system: '', user: 'u', onChunk: () => {} }))
      .rejects.toThrow(/401: invalid key/);
  });

  it('omits the system block when system is empty', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string, init: any) => { calls.push(init); return Promise.resolve(okStream(['event: message_stop\ndata: {}\n\n'])); }));
    await streamAnthropic({ model: 'm', apiKey: 'k', system: '', user: 'u', onChunk: () => {} });
    expect(JSON.parse(calls[0].body).system).toBeUndefined();
  });
});

describe('streamOpenAiCompat', () => {
  it('shapes the request and streams delta.content, terminating on [DONE]', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string, init: any) => { calls.push({ url, init }); return Promise.resolve(okStream([
      'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
      'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
      'data: [DONE]\n\n',
    ])); }));

    const chunks: string[] = [];
    const { text } = await streamOpenAiCompat({
      baseUrl: 'https://api.deepseek.com/v1',
      model: 'deepseek-chat',
      maxTokens: 4096,
      maxTokensParam: 'max_tokens',
      apiKey: 'sk-d',
      system: 'S',
      user: 'U',
      onChunk: d => chunks.push(d),
    });

    expect(text).toBe('Hello');
    expect(chunks).toEqual(['Hel', 'lo']);
    const { url, init } = calls[0];
    expect(url).toBe('https://api.deepseek.com/v1/chat/completions');
    expect(init.headers['Authorization']).toBe('Bearer sk-d');
    const body = JSON.parse(init.body);
    expect(body.stream).toBe(true);
    expect(body.model).toBe('deepseek-chat');
    expect(body.max_tokens).toBe(4096);
    expect(body.messages).toEqual([{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }]);
  });

  it('handles SSE payloads split across stream chunks', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(okStream([
      'data: {"choices":[{"delta":{"con',
      'tent":"AB"}}]}\n\ndata: [DONE]\n\n',
    ]))));
    const chunks: string[] = [];
    const { text } = await streamOpenAiCompat({ baseUrl: 'https://api.openai.com/v1', model: 'gpt-5.2', apiKey: 'k', system: '', user: 'u', onChunk: d => chunks.push(d) });
    expect(text).toBe('AB');
    expect(chunks).toEqual(['AB']);
  });

  it('defaults configured OpenAI-format limits to max_completion_tokens', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string, init: any) => {
      calls.push(init);
      return Promise.resolve(okStream(['data: [DONE]\n\n']));
    }));
    await streamOpenAiCompat({
      baseUrl: 'https://api.example.test/v1',
      model: 'reasoning-model',
      maxTokens: 2048,
      apiKey: 'k',
      system: '',
      user: 'u',
      onChunk: () => {},
    });
    const body = JSON.parse(calls[0].body);
    expect(body.max_completion_tokens).toBe(2048);
    expect(body.max_tokens).toBeUndefined();
  });

  it('drops the system message when empty', async () => {
    const calls: any[] = [];
    vi.stubGlobal('fetch', vi.fn((url: string, init: any) => { calls.push(init); return Promise.resolve(okStream(['data: [DONE]\n\n'])); }));
    await streamOpenAiCompat({ baseUrl: 'https://api.x.ai/v1', model: 'grok-4', apiKey: 'k', system: '', user: 'u', onChunk: () => {} });
    expect(JSON.parse(calls[0].body).messages).toEqual([{ role: 'user', content: 'u' }]);
    expect(JSON.parse(calls[0].body).max_tokens).toBeUndefined();
  });

  it('rejects on a non-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(errBody(429, '{"error":{"message":"rate limit"}}'))));
    await expect(streamOpenAiCompat({ baseUrl: 'https://api.openai.com/v1', model: 'm', apiKey: 'k', system: '', user: 'u', onChunk: () => {} }))
      .rejects.toThrow(/429: rate limit/);
  });
});

describe('listModels', () => {
  it('returns sorted model ids', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonOk({ data: [{ id: 'gpt-b' }, { id: 'gpt-a' }] }))));
    expect(await listModels('https://api.openai.com/v1', 'k')).toEqual(['gpt-a', 'gpt-b']);
  });
});
