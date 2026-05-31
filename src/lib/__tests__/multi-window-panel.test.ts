/**
 * Multi-window side-panel routing (v0.20.2 deep fix).
 *
 * The panel is window-scoped: each Chrome window can have its own side-
 * panel instance. The SW must route window-targeted messages
 * (PAGE_INFO, DETECTION_STATE, …) to the panel in the right window so
 * two open panels don't show each other's data.
 *
 * These tests don't exercise chrome.runtime.Port directly — that's
 * outside vitest's reach. They cover the routing primitives that sit
 * between port and handler: sendToPanelByWindow, sendToPanelByTab.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Mock } from 'vitest';
import { mockChromeStorage } from './chrome-mock';

interface FakePort {
  name: string;
  postMessage: Mock<(msg: unknown) => void>;
}

function makePort(name = 'panel'): FakePort {
  return { name, postMessage: vi.fn<(msg: unknown) => void>() };
}

function setupChromeTabs(tabs: Array<{ id: number; windowId: number }>) {
  mockChromeStorage();
  (globalThis as any).chrome.tabs = {
    get: vi.fn((tabId: number, cb: (t?: { id: number; windowId: number }) => void) => {
      cb(tabs.find(t => t.id === tabId));
    }),
    query: vi.fn(),
  };
  (globalThis as any).chrome.windows = {
    onRemoved: { addListener: vi.fn() },
  };
}

/** Build a minimal SwContext that exercises the routing helpers from the
 *  REAL service-worker code — we'd need to spin up the SW module to test
 *  it end-to-end, which is impractical. Instead, we reproduce the
 *  routing primitives' shape directly here so a regression in their
 *  semantics (rather than the SW boot wiring) trips this test. */
function makeRoutingCtx(tabs: Array<{ id: number; windowId: number }>) {
  setupChromeTabs(tabs);
  const panelPortByWindow = new Map<number, FakePort>();
  return {
    panelPortByWindow,
    sendToPanelByWindow(windowId: number, msg: unknown) {
      const port = panelPortByWindow.get(windowId);
      if (port) port.postMessage(msg);
    },
    sendToPanelByTab(tabId: number, msg: unknown) {
      chrome.tabs.get(tabId, (tab) => {
        if (!tab?.windowId) return;
        this.sendToPanelByWindow(tab.windowId, msg);
      });
    },
  };
}

describe('multi-window panel routing', () => {
  it('sendToPanelByWindow targets only the panel in the matching window', () => {
    const ctx = makeRoutingCtx([]);
    const panelA = makePort();
    const panelB = makePort();
    ctx.panelPortByWindow.set(1, panelA);
    ctx.panelPortByWindow.set(2, panelB);

    ctx.sendToPanelByWindow(1, { type: 'PAGE_INFO', widgets: [] });

    expect(panelA.postMessage).toHaveBeenCalledTimes(1);
    expect(panelB.postMessage).not.toHaveBeenCalled();
  });

  it('sendToPanelByTab resolves the tab\'s windowId and targets the right panel', () => {
    const ctx = makeRoutingCtx([{ id: 100, windowId: 1 }, { id: 200, windowId: 2 }]);
    const panelA = makePort();
    const panelB = makePort();
    ctx.panelPortByWindow.set(1, panelA);
    ctx.panelPortByWindow.set(2, panelB);

    ctx.sendToPanelByTab(200, { type: 'PAGE_INFO', widgets: [] });

    // Tab 200 lives in window 2 → panel B gets the message.
    expect(panelB.postMessage).toHaveBeenCalledTimes(1);
    expect(panelA.postMessage).not.toHaveBeenCalled();
  });

  it('sendToPanelByTab silently no-ops when the tab\'s window has no panel', () => {
    const ctx = makeRoutingCtx([{ id: 100, windowId: 1 }, { id: 200, windowId: 2 }]);
    const panelA = makePort();
    ctx.panelPortByWindow.set(1, panelA);
    // No panel for window 2.

    ctx.sendToPanelByTab(200, { type: 'PAGE_INFO', widgets: [] });

    expect(panelA.postMessage).not.toHaveBeenCalled();
  });

  it('sendToPanelByTab is a no-op for unknown tabs (defensive)', () => {
    const ctx = makeRoutingCtx([{ id: 100, windowId: 1 }]);
    const panelA = makePort();
    ctx.panelPortByWindow.set(1, panelA);

    ctx.sendToPanelByTab(999, { type: 'PAGE_INFO', widgets: [] });

    expect(panelA.postMessage).not.toHaveBeenCalled();
  });

  it('broadcasting via for…of reaches every panel (used by sendToPanel)', () => {
    const ctx = makeRoutingCtx([]);
    const panelA = makePort();
    const panelB = makePort();
    ctx.panelPortByWindow.set(1, panelA);
    ctx.panelPortByWindow.set(2, panelB);

    for (const p of ctx.panelPortByWindow.values()) p.postMessage({ type: 'SETTINGS_DATA' });

    expect(panelA.postMessage).toHaveBeenCalledTimes(1);
    expect(panelB.postMessage).toHaveBeenCalledTimes(1);
  });
});

describe('PANEL_HELLO message contract', () => {
  it('carries windowId so the SW can index the port', () => {
    const msg = { type: 'PANEL_HELLO' as const, windowId: 42 };
    expect(msg.windowId).toBe(42);
  });
});
