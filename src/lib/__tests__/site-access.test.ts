import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('site access registration boundaries', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('keeps provider fetch permissions but registers content scripts only on BMP profile origins', async () => {
    const granted = ['https://bmp.example.test/*', 'https://gateway.example.test/*'];
    const registerContentScripts = vi.fn(async (_scripts: chrome.scripting.RegisteredContentScript[]) => {});
    globalThis.chrome = {
      permissions: {
        getAll: vi.fn(async () => ({ origins: granted })),
        remove: vi.fn(async () => true),
        onAdded: { addListener: vi.fn() },
        onRemoved: { addListener: vi.fn() },
      },
      scripting: {
        getRegisteredContentScripts: vi.fn(async () => []),
        unregisterContentScripts: vi.fn(async () => {}),
        registerContentScripts,
      },
    } as unknown as typeof chrome;

    const { reconcileProfileOrigins } = await import('../site-access');
    await reconcileProfileOrigins(['https://bmp.example.test/corpo'], {
      name: 'Gateway',
      vendor: 'gateway',
      apiType: 'openai',
      models: [{ id: 'agent', name: 'Agent', url: 'https://gateway.example.test/v1', toolCalling: true }],
    });

    expect(chrome.permissions.remove).not.toHaveBeenCalledWith(expect.objectContaining({
      origins: expect.arrayContaining(['https://gateway.example.test/*']),
    }));
    expect(registerContentScripts).toHaveBeenCalledOnce();
    const registrations = registerContentScripts.mock.calls[0]![0];
    expect(registrations).toHaveLength(2);
    expect(registrations[0].matches).toEqual(['https://bmp.example.test/*']);
    expect(registrations[1].matches).toEqual(['https://bmp.example.test/*']);
  });
});
