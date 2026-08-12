import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockChromeStorage } from './chrome-mock';

const mocks = vi.hoisted(() => ({
  getCtx: vi.fn(),
  resolveTabPageContext: vi.fn(),
}));

vi.mock('../sw-context', () => ({ getCtx: mocks.getCtx }));
vi.mock('../page-context-resolver', () => ({
  resolveTabPageContext: mocks.resolveTabPageContext,
}));

const editorData = {
  instance: { rid: '42', businessId: 'widget.42', type: 'ExtendedTable', name: 'Results' },
  template: null,
  instanceCode: { expression: 'output("ok")' },
  templateCode: {},
};

describe('editor launch targeting', () => {
  let fetchEditorContext: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockChromeStorage();
    fetchEditorContext = vi.fn(async () => editorData);
    mocks.getCtx.mockReturnValue({
      settingsReady: Promise.resolve(),
      settings: { activeProfileId: 'profile', saveTarget: 'instance' },
      client: { serverUrl: 'https://bmp.test', supportsLookup: true, fetchEditorContext },
      cache: { get: vi.fn(() => undefined) },
    });
    mocks.resolveTabPageContext.mockImplementation(async (tabId: number) => ({
      rid: tabId === 1 ? '1001' : '2002',
      source: 'url',
    }));
    (globalThis.chrome as any).tabs = {
      get: vi.fn(async (tabId: number) => ({ id: tabId, windowId: tabId, url: 'https://bmp.test/app' })),
      query: vi.fn(async () => [{ id: 1, windowId: 10, url: 'https://bmp.test/app' }]),
      sendMessage: vi.fn(async () => undefined),
    };
  });

  it('keeps overlapping same-RID launches on different tabs isolated', async () => {
    const { openEditorWindow } = await import('../editor');

    await Promise.all([
      openEditorWindow('42', undefined, { tabId: 1 }),
      openEditorWindow('42', undefined, { tabId: 2 }),
    ]);

    const mounts = (chrome.tabs.sendMessage as any).mock.calls;
    expect(mounts.map((call: any) => call[0])).toEqual([1, 2]);
    expect(mounts[0][1].url).not.toBe(mounts[1][1].url);
    expect(mounts[0][1].url).toMatch(/editor\.html\?launch=.+#42$/);
    expect(mounts[1][1].url).toMatch(/editor\.html\?launch=.+#42$/);

    const finalContexts = (chrome.storage.session.set as any).mock.calls
      .flatMap((call: any) => Object.values(call[0] ?? {}))
      .filter((value: any) => value?.launchSessionId && value.loading === false);
    expect(finalContexts.map((value: any) => value.executionContextRid).sort())
      .toEqual(['1001', '2002']);
  });

  it('uses one frozen active tab for page context and frame mount', async () => {
    let activeTabId = 1;
    (globalThis.chrome as any).tabs.query = vi.fn(async () => {
      const result = [{ id: activeTabId, windowId: 10, url: 'https://bmp.test/app' }];
      activeTabId = 2;
      return result;
    });
    const { openEditorWindow } = await import('../editor');

    await openEditorWindow('42', undefined, { windowId: 10 });

    expect(chrome.tabs.query).toHaveBeenCalledTimes(1);
    expect(mocks.resolveTabPageContext).toHaveBeenCalledWith(1);
    expect((chrome.tabs.sendMessage as any).mock.calls[0][0]).toBe(1);
  });

  it('reuses a live same-environment editor without fetching or orphaning a launch context', async () => {
    (chrome.tabs.sendMessage as any).mockResolvedValueOnce({
      type: 'FRAME_MOUNT_RESULT',
      disposition: 'activated',
    });
    const { openEditorWindow } = await import('../editor');

    await openEditorWindow('42', 'afterExpression', { tabId: 1 });

    expect(fetchEditorContext).not.toHaveBeenCalled();
    const mount = (chrome.tabs.sendMessage as any).mock.calls[0][1];
    expect(mount.resourceKey).toMatch(/^editor:.+:42$/);
    const launchSet = vi.mocked(chrome.storage.session.set).mock.calls
      .find(call => Object.keys(call[0]).some(key => key.startsWith('crev_editor_launch_')));
    const launchKey = Object.keys(launchSet?.[0] ?? {})[0];
    expect(launchKey).toBeTruthy();
    expect(chrome.storage.session.remove).toHaveBeenCalledWith(launchKey);
  });
});
