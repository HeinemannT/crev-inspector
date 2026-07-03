/**
 * Tests for src/lib/content-script-injection.ts — content script readiness
 * + retry semantics. Recently extracted from tab-awareness.ts.
 *
 * Coverage:
 * - ensureContentScript: returns early when content script already connected
 *   (contentPorts has the tab); otherwise invokes chrome.scripting.executeScript
 * - ensureContentScript: surfaces a clean swallow when injection throws
 *   (no rethrow, but logActivity is still called for the inject attempt)
 * - sendPageInfoToPanel: when the content script responds → forwards to panel
 * - sendPageInfoToPanel: when sendMessage hits runtime.lastError or no
 *   response, retries via ensureContentScript + setTimeout 200ms
 * - sendPageInfoToPanel: after retries=0 and still no response, marks
 *   detection as 'not-detected' and sends DETECTION_STATE to panel
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockChromeStorage } from './chrome-mock';
import { setSwContext } from '../sw-context';
import { ObjectCache } from '../object-cache';
import type { InspectorSettings, InspectorMessage } from '../types';

interface InjectHarness {
  ctx: any;
  panelMsgs: InspectorMessage[];
  executeScript: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
}

function setupChrome(): { executeScript: ReturnType<typeof vi.fn>; sendMessage: ReturnType<typeof vi.fn> } {
  mockChromeStorage();
  const executeScript = vi.fn(async () => [{ result: undefined }]);
  const sendMessage = vi.fn();
  (globalThis as any).chrome.scripting = { executeScript };
  (globalThis as any).chrome.tabs = {
    sendMessage,
    query: vi.fn((_q: any, cb: any) => cb([{ id: 42 }])),
    // Per-site access gate: ensureContentScript resolves the tab URL and checks the
    // origin is granted before injecting. Default mock = a granted http tab.
    get: vi.fn(async (_id: number) => ({ id: 42, url: 'https://bmp.test/portal' })),
  };
  (globalThis as any).chrome.permissions = { contains: vi.fn(async () => true) };
  (globalThis as any).chrome.runtime = { lastError: null };
  return { executeScript, sendMessage };
}

async function createInjectHarness(): Promise<InjectHarness> {
  const { executeScript, sendMessage } = setupChrome();
  const panelMsgs: InspectorMessage[] = [];

  const settings: InspectorSettings = {
    schemaVersion: 1, profiles: [], activeProfileId: '',
    autoDetect: true, saveTarget: 'instance', enrichMode: 'all',
  };

  const ctx = {
    client: null,
    hasPanel: false,
    panelPortByWindow: new Map<number, any>(),
    contentPorts: new Map<number, any>(),
    cache: new ObjectCache(),
    settings,
    inspectActive: false,
    technicalOverlay: false,
    settingsReady: Promise.resolve(),
    logActivity: vi.fn(),
    sendToPanel: vi.fn((m: InspectorMessage) => panelMsgs.push(m)),
    sendToPanelByWindow: vi.fn((_w: number, m: InspectorMessage) => panelMsgs.push(m)),
    sendToPanelByTab: vi.fn((_t: number, m: InspectorMessage) => panelMsgs.push(m)),
    broadcastToContent: vi.fn(),
    toast: vi.fn(),
  };
  setSwContext(ctx as any);

  return { ctx, panelMsgs, executeScript, sendMessage };
}

describe('ensureContentScript', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('returns early without injecting when the tab is already in contentPorts', async () => {
    const h = await createInjectHarness();
    h.ctx.contentPorts.set(42, { name: 'content' });

    const { ensureContentScript } = await import('../content-script-injection');
    await ensureContentScript(42);

    expect(h.executeScript).not.toHaveBeenCalled();
    expect(h.ctx.logActivity).not.toHaveBeenCalled();
  });

  it('injects content.js when the tab has no live port', async () => {
    const h = await createInjectHarness();
    const { ensureContentScript } = await import('../content-script-injection');
    await ensureContentScript(42);

    expect(h.executeScript).toHaveBeenCalledTimes(1);
    expect(h.executeScript.mock.calls[0][0]).toEqual({
      target: { tabId: 42 },
      files: ['content.js'],
    });
    expect(h.ctx.logActivity).toHaveBeenCalledWith('info', expect.stringContaining('Injecting'));
  });

  it('does not throw when chrome.scripting.executeScript rejects (swallowed)', async () => {
    const h = await createInjectHarness();
    h.executeScript.mockRejectedValueOnce(new Error('Cannot access chrome:// URL'));

    const { ensureContentScript } = await import('../content-script-injection');
    // Must not throw
    await expect(ensureContentScript(42)).resolves.toBeUndefined();
    // The inject attempt was still logged
    expect(h.ctx.logActivity).toHaveBeenCalledWith('info', expect.stringContaining('Injecting'));
  });

  it('dedupes parallel calls — only one injection + one log entry per tab', async () => {
    // Repro for the v0.17.x bug: onActivated called sendPageInfoToPanel and
    // ensureContentScript in parallel. Both checked contentPorts.has(tab) →
    // both passed → both injected → user saw two "Injecting content script…"
    // log entries with identical timestamps. Now ensureContentScript stores
    // an in-flight promise per tab so concurrent calls share one injection.
    const h = await createInjectHarness();
    let resolveScript: (() => void) | undefined;
    h.executeScript.mockImplementationOnce(
      () => new Promise<void>(r => { resolveScript = () => r(); }),
    );

    const { ensureContentScript } = await import('../content-script-injection');
    const [p1, p2, p3] = [
      ensureContentScript(42),
      ensureContentScript(42),
      ensureContentScript(42),
    ];

    // The injection now sits behind the async per-site gate (tabs.get + permissions.contains),
    // so wait for executeScript to actually start before releasing it.
    await vi.waitFor(() => { expect(h.executeScript).toHaveBeenCalledTimes(1); });
    resolveScript!();
    await Promise.all([p1, p2, p3]);

    expect(h.executeScript).toHaveBeenCalledTimes(1);
    const injectingCalls = h.ctx.logActivity.mock.calls
      .filter((c: any[]) => typeof c[1] === 'string' && c[1].includes('Injecting'));
    expect(injectingCalls).toHaveLength(1);
  });

  it('skips injection entirely when the tab origin is not granted (per-site access)', async () => {
    // The Google-Maps fix: without a user grant the SW must not touch the tab at all —
    // no executeScript attempt, no "Injecting…" activity spam.
    const h = await createInjectHarness();
    ((globalThis as any).chrome.permissions.contains as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const { ensureContentScript } = await import('../content-script-injection');
    await expect(ensureContentScript(43)).resolves.toBeUndefined();

    expect(h.executeScript).not.toHaveBeenCalled();
    expect(h.ctx.logActivity).not.toHaveBeenCalled();
  });

  it('skips injection for non-http(s) tabs (chrome://, about:)', async () => {
    const h = await createInjectHarness();
    ((globalThis as any).chrome.tabs.get as ReturnType<typeof vi.fn>).mockResolvedValue({ id: 44, url: 'chrome://extensions' });

    const { ensureContentScript } = await import('../content-script-injection');
    await expect(ensureContentScript(44)).resolves.toBeUndefined();

    expect(h.executeScript).not.toHaveBeenCalled();
  });

  it('re-injects on the next call after the previous in-flight promise settles', async () => {
    // Make sure the dedup map clears after the injection resolves — otherwise
    // a real second injection (e.g., after the content port disconnected)
    // would silently no-op.
    const h = await createInjectHarness();
    const { ensureContentScript } = await import('../content-script-injection');

    await ensureContentScript(42);
    expect(h.executeScript).toHaveBeenCalledTimes(1);

    await ensureContentScript(42);
    expect(h.executeScript).toHaveBeenCalledTimes(2);
  });
});

describe('sendPageInfoToPanel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('forwards PAGE_INFO response to the panel on first try', async () => {
    const h = await createInjectHarness();
    const response: InspectorMessage = {
      type: 'PAGE_INFO',
      url: 'https://bmp.test/x',
      widgets: [],
    } as InspectorMessage;
    h.sendMessage.mockImplementation((_id: number, _msg: any, cb: any) => cb(response));

    const { sendPageInfoToPanel } = await import('../content-script-injection');
    sendPageInfoToPanel(42, 1);

    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    // With multi-window routing, a known tabId routes via sendToPanelByTab
    // (resolves the tab's window then targets that window's panel) rather
    // than broadcasting via sendToPanel.
    expect(h.ctx.sendToPanelByTab).toHaveBeenCalledWith(42, response);
    // No retry / injection
    expect(h.executeScript).not.toHaveBeenCalled();
  });

  it('retries via ensureContentScript when sendMessage hits runtime.lastError', async () => {
    const h = await createInjectHarness();
    let call = 0;
    h.sendMessage.mockImplementation((_id: number, _msg: any, cb: any) => {
      call++;
      if (call === 1) {
        (globalThis as any).chrome.runtime.lastError = { message: 'No receiving end' };
        cb(undefined);
        (globalThis as any).chrome.runtime.lastError = null;
      } else {
        cb({ type: 'PAGE_INFO', url: 'https://bmp.test/x', widgets: [] });
      }
    });

    const { sendPageInfoToPanel } = await import('../content-script-injection');
    sendPageInfoToPanel(42, 1);

    // First sendMessage call done synchronously; the retry path goes through
    // ensureContentScript().then(setTimeout(..., 200)). Flush microtasks first.
    await vi.runAllTimersAsync();

    expect(h.executeScript).toHaveBeenCalledTimes(1);   // re-injection happened
    expect(h.sendMessage).toHaveBeenCalledTimes(2);     // retried once
    expect(h.ctx.sendToPanelByTab).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ type: 'PAGE_INFO' }),
    );
  });

  it('after retries exhausted, marks detection not-detected and emits DETECTION_STATE', async () => {
    const h = await createInjectHarness();
    h.sendMessage.mockImplementation((_id: number, _msg: any, cb: any) => {
      (globalThis as any).chrome.runtime.lastError = { message: 'No receiving end' };
      cb(undefined);
      (globalThis as any).chrome.runtime.lastError = null;
    });

    const { sendPageInfoToPanel } = await import('../content-script-injection');
    sendPageInfoToPanel(42, 0); // no retries left

    // The first failure with retries=0 fires DETECTION_STATE synchronously
    await vi.runAllTimersAsync();

    const detectionMsg = h.panelMsgs.find((m: any) => m.type === 'DETECTION_STATE') as any;
    expect(detectionMsg).toBeDefined();
    expect(detectionMsg.phase).toBe('not-detected');
    expect(detectionMsg.signals).toContain('content-script-unreachable');
  });

  // "no-op when no panel is connected" lives in the service worker's
  // routing implementation (sendToPanelByTab silently drops when the
  // tab's window has no panel registered). This module unconditionally
  // hands off to ctx.sendToPanelByTab — we document that contract.
  it('always hands off to ctx.sendToPanelByTab — panel-connection gating is upstream', async () => {
    const h = await createInjectHarness();
    h.sendMessage.mockImplementation((_id: number, _msg: any, cb: any) => {
      cb({ type: 'PAGE_INFO', url: 'https://bmp.test', widgets: [] });
    });

    const { sendPageInfoToPanel } = await import('../content-script-injection');
    sendPageInfoToPanel(42, 1);
    await vi.runAllTimersAsync();

    // sendToPanelByTab is called regardless of whether a panel is
    // registered for the tab's window. The real implementation
    // (service-worker.ts) is responsible for the no-op when there's no
    // matching panel.
    expect(h.ctx.sendToPanelByTab).toHaveBeenCalledWith(
      42,
      expect.objectContaining({ type: 'PAGE_INFO' }),
    );
  });

  it('queries the active tab when called with no tabId', async () => {
    const h = await createInjectHarness();
    h.sendMessage.mockImplementation((_id: number, _msg: any, cb: any) => {
      cb({ type: 'PAGE_INFO', url: 'https://bmp.test', widgets: [] });
    });

    const { sendPageInfoToPanel } = await import('../content-script-injection');
    sendPageInfoToPanel();
    await vi.runAllTimersAsync();

    // chrome.tabs.query was called to find the active tab.
    // We prefer lastFocusedWindow over currentWindow so popup contexts
    // (graph view) don't redirect GET_PAGE_INFO to themselves.
    expect((globalThis.chrome.tabs as any).query).toHaveBeenCalledWith(
      { active: true, lastFocusedWindow: true },
      expect.any(Function),
    );
    // sendMessage went to tab 42 (the active-tab id provided by the chrome mock)
    expect(h.sendMessage.mock.calls[0][0]).toBe(42);
  });
});
