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

vi.mock('../ai/client', () => ({
  streamCompletion: (opts: any) => {
    recordedSignal = opts.signal;
    // Hang until aborted (mimics a long stream).
    return new Promise((_resolve, reject) => {
      opts.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  },
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
});
