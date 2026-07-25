/**
 * @vitest-environment happy-dom
 *
 * Panel-side PANEL_HELLO gate (v0.20.2 deep fix).
 *
 * The boot path used to race: chrome.windows.getCurrent (async) raced
 * chrome.storage.session.get's callback (also async). If storage
 * resolved first, switchTab() → sendMessage(GET_PAGE_INFO) hit the
 * port BEFORE PANEL_HELLO landed at the SW. The SW would then route
 * the PAGE_INFO response via lastFocusedWindow, which is wrong when
 * the user has two panels open.
 *
 * Fix: state.ts queues every sendMessage call until PANEL_HELLO has
 * been delivered, then flushes. This test mocks chrome.windows /
 * chrome.runtime.connect to control timing and asserts the on-wire
 * order is PANEL_HELLO first.
 */
import { describe, it, expect, vi } from 'vitest';
import type { InspectorMessage } from '../../lib/types';

// Helper to flush all pending microtasks — windowIdReady is one chained
// microtask, sendPanelHello queues another, etc. Three flushes is
// plenty for the deepest chain in state.ts.
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

// Each test re-imports state.ts via vi.resetModules so module-level
// state (helloSent, preHelloQueue, panelWindowId) starts fresh.
async function setupHarness(opts: { windowIdResolver: () => Promise<{ id?: number } | undefined> }) {
  vi.resetModules();
  const sentMessages: InspectorMessage[] = [];
  const fakePort = {
    name: 'panel',
    postMessage: vi.fn((msg: InspectorMessage) => sentMessages.push(msg)),
    onMessage: { addListener: vi.fn() },
    onDisconnect: { addListener: vi.fn() },
    disconnect: vi.fn(),
  };

  (globalThis as any).chrome = {
    runtime: {
      connect: vi.fn(() => fakePort),
      lastError: null,
    },
    windows: {
      getCurrent: vi.fn(opts.windowIdResolver),
    },
  };

  const state = await import('../state');
  return { state, sentMessages, fakePort };
}

describe('PANEL_HELLO is always first on the wire', () => {
  it('queues sendMessage calls made BEFORE PANEL_HELLO is sent', async () => {
    // Manual control over when windowIdReady resolves — we want
    // sendMessage to fire WHILE the discovery is still in flight.
    let resolveWindow!: (v: { id: number }) => void;
    const windowPromise = new Promise<{ id: number }>(r => { resolveWindow = r; });
    const h = await setupHarness({ windowIdResolver: () => windowPromise });

    h.state.connectPanel();
    h.state.sendMessage({ type: 'GET_PAGE_INFO' } as InspectorMessage);
    h.state.sendMessage({ type: 'GET_SETTINGS' } as InspectorMessage);

    // Nothing on the wire yet — PANEL_HELLO waits for window discovery.
    expect(h.sentMessages).toHaveLength(0);

    // Resolve discovery, let microtask chain run.
    resolveWindow({ id: 42 });
    await flushMicrotasks();

    // PANEL_HELLO landed first; queued messages flushed in order.
    expect(h.sentMessages[0]).toEqual({ type: 'PANEL_HELLO', windowId: 42 });
    expect(h.sentMessages[1]).toEqual({ type: 'GET_PAGE_INFO' });
    expect(h.sentMessages[2]).toEqual({ type: 'GET_SETTINGS' });
  });

  it('lets messages flow normally after PANEL_HELLO is sent', async () => {
    const h = await setupHarness({ windowIdResolver: async () => ({ id: 42 }) });

    h.state.connectPanel();
    await flushMicrotasks();

    h.state.sendMessage({ type: 'GET_PAGE_INFO' } as InspectorMessage);
    expect(h.sentMessages.find(m => m.type === 'GET_PAGE_INFO')).toBeDefined();
  });

  it('flips the gate to true even when chrome returns no windowId', async () => {
    const h = await setupHarness({ windowIdResolver: async () => undefined });

    h.state.connectPanel();
    h.state.sendMessage({ type: 'GET_PAGE_INFO' } as InspectorMessage);
    await flushMicrotasks();

    // Without a windowId, PANEL_HELLO never goes on the wire — but
    // queued sends should still flush so the panel isn't permanently
    // stuck (private browsing / locked-down contexts).
    expect(h.sentMessages.find(m => m.type === 'PANEL_HELLO')).toBeUndefined();
    expect(h.sentMessages.find(m => m.type === 'GET_PAGE_INFO')).toBeDefined();
  });

  it('PANEL_HELLO itself bypasses the gate (no deadlock on the handshake)', async () => {
    const h = await setupHarness({ windowIdResolver: async () => ({ id: 100 }) });

    h.state.connectPanel();
    await flushMicrotasks();
    expect(h.sentMessages[0]).toEqual({ type: 'PANEL_HELLO', windowId: 100 });
  });

  it('messages sent while port is disconnected still flush behind PANEL_HELLO', async () => {
    // Repro the SW-idle scenario: panel connected, PANEL_HELLO sent,
    // user clicks something while SW is dead. Without the fix, the
    // ReconnectingPort's outer queue would flush those messages on
    // reconnect BEFORE the panel re-sent PANEL_HELLO.
    const h = await setupHarness({ windowIdResolver: async () => ({ id: 42 }) });
    h.state.connectPanel();
    await flushMicrotasks();
    // PANEL_HELLO landed on initial connect.
    expect(h.sentMessages[0]).toEqual({ type: 'PANEL_HELLO', windowId: 42 });
    h.sentMessages.length = 0;

    // Simulate SW disconnect: the panel state's enqueueOnDisconnect is
    // wired into createReconnectingPort. We can drive it by reaching
    // into the fake port and triggering its onDisconnect listener,
    // then calling sendMessage on the now-disconnected port.
    const disconnectListeners = h.fakePort.onDisconnect.addListener.mock.calls.map((c: any[]) => c[0]);
    for (const listener of disconnectListeners) listener();

    // sendMessage now should NOT reach the port (port is null
    // internally to ReconnectingPort) and should route through our
    // preHelloQueue path. We can't observe queueing directly without
    // reaching into internals, so assert nothing went on the wire.
    h.state.sendMessage({ type: 'GET_PAGE_INFO' } as InspectorMessage);
    expect(h.sentMessages).toHaveLength(0);
  });

  it('retires a superseded panel without entering the reconnect loop', async () => {
    vi.useFakeTimers();
    try {
      const h = await setupHarness({ windowIdResolver: async () => ({ id: 42 }) });
      h.state.connectPanel();
      await flushMicrotasks();

      const messageListener = h.fakePort.onMessage.addListener.mock.calls[0]?.[0] as
        ((msg: InspectorMessage) => void) | undefined;
      expect(messageListener).toBeDefined();
      messageListener!({ type: 'PANEL_SUPERSEDED' });
      expect(h.fakePort.disconnect).toHaveBeenCalledTimes(1);

      // Chrome reports the destroy-triggered disconnect asynchronously. A
      // normal disconnect schedules reconnect after 200 ms; a retired panel
      // must stay dead even after well beyond that delay.
      const disconnectListeners = h.fakePort.onDisconnect.addListener.mock.calls
        .map((c: any[]) => c[0] as () => void);
      for (const listener of disconnectListeners) listener();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(chrome.runtime.connect).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
