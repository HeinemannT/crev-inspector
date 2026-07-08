/**
 * Message router dispatch — a throwing/rejecting handler must never leave
 * a request hanging or emit an unhandled rejection.
 *
 * handleContentMessage and handleOneShotMessage both invoke handlers
 * without awaiting them directly (the handler runs after settingsReady
 * resolves). Both paths must catch a rejection and log it; the one-shot
 * path additionally must guarantee a sendResponse call so the caller's
 * chrome.runtime.sendMessage promise resolves instead of hanging forever.
 *
 * handlePanelMessage already awaits its handler directly and is out of
 * scope for this suite (see plan 004).
 */
import { describe, it, expect, vi } from 'vitest';
import { mockChromeStorage } from './chrome-mock';
import type { InspectorMessage } from '../types';

/** Fresh module graph per test: resets the handler registry (module-level
 *  Map in handler-registry.ts) and re-establishes a minimal chrome mock
 *  before message-router.ts (and the handler files it imports for their
 *  registration side effects) is loaded. Mirrors the pattern used by
 *  per-window-inspect.test.ts. */
async function harness() {
  vi.resetModules();
  mockChromeStorage();

  const registryMod = await import('../handler-registry');
  const swCtxMod = await import('../sw-context');
  const routerMod = await import('../message-router');
  const loggerMod = await import('../logger');

  const ctx: any = {
    settingsReady: Promise.resolve(),
    sendToPanel: vi.fn(),
  };
  swCtxMod.setSwContext(ctx);

  return {
    register: registryMod.register,
    handleContentMessage: routerMod.handleContentMessage,
    handleOneShotMessage: routerMod.handleOneShotMessage,
    log: loggerMod.log,
    ctx,
  };
}

/** Flush both the microtask queue and one macrotask tick — enough for a
 *  chained .then().catch() (or a settingsReady.then() gate) to settle. */
function flush() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

describe('message-router — handleContentMessage', () => {
  it('swallows a handler rejection instead of producing an unhandled rejection', async () => {
    const h = await harness();
    const swallowSpy = vi.spyOn(h.log, 'swallow');
    h.register('TEST_CONTENT_REJECT', async () => {
      throw new Error('content handler boom');
    });

    // Must not throw synchronously, and must not reject the returned promise.
    await expect(
      h.handleContentMessage({ type: 'TEST_CONTENT_REJECT' } as unknown as InspectorMessage, 1),
    ).resolves.toBeUndefined();

    await flush();
    expect(swallowSpy).toHaveBeenCalledWith('router:content:TEST_CONTENT_REJECT', expect.any(Error));
  });

  it('does not call log.swallow when the handler resolves normally', async () => {
    const h = await harness();
    const swallowSpy = vi.spyOn(h.log, 'swallow');
    const handler = vi.fn(async () => {});
    h.register('TEST_CONTENT_OK', handler);

    await h.handleContentMessage({ type: 'TEST_CONTENT_OK' } as unknown as InspectorMessage, 1);
    await flush();

    expect(handler).toHaveBeenCalled();
    expect(swallowSpy).not.toHaveBeenCalled();
  });
});

describe('message-router — handleOneShotMessage', () => {
  it('always calls sendResponse with a TOAST error when the handler throws before responding', async () => {
    const h = await harness();
    const swallowSpy = vi.spyOn(h.log, 'swallow');
    h.register('TEST_ONESHOT_THROW', () => {
      throw new Error('oneshot boom');
    });
    const sendResponse = vi.fn();

    const kept = h.handleOneShotMessage(
      { type: 'TEST_ONESHOT_THROW' } as unknown as InspectorMessage,
      {} as chrome.runtime.MessageSender,
      sendResponse,
    );
    expect(kept).toBe(true);

    await flush();

    expect(sendResponse).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith({ type: 'TOAST', kind: 'error', text: 'oneshot boom' });
    expect(swallowSpy).toHaveBeenCalledWith('router:oneshot:TEST_ONESHOT_THROW', expect.any(Error));
  });

  it('happy path: handler responds normally and the fallback never fires', async () => {
    const h = await harness();
    const swallowSpy = vi.spyOn(h.log, 'swallow');
    h.register('TEST_ONESHOT_OK', (_msg, respond) => {
      respond({ type: 'TEST_ONESHOT_OK_RESULT', ok: true } as unknown as InspectorMessage);
    });
    const sendResponse = vi.fn();

    const kept = h.handleOneShotMessage(
      { type: 'TEST_ONESHOT_OK' } as unknown as InspectorMessage,
      {} as chrome.runtime.MessageSender,
      sendResponse,
    );
    expect(kept).toBe(true);

    await flush();

    expect(sendResponse).toHaveBeenCalledTimes(1);
    expect(sendResponse).toHaveBeenCalledWith({ type: 'TEST_ONESHOT_OK_RESULT', ok: true });
    expect(swallowSpy).not.toHaveBeenCalled();
  });

  it('returns false and never touches sendResponse for an unregistered type', async () => {
    const h = await harness();
    const sendResponse = vi.fn();

    const kept = h.handleOneShotMessage(
      { type: 'TEST_ONESHOT_UNKNOWN' } as unknown as InspectorMessage,
      {} as chrome.runtime.MessageSender,
      sendResponse,
    );

    expect(kept).toBe(false);
    await flush();
    expect(sendResponse).not.toHaveBeenCalled();
  });
});
