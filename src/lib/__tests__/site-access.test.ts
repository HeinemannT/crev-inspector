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
        contains: vi.fn(async ({ origins }: chrome.permissions.Permissions) =>
          origins?.every(origin => granted.includes(origin)) ?? false),
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
      provider: 'custom',
      model: 'agent',
      apiKeyEnc: 'encrypted',
      customProvider: {
        name: 'Gateway',
        vendor: 'gateway',
        apiType: 'openai',
        models: [{ id: 'agent', name: 'Agent', url: 'https://gateway.example.test/v1', toolCalling: true }],
      },
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

  it('registers a configured BMP origin when a broader host permission covers it', async () => {
    const registerContentScripts = vi.fn(async (_scripts: chrome.scripting.RegisteredContentScript[]) => {});
    globalThis.chrome = {
      permissions: {
        getAll: vi.fn(async () => ({ origins: ['https://*/*'] })),
        contains: vi.fn(async ({ origins }: chrome.permissions.Permissions) =>
          origins?.[0] === 'https://bmp.example.test/*'),
        remove: vi.fn(async () => false),
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
    await reconcileProfileOrigins(['https://bmp.example.test/workspace']);

    expect(chrome.permissions.contains).toHaveBeenCalledWith({
      origins: ['https://bmp.example.test/*'],
    });
    expect(registerContentScripts).toHaveBeenCalledOnce();
    const registrations = registerContentScripts.mock.calls[0]![0];
    expect(registrations[0].matches).toEqual(['https://bmp.example.test/*']);
    expect(registrations[1].matches).toEqual(['https://bmp.example.test/*']);
  });

  it('removes provider grants that are no longer selected', async () => {
    const remove = vi.fn(async (_permissions: chrome.permissions.Permissions) => true);
    globalThis.chrome = {
      permissions: {
        getAll: vi.fn(async () => ({
          origins: [
            'https://bmp.example.test/*',
            'https://api.openai.com/*',
            'https://api.anthropic.com/*',
          ],
        })),
        contains: vi.fn(async () => true),
        remove,
        onAdded: { addListener: vi.fn() },
        onRemoved: { addListener: vi.fn() },
      },
      scripting: {
        getRegisteredContentScripts: vi.fn(async () => []),
        unregisterContentScripts: vi.fn(async () => {}),
        registerContentScripts: vi.fn(async () => {}),
      },
    } as unknown as typeof chrome;

    const { reconcileProfileOrigins } = await import('../site-access');
    await reconcileProfileOrigins(['https://bmp.example.test/workspace'], {
      provider: 'openai',
      model: 'gpt-5.2',
      apiKeyEnc: 'encrypted',
    });

    expect(remove).toHaveBeenCalledWith({ origins: ['https://api.anthropic.com/*'] });
  });

  it('removes provider grants when AI configuration is removed', async () => {
    const remove = vi.fn(async (_permissions: chrome.permissions.Permissions) => true);
    globalThis.chrome = {
      permissions: {
        getAll: vi.fn(async () => ({
          origins: [
            'https://api.openai.com/*',
            'https://api.anthropic.com/*',
          ],
        })),
        contains: vi.fn(async () => false),
        remove,
        onAdded: { addListener: vi.fn() },
        onRemoved: { addListener: vi.fn() },
      },
      scripting: {
        getRegisteredContentScripts: vi.fn(async () => []),
        unregisterContentScripts: vi.fn(async () => {}),
        registerContentScripts: vi.fn(async () => {}),
      },
    } as unknown as typeof chrome;

    const { reconcileProfileOrigins } = await import('../site-access');
    await reconcileProfileOrigins([], undefined);

    expect(remove).toHaveBeenCalledWith({
      origins: [
        'https://api.openai.com/*',
        'https://api.anthropic.com/*',
      ],
    });
  });

  it('rejects before network work when BMP host access is missing', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    globalThis.chrome = {
      permissions: {
        contains: vi.fn(async () => false),
      },
    } as unknown as typeof chrome;

    const { assertHostAccess, HostAccessError } = await import('../site-access');
    await expect(assertHostAccess('https://bmp.example.test/Workspace/graphql'))
      .rejects.toBeInstanceOf(HostAccessError);
    expect(chrome.permissions.contains).toHaveBeenCalledWith({
      origins: ['https://bmp.example.test/*'],
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('allows the exact BMP origin when its grant exists', async () => {
    globalThis.chrome = {
      permissions: {
        contains: vi.fn(async () => true),
      },
    } as unknown as typeof chrome;

    const { assertHostAccess } = await import('../site-access');
    await expect(assertHostAccess('https://bmp.example.test/Workspace/graphql'))
      .resolves.toBeUndefined();
  });
});
