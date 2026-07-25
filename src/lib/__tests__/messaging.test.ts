import { afterEach, describe, expect, it, vi } from 'vitest';
import { RuntimeRequestError, sendRequestBounded } from '../messaging';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function runtime(sendMessage: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('chrome', { runtime: { sendMessage } });
}

describe('sendRequestBounded', () => {
  it('returns a response and clears its deadline', async () => {
    vi.useFakeTimers();
    const clear = vi.spyOn(globalThis, 'clearTimeout');
    runtime(vi.fn().mockResolvedValue({ type: 'SAVE_RESULT', ok: true }));
    await expect(sendRequestBounded({ type: 'GET_CONNECTION_STATE' }, { timeoutMs: 100 }))
      .resolves.toMatchObject({ type: 'SAVE_RESULT' });
    expect(clear).toHaveBeenCalled();
  });

  it('distinguishes timeout, cancellation, and runtime-channel rejection', async () => {
    vi.useFakeTimers();
    runtime(vi.fn(() => new Promise(() => {})));
    const timedOut = sendRequestBounded({ type: 'GET_CONNECTION_STATE' }, { timeoutMs: 100 });
    const timeoutAssertion = expect(timedOut).rejects.toMatchObject({ kind: 'timeout' });
    await vi.advanceTimersByTimeAsync(100);
    await timeoutAssertion;

    const controller = new AbortController();
    const cancelled = sendRequestBounded(
      { type: 'GET_CONNECTION_STATE' },
      { timeoutMs: 100, signal: controller.signal },
    );
    controller.abort();
    await expect(cancelled).rejects.toMatchObject({ kind: 'cancelled' });

    runtime(vi.fn().mockRejectedValue(new Error('Receiving end does not exist')));
    await expect(sendRequestBounded({ type: 'GET_CONNECTION_STATE' }, { timeoutMs: 100 }))
      .rejects.toEqual(expect.objectContaining<Partial<RuntimeRequestError>>({ kind: 'runtime' }));
  });
});
