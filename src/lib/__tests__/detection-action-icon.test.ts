import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockChromeStorage } from './chrome-mock';

const drawImage = vi.fn();
const beginPath = vi.fn();
const arc = vi.fn();
const fill = vi.fn();
const getImageData = vi.fn((_x: number, _y: number, width: number, height: number) => ({
  width,
  height,
  data: new Uint8ClampedArray(width * height * 4),
  colorSpace: 'srgb',
}));

class TestOffscreenCanvas {
  constructor(
    readonly width: number,
    readonly height: number,
  ) {}

  getContext(): OffscreenCanvasRenderingContext2D {
    return {
      drawImage,
      beginPath,
      arc,
      fill,
      getImageData,
      set fillStyle(_value: string | CanvasGradient | CanvasPattern) {},
    } as unknown as OffscreenCanvasRenderingContext2D;
  }
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mockChromeStorage();
  vi.stubGlobal('OffscreenCanvas', TestOffscreenCanvas);
  vi.stubGlobal('createImageBitmap', vi.fn(async () => ({ close: vi.fn() })));
  vi.stubGlobal('fetch', vi.fn(async () => ({
    ok: true,
    blob: async () => new Blob(),
  })));
});

describe('per-tab detection action icon', () => {
  it('clears the text badge and uses an outlined-dot icon on BMP pages', async () => {
    const { updateBadge } = await import('../detection');

    await updateBadge(17, true);

    expect(chrome.action.setBadgeText).toHaveBeenCalledWith({ tabId: 17, text: '' });
    expect(chrome.action.setBadgeBackgroundColor).not.toHaveBeenCalled();
    expect(chrome.action.setIcon).toHaveBeenCalledWith({
      tabId: 17,
      imageData: expect.objectContaining({
        16: expect.objectContaining({ width: 16, height: 16 }),
        32: expect.objectContaining({ width: 32, height: 32 }),
        48: expect.objectContaining({ width: 48, height: 48 }),
      }),
    });
    expect(drawImage).toHaveBeenCalledTimes(3);
    expect(fill).toHaveBeenCalledTimes(6);
  });

  it('restores the canonical full-colour icon off BMP pages', async () => {
    const { updateBadge } = await import('../detection');

    await updateBadge(18, false);

    expect(chrome.action.setIcon).toHaveBeenCalledWith({
      tabId: 18,
      path: {
        16: 'icons/icon-16.png',
        32: 'icons/icon-32.png',
        48: 'icons/icon-48.png',
      },
    });
  });
});
