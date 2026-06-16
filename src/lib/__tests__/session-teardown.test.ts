/**
 * Tests for handleSessionCookieRemoved — the cookies.onChanged teardown that
 * revokes a BORROWED token chain when the BMP session cookie disappears. This
 * is the security-critical path that keeps the extension's access tied to the
 * user's BMP login; it must fire on a real logout and must NOT fire spuriously.
 */
import { describe, it, expect, vi } from 'vitest';
import { mockChromeStorage } from './chrome-mock';
import { ObjectCache } from '../object-cache';
import { sessionTokenKey } from '../bmp-auth';
import type { InspectorSettings, ServerProfile, AuthMode } from '../types';

function cookieInfo(opts: { cause: string; removed: boolean; name?: string }): chrome.cookies.CookieChangeInfo {
  return {
    removed: opts.removed,
    cause: opts.cause,
    cookie: {
      name: opts.name ?? 'JSESSIONID', value: 'x', domain: 'bmp.test', path: '/Workspace',
      hostOnly: true, secure: true, httpOnly: true, sameSite: 'lax', session: true, storeId: '0',
    },
  } as unknown as chrome.cookies.CookieChangeInfo;
}

async function setup(opts: { authMode: AuthMode; cookieStillPresent: boolean }) {
  vi.resetModules();
  vi.clearAllMocks();
  mockChromeStorage();
  if (!('navigator' in globalThis)) (globalThis as any).navigator = { onLine: true };
  else (globalThis as any).navigator.onLine = true;
  (globalThis.chrome as any).cookies = {
    get: vi.fn(async () => (opts.cookieStillPresent ? { name: 'JSESSIONID', value: 'x' } : null)),
  };

  const profile: ServerProfile = {
    id: 'p1', label: 'P1', bmpUrl: 'https://bmp.test/Workspace/',
    bmpUser: opts.authMode === 'session' ? '' : 'admin',
    bmpPass: opts.authMode === 'session' ? '' : 'pass',
    authMode: opts.authMode,
  };
  const settings: InspectorSettings = {
    schemaVersion: 2, profiles: [profile], activeProfileId: 'p1',
    autoDetect: true, saveTarget: 'instance', enrichMode: 'all',
  };
  const ctx = {
    client: null, hasPanel: false, settings, cache: new ObjectCache(),
    settingsReady: Promise.resolve(),
    logActivity: vi.fn(), sendToPanel: vi.fn(), broadcastToContent: vi.fn(),
    panelPortByWindow: new Map(), contentPorts: new Map(),
  };
  (await import('../sw-context')).setSwContext(ctx as any);
  const settingsMod = await import('../settings');
  return { settingsMod, removeSpy: chrome.storage.session.remove as any };
}

const KEY = sessionTokenKey('p1');

describe('handleSessionCookieRemoved', () => {
  it('tears down a session-mode profile when its cookie is gone (explicit logout)', async () => {
    const { settingsMod, removeSpy } = await setup({ authMode: 'session', cookieStillPresent: false });
    await settingsMod.handleSessionCookieRemoved(cookieInfo({ removed: true, cause: 'explicit' }));
    expect(removeSpy).toHaveBeenCalledWith(KEY);
  });

  it('tears down on true expiry too', async () => {
    const { settingsMod, removeSpy } = await setup({ authMode: 'session', cookieStillPresent: false });
    await settingsMod.handleSessionCookieRemoved(cookieInfo({ removed: true, cause: 'expired' }));
    expect(removeSpy).toHaveBeenCalledWith(KEY);
  });

  it('does NOT tear down on overwrite/expired_overwrite/evicted (cookie refresh, not logout)', async () => {
    for (const cause of ['overwrite', 'expired_overwrite', 'evicted']) {
      const { settingsMod, removeSpy } = await setup({ authMode: 'session', cookieStillPresent: false });
      await settingsMod.handleSessionCookieRemoved(cookieInfo({ removed: true, cause }));
      expect(removeSpy).not.toHaveBeenCalledWith(KEY);
    }
  });

  it('does NOT tear down when the cookie is still present (re-probe guards path/host collisions)', async () => {
    const { settingsMod, removeSpy } = await setup({ authMode: 'session', cookieStillPresent: true });
    await settingsMod.handleSessionCookieRemoved(cookieInfo({ removed: true, cause: 'explicit' }));
    expect(removeSpy).not.toHaveBeenCalledWith(KEY);
  });

  it('ignores non-JSESSIONID cookies and add events', async () => {
    const { settingsMod, removeSpy } = await setup({ authMode: 'session', cookieStillPresent: false });
    await settingsMod.handleSessionCookieRemoved(cookieInfo({ removed: true, cause: 'explicit', name: 'other' }));
    await settingsMod.handleSessionCookieRemoved(cookieInfo({ removed: false, cause: 'explicit' }));
    expect(removeSpy).not.toHaveBeenCalledWith(KEY);
  });

  it('leaves a password-mode profile alone (it holds its own credentials)', async () => {
    const { settingsMod, removeSpy } = await setup({ authMode: 'password', cookieStillPresent: false });
    await settingsMod.handleSessionCookieRemoved(cookieInfo({ removed: true, cause: 'explicit' }));
    expect(removeSpy).not.toHaveBeenCalledWith(KEY);
  });
});
