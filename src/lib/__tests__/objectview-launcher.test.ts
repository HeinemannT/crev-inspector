import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getCtx: vi.fn(),
  launchFrame: vi.fn(),
}));

vi.mock('../sw-context', () => ({ getCtx: mocks.getCtx }));
vi.mock('../frame-launcher', () => ({ launchFrame: mocks.launchFrame }));

describe('object view launch ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCtx.mockReturnValue({
      settingsReady: Promise.resolve(),
      cache: {
        get: () => ({ name: 'Risk', type: 'CeRisk', businessId: 'risk.1' }),
      },
    });
    mocks.launchFrame.mockResolvedValue(undefined);
  });

  afterEach(() => {
    delete (globalThis as unknown as { chrome?: unknown }).chrome;
  });

  it('starts mounting before the optional title hint finishes writing', async () => {
    let finishWrite!: () => void;
    const storageSet = vi.fn(() => new Promise<void>(resolve => { finishWrite = resolve; }));
    (globalThis as unknown as { chrome: unknown }).chrome = {
      storage: { local: { set: storageSet } },
    };

    const { openObjectViewWindow } = await import('../objectview-launcher');
    let completed = false;
    const opening = openObjectViewWindow('42', { tabId: 7 }).then(() => { completed = true; });

    await vi.waitFor(() => expect(mocks.launchFrame).toHaveBeenCalledWith(expect.objectContaining({
      kind: 'objectview',
      path: 'objectview/objectview.html#42',
      tabId: 7,
    })));
    expect(storageSet).toHaveBeenCalledOnce();
    expect(completed).toBe(false);

    finishWrite();
    await opening;
    expect(completed).toBe(true);
  });
});
