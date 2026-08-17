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
import { createReconnectingPort as createRawReconnectingPort, type ReconnectingPort } from '../reconnecting-port';

let createdPorts: ReconnectingPort[] = [];
function createReconnectingPort(opts: Parameters<typeof createRawReconnectingPort>[0]): ReconnectingPort {
  const result = createRawReconnectingPort(opts);
  createdPorts.push(result);
  return result;
}

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
    createdPorts = [];
    ports = [];
    connect = vi.fn(() => { const p = makePort(); ports.push(p); return p; });
    (globalThis as any).chrome = { runtime: { connect, lastError: null } };
  });

  afterEach(() => {
    for (const port of createdPorts) port.destroy();
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

  it('reports reconnect only after a thrown construction is followed by a ready attempt', () => {
    const onReconnect = vi.fn();
    connect.mockImplementationOnce(() => { throw new Error('worker waking'); });
    createReconnectingPort({ name: 'content', onMessage: () => {}, onReconnect });
    expect(onReconnect).not.toHaveBeenCalled();

    vi.advanceTimersByTime(200);

    expect(connect).toHaveBeenCalledTimes(2);
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it('ignores a stale disconnect callback from an older attempt', () => {
    createReconnectingPort({ name: 'content', onMessage: () => {} });
    ports[0]._disconnect();
    vi.advanceTimersByTime(200);
    expect(connect).toHaveBeenCalledTimes(2);

    ports[0]._disconnect();
    vi.advanceTimersByTime(60_000);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('schedules one retry when send fails and flushes the idempotent queue', () => {
    const onReconnect = vi.fn();
    const rp = createReconnectingPort({
      name: 'content', onMessage: () => {}, onReconnect,
      enqueueOnDisconnect: (queue, msg) => queue.push(msg),
    });
    ports[0].postMessage.mockImplementationOnce(() => { throw new Error('port closed'); });
    const msg = { type: 'GET_CONNECTION_STATE' } as never;

    expect(rp.send(msg)).toBe(false);
    vi.advanceTimersByTime(200);

    expect(connect).toHaveBeenCalledTimes(2);
    expect(ports[1].postMessage).toHaveBeenCalledWith(msg);
    expect(onReconnect).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it('does not report readiness for an immediately disconnected attempt', () => {
    const onReconnect = vi.fn();
    connect.mockImplementationOnce(() => {
      const p = makePort();
      p.onDisconnect.addListener = (cb) => cb();
      ports.push(p);
      return p;
    });
    createReconnectingPort({ name: 'content', onMessage: () => {}, onReconnect });
    expect(onReconnect).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(onReconnect).toHaveBeenCalledTimes(1);
  });

  it('reconnects exactly once on persisted BFCache restore', () => {
    const onReconnect = vi.fn();
    createReconnectingPort({ name: 'content', onMessage: () => {}, onReconnect });
    window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: true }));
    expect(connect).toHaveBeenCalledTimes(1);

    window.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }));
    expect(connect).toHaveBeenCalledTimes(2);
    expect(onReconnect).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(connect).toHaveBeenCalledTimes(2);
  });
});
