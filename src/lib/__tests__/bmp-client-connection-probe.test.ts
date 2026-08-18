import { afterEach, describe, expect, it, vi } from 'vitest';
import { BmpClient } from '../bmp-client';
import { AUTH_TIMEOUT } from '../constants';
import { mockChromeStorage } from './chrome-mock';

afterEach(() => vi.unstubAllGlobals());

describe('BmpClient connection probe', () => {
  it('uses the short auth deadline instead of occupying the EC lane for 30 seconds', async () => {
    mockChromeStorage();
    const client = new BmpClient(
      'https://bmp.test/Workspace/',
      'admin',
      'pass',
      'profile',
      'stored',
    );
    vi.spyOn((client as any).auth, 'getLoginTicket').mockResolvedValue('admin;STUDIO;1');
    const execute = vi.spyOn(client, 'executeEc').mockResolvedValue({ ok: true, log: '1' });

    await expect(client.testConnection()).resolves.toMatchObject({ ok: true, authenticated: true });
    expect(execute).toHaveBeenCalledWith('1', undefined, false, undefined, AUTH_TIMEOUT);
  });

  it('distinguishes authenticated, unavailable, and transient build-number outcomes', async () => {
    mockChromeStorage();
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(null, { status: 404 }))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ version: '5.6.10.0' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })));

    await expect(BmpClient.getBuildNumber('https://bmp.test/Workspace/'))
      .resolves.toEqual({ status: 'auth-required' });
    await expect(BmpClient.getBuildNumber('https://bmp.test/Workspace/'))
      .resolves.toEqual({ status: 'unavailable' });
    await expect(BmpClient.getBuildNumber('https://bmp.test/Workspace/'))
      .resolves.toEqual({ status: 'transient' });
    await expect(BmpClient.getBuildNumber('https://bmp.test/Workspace/'))
      .resolves.toEqual({ status: 'known', version: '5.6.10.0' });
  });
});
