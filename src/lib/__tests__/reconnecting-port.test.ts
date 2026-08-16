/**
 * @vitest-environment happy-dom
 *
 * Tests for src/lib/reconnecting-port.ts — focused on destroy(), added so the
 * content-script re-injection teardown can stop a stale instance's port from
 * reconnecting (and re-receiving INSPECT_STATE) alongside the fresh one.
 *
 * Coverage:
 * - destroy() disconnects the live port and detaches pagehide/pageshow
 * - after destroy() a disconnect does NOT schedule a reconnect
 * - after destroy() send() no-ops (returns false, doesn't post)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createReconnectingPort } from '../reconnecting-port';

interface FakePort {
  postMessage: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  onMessage: { addListener: (cb: (m: unknown) => void) => void };
  onDisconnect: { addListener: (cb: () => void) => void };
  _disconnect: () => void;
}

function makePort(): FakePort {
  let disconnectCb: (() => void) | null = null;
  return {
    postMessage: vi.fn(),
    disconnect: vi.fn(),
    onMessage: { addListener: vi.fn() },
    onDisconnect: { addListener: (cb: () => void) => { disconnectCb = cb; } },
    _disconnect: () => disconnectCb?.(),
  };
}

describe('reconnecting-port destroy()', () => {
  let ports: FakePort[];
  let connect: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    ports = [];
    connect = vi.fn(() => { const p = makePort(); ports.push(p); return p; });
    (globalThis as any).chrome = { runtime: { connect, lastError: null } };
  });

  afterEach(() => {
    vi.useRealTimers();
    delete (globalThis as any).chrome;
  });

  it('disconnects the live port on destroy()', () => {
    const rp = createReconnectingPort({ name: 'content', onMessage: () => {} });
    expect(ports).toHaveLength(1);
    rp.destroy();
    expect(ports[0].disconnect).toHaveBeenCalledTimes(1);
  });

  it('does not reconnect after destroy() even if the port disconnects', () => {
    const rp = createReconnectingPort({ name: 'content', onMessage: () => {} });
    rp.destroy();
    // A late onDisconnect from the (already disconnected) port must not
    // schedule a reconnect — the destroyed guard short-circuits it.
    ports[0]._disconnect();
    vi.advanceTimersByTime(60_000);
    expect(connect).toHaveBeenCalledTimes(1); // only the initial connect
  });

  it('send() no-ops after destroy()', () => {
    const rp = createReconnectingPort({ name: 'content', onMessage: () => {} });
    rp.destroy();
    expect(rp.send({ type: 'TOGGLE_INSPECT' } as never)).toBe(false);
    expect(ports[0].postMessage).not.toHaveBeenCalled();
  });

  it('detaches pagehide/pageshow on destroy() (no reconnect on bfcache restore)', () => {
    const rp = createReconnectingPort({ name: 'content', onMessage: () => {} });
    rp.destroy();
    // pageshow with persisted:true would normally kick a reconnect; after
    // destroy the listener is gone, so connect count stays at 1.
    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it('stops retrying when the extension context has been invalidated', () => {
    connect.mockImplementation(() => { throw new Error('Extension context invalidated.'); });
    const rp = createReconnectingPort({ name: 'content', onMessage: () => {} });
    vi.advanceTimersByTime(60_000);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(rp.send({ type: 'TOGGLE_INSPECT' } as never)).toBe(false);
  });

  it('stops retrying when a live port disconnects after extension-context invalidation', () => {
    const rp = createReconnectingPort({ name: 'content', onMessage: () => {} });
    (globalThis as any).chrome.runtime.lastError = { message: 'Extension context invalidated.' };

    ports[0]._disconnect();
    vi.advanceTimersByTime(60_000);

    expect(connect).toHaveBeenCalledTimes(1);
    expect(rp.send({ type: 'TOGGLE_INSPECT' } as never)).toBe(false);
  });
});
