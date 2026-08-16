/**
 * Tests for handlers/ai.ts — the AI config CRUD + the streaming completion's
 * cancel path. The provider dialects, prompt building, and SSE parsing have
 * their own suites; here we only assert the handler wiring: config read/write,
 * and that AI_CANCEL aborts the in-flight request's AbortController.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { InspectorMessage } from '../types';

let recordedSignal: AbortSignal | null = null;
const sentBroadcasts: InspectorMessage[] = [];
const { streamChatMock } = vi.hoisted(() => ({ streamChatMock: vi.fn() }));

vi.mock('../ai/client', () => ({
  streamCompletion: (opts: any) => {
    recordedSignal = opts.signal;
    // Hang until aborted (mimics a long stream).
    return new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  },
  streamChat: streamChatMock,
  testConnection: vi.fn(() => Promise.resolve({ ok: true })),
  listModels: vi.fn(() => Promise.resolve(['a', 'b'])),
}));

vi.mock('../crypto', () => ({
  encrypt: (s: string) => Promise.resolve(`enc:${s}`),
  decrypt: (s: string) => Promise.resolve(s.replace(/^enc:/, '')),
}));

vi.mock('../settings', () => ({
  saveSettings: () => Promise.resolve(),
  snapshotSettings: () => {},
}));

vi.mock('../messaging', () => ({
  sendFireForget: (m: InspectorMessage) => { sentBroadcasts.push(m); },
}));

function makeCtx() {
  return {
    settings: { schemaVersion: 3, profiles: [], activeProfileId: '', autoDetect: true, saveTarget: 'template', enrichMode: 'widgets', ai: undefined as any },
    logActivity: vi.fn(),
  };
}

describe('handlers/ai', () => {
  let getHandler: (t: string) => any;
  let ctx: ReturnType<typeof makeCtx>;

  beforeEach(async () => {
    vi.resetModules();
    streamChatMock.mockReset();
    recordedSignal = null;
    sentBroadcasts.length = 0;
    const swctx = await import('../sw-context');
    ctx = makeCtx();
    swctx.setSwContext(ctx as any);
    await import('../handlers/ai');
    ({ getHandler } = await import('../handler-registry'));
  });

  const call = (msg: InspectorMessage) => {
    const responses: InspectorMessage[] = [];
    const p = getHandler(msg.type)(msg, (r: InspectorMessage) => responses.push(r), { isOneShot: true });
    return { responses, done: Promise.resolve(p) };
  };

  it('AI_GET_CONFIG reports not-configured before a key is saved', async () => {
    const { responses, done } = call({ type: 'AI_GET_CONFIG' });
    await done;
    expect(responses[0]).toEqual({ type: 'AI_CONFIG_DATA', configured: false, provider: undefined, model: undefined });
  });

  it('AI_SAVE_CONFIG encrypts the key and stores provider + model', async () => {
    const { responses, done } = call({ type: 'AI_SAVE_CONFIG', provider: 'anthropic', model: 'claude-opus-4-8', apiKey: 'sk-1' });
    await done;
    expect(ctx.settings.ai).toEqual({ provider: 'anthropic', model: 'claude-opus-4-8', apiKeyEnc: 'enc:sk-1' });
    expect(responses[0]).toMatchObject({ type: 'AI_CONFIG_SAVED', ok: true, configured: true, provider: 'anthropic', model: 'claude-opus-4-8' });
    // Open editor / studio surfaces are notified live via a broadcast.
    expect(sentBroadcasts).toContainEqual({ type: 'AI_CONFIG_CHANGED', configured: true, provider: 'anthropic', model: 'claude-opus-4-8' });
  });

  it('AI_SAVE_CONFIG keeps the existing key when only provider/model change', async () => {
    ctx.settings.ai = { provider: 'anthropic', model: 'old', apiKeyEnc: 'enc:keep' };
    const { done } = call({ type: 'AI_SAVE_CONFIG', provider: 'anthropic', model: 'claude-sonnet-5' });
    await done;
    expect(ctx.settings.ai).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5', apiKeyEnc: 'enc:keep' });
  });

  it('AI_SAVE_CUSTOM_PROVIDER encrypts the imported key and stores only sanitized metadata', async () => {
    const json = JSON.stringify({
      name: 'Gateway', vendor: 'gateway', apiKey: 'plain-secret', apiType: 'openai',
      models: [
        { id: 'no-tools', name: 'No tools', url: 'https://gateway.test/v1', toolCalling: false },
        { id: 'agent', name: 'Agent', url: 'https://gateway.test/v1', toolCalling: true, maxOutputTokens: 8000 },
      ],
    });
    const { responses, done } = call({ type: 'AI_SAVE_CUSTOM_PROVIDER', json });
    await done;
    expect(ctx.settings.ai).toMatchObject({ provider: 'custom', model: 'agent', apiKeyEnc: 'enc:plain-secret' });
    expect(ctx.settings.ai.customProvider).toMatchObject({ name: 'Gateway', vendor: 'gateway', apiType: 'openai' });
    expect(JSON.stringify(ctx.settings.ai.customProvider)).not.toContain('plain-secret');
    expect(responses[0]).toMatchObject({ type: 'AI_CONFIG_SAVED', ok: true, provider: 'custom', model: 'agent' });
    expect(sentBroadcasts).toContainEqual(expect.objectContaining({ type: 'AI_CONFIG_CHANGED', provider: 'custom', model: 'agent' }));
  });

  it('AI_REMOVE_CONFIG clears the config', async () => {
    ctx.settings.ai = { provider: 'openai', model: 'gpt-5.2', apiKeyEnc: 'enc:x' };
    const { responses, done } = call({ type: 'AI_REMOVE_CONFIG' });
    await done;
    expect(ctx.settings.ai).toBeUndefined();
    expect(responses[0]).toEqual({ type: 'AI_CONFIG_SAVED', ok: true, configured: false });
    // Removal is broadcast too, so surfaces hide the assistant live.
    expect(sentBroadcasts).toContainEqual({ type: 'AI_CONFIG_CHANGED', configured: false });
  });

  it('AI_CANCEL aborts the in-flight request and suppresses the error broadcast', async () => {
    ctx.settings.ai = { provider: 'anthropic', model: 'm', apiKeyEnc: 'enc:k' };
    const payload = { requestId: 'req-1', intent: 'ask' as const, lang: 'extended' as const, code: 'x', selection: null, instruction: 'go', context: {} };
    getHandler('AI_REQUEST')({ type: 'AI_REQUEST', payload }, () => {}, { isOneShot: true });
    // Let the handler reach streamCompletion (through the mocked decrypt await).
    await new Promise(r => setTimeout(r, 0));
    expect(recordedSignal).not.toBeNull();
    expect(recordedSignal!.aborted).toBe(false);

    getHandler('AI_CANCEL')({ type: 'AI_CANCEL', requestId: 'req-1' }, () => {}, { isOneShot: true });
    await new Promise(r => setTimeout(r, 0));

    expect(recordedSignal!.aborted).toBe(true);
    // No AI_ERROR after a user cancel.
    expect(sentBroadcasts.some(m => m.type === 'AI_ERROR')).toBe(false);
    expect(sentBroadcasts.some(m => m.type === 'AI_DONE')).toBe(false);
  });

  it('records provider usage and elapsed timing from an AI chat turn', async () => {
    ctx.settings.ai = { provider: 'openai', model: 'gpt-5.2', apiKeyEnc: 'enc:k' };
    streamChatMock.mockResolvedValue({
      durationMs: 260, providerRequests: 2, providerDurationMs: 175,
      inputTokens: 800, cachedInputTokens: 240, cacheWriteTokens: 0,
      outputTokens: 120, reasoningTokens: 30,
      modelRetries: 1, emptyResponseRetries: 0, previewRepairRetries: 1,
      toolRounds: 0, toolCallsRequested: 2, toolCallsExecuted: 2, automaticToolCalls: 2,
      previewDurationMs: 85, modelToolDurationMs: 0, duplicateCalls: 0, toolErrors: 0,
      budgetExhausted: false, tools: [],
    });
    const message = {
      type: 'AI_CHAT_SEND', requestId: 'chat-metrics', text: 'Change this object.', history: [],
      envelope: { v: 1, server: { id: 'server', url: 'https://bmp.test/' }, sources: [] },
    } as any;

    await getHandler('AI_CHAT_SEND')(message, () => {}, { isOneShot: true });

    expect(streamChatMock).toHaveBeenCalledOnce();
    expect(ctx.logActivity).toHaveBeenCalledWith(
      'info', 'AI chat (gpt-5.2)',
      expect.stringContaining('"inputTokens":800'),
      expect.objectContaining({ category: 'system', action: 'ai-eval-trace', durationMs: 260 }),
    );
  });

  it('aborts an AI chat exactly at the 45-second deadline and forwards the timeout event', async () => {
    vi.useFakeTimers();
    try {
      ctx.settings.ai = { provider: 'openai', model: 'gpt-5.2', apiKeyEnc: 'enc:k' };
      let signal: AbortSignal | undefined;
      streamChatMock.mockImplementation(({ signal: requestSignal, onEvent }: any) => new Promise(resolve => {
        signal = requestSignal;
        requestSignal.addEventListener('abort', () => {
          onEvent({ kind: 'error', message: (requestSignal.reason as Error).message });
          resolve(null);
        });
      }));
      const message = {
        type: 'AI_CHAT_SEND', requestId: 'chat-timeout', text: 'Explain this setting.', history: [],
        envelope: { v: 1, server: { id: 'server', url: 'https://bmp.test/' }, sources: [] },
      } as any;

      const done = getHandler('AI_CHAT_SEND')(message, () => {}, { isOneShot: true });
      await vi.advanceTimersByTimeAsync(44_999);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await done;

      expect(signal?.aborted).toBe(true);
      expect(sentBroadcasts).toContainEqual({
        type: 'AI_CHAT_EVENT', requestId: 'chat-timeout',
        event: { kind: 'error', message: 'The AI request exceeded 45 seconds and was stopped. Nothing was executed.' },
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
