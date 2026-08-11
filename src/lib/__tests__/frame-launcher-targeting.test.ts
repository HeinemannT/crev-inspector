/**
 * Frame-launcher window targeting (v0.20.2 deep fix).
 *
 * launchFrame mounts an in-page iframe overlay on a target tab via
 * chrome.tabs.sendMessage(MOUNT_FRAME). With two side panels open the
 * old "always pick lastFocusedWindow.active" rule landed the editor /
 * object-view / diff / code-search on the WRONG window's BMP tab.
 *
 * The new API accepts either `tabId` (mount exactly there — content
 * script source) or `windowId` (mount on that window's active tab —
 * side-panel source). Falls back to lastFocusedWindow only when neither
 * is supplied.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockChromeStorage } from './chrome-mock';

interface Tab { id: number; windowId: number }

function setupChrome(tabs: Tab[]) {
  mockChromeStorage();
  (globalThis as any).chrome.tabs = {
    get: vi.fn(async (tabId: number) => tabs.find(t => t.id === tabId)),
    query: vi.fn(async (q: any) => {
      let result = tabs.slice();
      if (q.windowId != null) result = result.filter(t => t.windowId === q.windowId);
      // lastFocusedWindow → first window we know about.
      if (q.lastFocusedWindow) {
        const firstWindow = tabs[0]?.windowId;
        result = result.filter(t => t.windowId === firstWindow);
      }
      if (q.active) result = result.slice(0, 1);
      return result;
    }),
    sendMessage: vi.fn(async () => undefined),
  };
  (globalThis as any).chrome.runtime = {
    getURL: vi.fn((p: string) => `chrome-extension://test/${p}`),
    lastError: null,
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

describe('launchFrame target resolution', () => {
  it('freezes a window target to one tab id for downstream launch work', async () => {
    setupChrome([
      { id: 1, windowId: 100 },
      { id: 2, windowId: 100 },
    ]);
    const { resolveFrameTargetTabId } = await import('../frame-launcher');

    const tabId = await resolveFrameTargetTabId({ windowId: 100 });

    expect(tabId).toBe(1);
    expect((chrome.tabs.query as any).mock.calls).toHaveLength(1);
  });

  it('mounts on tabId directly when given', async () => {
    setupChrome([
      { id: 1, windowId: 100 },
      { id: 2, windowId: 200 },
    ]);
    const { launchFrame } = await import('../frame-launcher');

    await launchFrame({
      kind: 'editor', path: 'editor/editor.html', label: 'x',
      defaultWidth: 100, defaultHeight: 100, tabId: 2,
    });

    expect((chrome.tabs.sendMessage as any).mock.calls[0][0]).toBe(2);
    // query was not used; tabId path used chrome.tabs.get
    expect((chrome.tabs.query as any).mock.calls).toHaveLength(0);
  });

  it('forwards resource identity and in-place activation to the content frame', async () => {
    setupChrome([{ id: 1, windowId: 100 }]);
    const { launchFrame } = await import('../frame-launcher');

    await launchFrame({
      kind: 'editor',
      path: 'editor/editor.html#42',
      label: 'Editor',
      defaultWidth: 960,
      defaultHeight: 640,
      tabId: 1,
      resourceKey: 'editor:42',
      activation: { type: 'editor', rid: '42', property: 'expression' },
    });

    expect((chrome.tabs.sendMessage as any).mock.calls[0][1]).toMatchObject({
      type: 'MOUNT_FRAME',
      resourceKey: 'editor:42',
      activation: { type: 'editor', rid: '42', property: 'expression' },
    });
  });

  it('mounts on windowId\'s active tab when only windowId is given', async () => {
    setupChrome([
      { id: 1, windowId: 100 },
      { id: 2, windowId: 200 },
      { id: 3, windowId: 200 },
    ]);
    const { launchFrame } = await import('../frame-launcher');

    await launchFrame({
      kind: 'editor', path: 'editor/editor.html', label: 'x',
      defaultWidth: 100, defaultHeight: 100, windowId: 200,
    });

    // Active tab of window 200 is the first match → tab 2.
    expect((chrome.tabs.sendMessage as any).mock.calls[0][0]).toBe(2);
    expect((chrome.tabs.query as any).mock.calls[0][0]).toMatchObject({ active: true, windowId: 200 });
  });

  it('falls back to lastFocusedWindow when neither tabId nor windowId is given', async () => {
    setupChrome([
      { id: 1, windowId: 100 },
      { id: 2, windowId: 200 },
    ]);
    const { launchFrame } = await import('../frame-launcher');

    await launchFrame({
      kind: 'editor', path: 'editor/editor.html', label: 'x',
      defaultWidth: 100, defaultHeight: 100,
    });

    // lastFocusedWindow → window 100 (first), active tab → tab 1.
    expect((chrome.tabs.sendMessage as any).mock.calls[0][0]).toBe(1);
    expect((chrome.tabs.query as any).mock.calls[0][0]).toMatchObject({ active: true, lastFocusedWindow: true });
  });

  it('tabId takes precedence over windowId', async () => {
    setupChrome([
      { id: 1, windowId: 100 },
      { id: 2, windowId: 200 },
      { id: 3, windowId: 200 },
    ]);
    const { launchFrame } = await import('../frame-launcher');

    // Both targets given — tabId wins (it's the explicit pick).
    await launchFrame({
      kind: 'editor', path: 'editor/editor.html', label: 'x',
      defaultWidth: 100, defaultHeight: 100, tabId: 3, windowId: 100,
    });

    expect((chrome.tabs.sendMessage as any).mock.calls[0][0]).toBe(3);
  });

  it('drops silently when no target tab can be resolved', async () => {
    setupChrome([]);
    const { launchFrame } = await import('../frame-launcher');

    // Should not throw.
    await launchFrame({
      kind: 'editor', path: 'editor/editor.html', label: 'x',
      defaultWidth: 100, defaultHeight: 100,
    });

    expect((chrome.tabs.sendMessage as any).mock.calls).toHaveLength(0);
  });
});
