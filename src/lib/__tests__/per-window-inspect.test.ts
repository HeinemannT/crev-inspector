/**
 * Per-window inspect-mode semantics (v0.20.2 deep fix).
 *
 * Inspect mode used to be a single global boolean — toggling it in
 * window A would paint pills onto every BMP tab in window B as well.
 * With two-window users that was surprising and not what they meant by
 * "show me the inspector for this tab". State is now per-window:
 * Map<windowId, boolean>, with each panel + content script seeing only
 * its own window's flag.
 */
import { describe, it, expect, vi } from 'vitest';
import { mockChromeStorage } from './chrome-mock';
import type { InspectorMessage, InspectorSettings } from '../types';

function setupChrome(tabs: Array<{ id: number; windowId: number }>) {
  mockChromeStorage();
  (globalThis as any).chrome.tabs = {
    get: vi.fn((tabId: number, cb?: (t?: { id: number; windowId: number }) => void) => {
      const tab = tabs.find(t => t.id === tabId);
      if (cb) cb(tab); return Promise.resolve(tab);
    }),
    query: vi.fn((q: any, cb?: (t: any[]) => void) => {
      const filtered = q.windowId != null
        ? tabs.filter(t => t.windowId === q.windowId)
        : tabs;
      const active = q.active ? filtered.slice(0, 1) : filtered;
      if (cb) cb(active);
      return Promise.resolve(active);
    }),
    sendMessage: vi.fn(async () => undefined),
  };
  (globalThis as any).chrome.scripting = { executeScript: vi.fn(async () => [{}]) };
  (globalThis as any).chrome.windows = {
    getLastFocused: vi.fn(async () => ({ id: tabs[0]?.windowId ?? 1 })),
    onRemoved: { addListener: vi.fn() },
  };
  (globalThis as any).chrome.runtime = { lastError: null };
}

async function createInspectHarness(opts: {
  tabs: Array<{ id: number; windowId: number }>;
  activeWindow?: number;
}) {
  vi.resetModules();
  vi.clearAllMocks();
  setupChrome(opts.tabs);

  const swCtxMod = await import('../sw-context');
  const inspectActiveByWindow = new Map<number, boolean>();
  const contentPorts = new Map<number, { postMessage: ReturnType<typeof vi.fn> }>();
  for (const t of opts.tabs) {
    contentPorts.set(t.id, { postMessage: vi.fn() });
  }
  const panelMessages: Array<{ windowId: number; msg: InspectorMessage }> = [];

  const settings: InspectorSettings = {
    schemaVersion: 1, profiles: [], activeProfileId: '',
    autoDetect: true, saveTarget: 'instance', enrichMode: 'all',
  };

  const persistSpy = vi.fn();
  const ctx: any = {
    client: null,
    hasPanel: false,
    panelPortByWindow: new Map(),
    contentPorts,
    inspectActiveByWindow,
    settings,
    technicalOverlay: false,
    settingsReady: Promise.resolve(),
    isInspectActive(w: number | undefined) { return w != null && inspectActiveByWindow.get(w) === true; },
    setInspectActive(w: number, active: boolean) {
      if (active) inspectActiveByWindow.set(w, true);
      else inspectActiveByWindow.delete(w);
      persistSpy();
    },
    logActivity: vi.fn(),
    sendToPanel: vi.fn(),
    sendToPanelByWindow: vi.fn((w: number, m: InspectorMessage) => panelMessages.push({ windowId: w, msg: m })),
    sendToPanelByTab: vi.fn(),
    broadcastToContent: vi.fn(),
    toast: vi.fn(),
  };
  swCtxMod.setSwContext(ctx);

  return { ctx, panelMessages, persistSpy, contentPorts };
}

describe('per-window inspect mode', () => {
  it('isInspectActive returns false for unknown windows', async () => {
    const h = await createInspectHarness({ tabs: [{ id: 1, windowId: 100 }] });
    expect(h.ctx.isInspectActive(100)).toBe(false);
    expect(h.ctx.isInspectActive(undefined)).toBe(false);
  });

  it('setInspectActive toggles only the targeted window', async () => {
    const h = await createInspectHarness({ tabs: [
      { id: 1, windowId: 100 },
      { id: 2, windowId: 200 },
    ] });
    h.ctx.setInspectActive(100, true);
    expect(h.ctx.isInspectActive(100)).toBe(true);
    expect(h.ctx.isInspectActive(200)).toBe(false);
    expect(h.persistSpy).toHaveBeenCalledTimes(1);
  });

  it('setInspectActive false removes the entry (drops persisted state)', async () => {
    const h = await createInspectHarness({ tabs: [{ id: 1, windowId: 100 }] });
    h.ctx.setInspectActive(100, true);
    expect(h.ctx.inspectActiveByWindow.has(100)).toBe(true);
    h.ctx.setInspectActive(100, false);
    expect(h.ctx.inspectActiveByWindow.has(100)).toBe(false);
  });

  it('toggleInspect from the handler flips state for the requesting window only', async () => {
    const h = await createInspectHarness({ tabs: [
      { id: 1, windowId: 100 },
      { id: 2, windowId: 200 },
    ] });
    // Import the handler module — registers TOGGLE_INSPECT against our ctx.
    const inspectMod = await import('../handlers/inspect');

    await inspectMod.toggleInspect(100);
    expect(h.ctx.isInspectActive(100)).toBe(true);
    expect(h.ctx.isInspectActive(200)).toBe(false);
    // Panel push went to the toggled window only.
    expect(h.panelMessages.find(p => p.windowId === 100)?.msg).toMatchObject({ type: 'INSPECT_STATE', active: true });
    expect(h.panelMessages.find(p => p.windowId === 200)).toBeUndefined();
  });

  it('toggleInspect pushes INSPECT_STATE only to content tabs in the target window', async () => {
    const h = await createInspectHarness({ tabs: [
      { id: 11, windowId: 100 },
      { id: 22, windowId: 200 },
    ] });
    const inspectMod = await import('../handlers/inspect');

    await inspectMod.toggleInspect(100);

    const port100 = h.contentPorts.get(11)!;
    const port200 = h.contentPorts.get(22)!;
    expect(port100.postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'INSPECT_STATE', active: true }));
    expect(port200.postMessage).not.toHaveBeenCalled();
  });

  it('toggleInspect with no windowId resolves via chrome.windows.getLastFocused', async () => {
    const h = await createInspectHarness({ tabs: [{ id: 1, windowId: 42 }] });
    (chrome.windows as any).getLastFocused = vi.fn(async () => ({ id: 42 }));
    const inspectMod = await import('../handlers/inspect');

    await inspectMod.toggleInspect();
    expect(h.ctx.isInspectActive(42)).toBe(true);
  });

  it('back-to-back toggles stay isolated across two windows', async () => {
    const h = await createInspectHarness({ tabs: [
      { id: 1, windowId: 100 },
      { id: 2, windowId: 200 },
    ] });
    const inspectMod = await import('../handlers/inspect');

    await inspectMod.toggleInspect(100); // 100 → on
    await inspectMod.toggleInspect(200); // 200 → on
    await inspectMod.toggleInspect(100); // 100 → off
    expect(h.ctx.isInspectActive(100)).toBe(false);
    expect(h.ctx.isInspectActive(200)).toBe(true);
  });
});
