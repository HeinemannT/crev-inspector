import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockChromeStorage } from './chrome-mock';
import { probePortalIdentity } from '../portal-identity';

beforeEach(() => {
  mockChromeStorage();
  vi.restoreAllMocks();
});

describe('probePortalIdentity', () => {
  it('returns only the verified username and ignores token-shaped response fields', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      redirected: false,
      url: 'https://bmp.test/Workspace/cs/authentication',
      json: async () => ({
        userName: 'portal.user',
        access_token: 'must-not-be-adopted',
        refresh_token_url: 'must-not-be-adopted',
      }),
    } as unknown as Response));
    expect(await probePortalIdentity('https://bmp.test/Workspace/')).toEqual({
      status: 'connected',
      user: 'portal.user',
      source: 'portal-session',
    });
  });

  it('classifies a missing browser session independently', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 401,
      redirected: false,
      url: 'https://bmp.test/Workspace/cs/authentication',
    } as unknown as Response));
    expect(await probePortalIdentity('https://bmp.test/Workspace/')).toMatchObject({
      status: 'unavailable',
      user: null,
    });
  });

  it('does not treat HTML or malformed JSON as an identity', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      redirected: false,
      url: 'https://bmp.test/Workspace/cs/authentication',
      json: async () => { throw new Error('html'); },
    } as unknown as Response));
    expect(await probePortalIdentity('https://bmp.test/Workspace/')).toMatchObject({
      status: 'unavailable',
      user: null,
    });
  });
});
