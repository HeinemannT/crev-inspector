/**
 * Tests for the BmpAuth strategy chain: session-first ordering, password
 * fallback (including the no-config-access case that must NOT abort the chain),
 * the surfaced `via`, and the failure surfaced when every strategy is exhausted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockChromeStorage } from './chrome-mock';

// Knobs the fetch/cookie mocks read.
let cookiePresent = true;
let browserSessionHasAccess = true; // does the borrowed session yield an auth code?
let passwordPosted = false;          // flips once /cs/authentication is POSTed
let csAuthCalls = 0;

beforeEach(() => {
  mockChromeStorage();
  cookiePresent = true;
  browserSessionHasAccess = true;
  passwordPosted = false;
  csAuthCalls = 0;

  (globalThis.chrome as any).cookies = {
    get: vi.fn(async () => (cookiePresent ? { name: 'JSESSIONID', value: 'sess' } : null)),
  };

  globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
    const u = typeof url === 'string' ? url : url.toString();

    if (u.includes('cs/authentication')) {
      csAuthCalls++;
      passwordPosted = true; // now the workspace session is the credentialed user
      return { ok: true, status: 200, type: 'basic',
        headers: { getSetCookie: () => [], get: () => null } as any,
        text: async () => JSON.stringify({ userId: 'admin' }),
        json: async () => ({ userId: 'admin' }) } as any;
    }
    if (u.includes('graphql')) {
      // The credentialed session always has access; the borrowed one depends
      // on the knob. No code (200) === logged in but no Configuration Access.
      const hasAccess = passwordPosted || browserSessionHasAccess;
      return { ok: true, status: 200,
        json: async () => ({ data: { authorizationCode: hasAccess ? { code: 'code-1' } : null }, errors: [] }) } as any;
    }
    if (u.includes('cstoken')) {
      return { ok: true, status: 200,
        json: async () => ({ accessToken: 'jwt-1', refreshToken: 'rt-1' }) } as any;
    }
    return { ok: false, status: 404, text: async () => '' } as any;
  });
});

async function BmpAuth() {
  return (await import('../bmp-auth')).BmpAuth;
}

describe('BmpAuth strategy chain', () => {
  it('session-first: a usable browser session wins and the password is never POSTed', async () => {
    const A = await BmpAuth();
    const auth = new A('https://bmp.test/', 'admin', 'pass', 'p1', 'auto');
    const jwt = await auth.login();
    expect(jwt).toBe('jwt-1');
    expect(auth.via).toBe('session');
    expect(csAuthCalls).toBe(0); // never touched the password path
  });

  it('auto: a borrowed session lacking Configuration Access falls back to the password', async () => {
    browserSessionHasAccess = false; // logged into BMP as a no-access user
    const A = await BmpAuth();
    const auth = new A('https://bmp.test/', 'admin', 'pass', 'p2', 'auto');
    const jwt = await auth.login();
    expect(jwt).toBe('jwt-1');
    expect(auth.via).toBe('password'); // fell through to credentials
    expect(csAuthCalls).toBe(1);
  });

  it('auto with no browser session at all uses the password', async () => {
    cookiePresent = false;
    const A = await BmpAuth();
    const auth = new A('https://bmp.test/', 'admin', 'pass', 'p3', 'auto');
    expect(await auth.login()).toBe('jwt-1');
    expect(auth.via).toBe('password');
  });

  it('session-only: no fallback — a no-access session surfaces no-config-access', async () => {
    browserSessionHasAccess = false;
    const A = await BmpAuth();
    const auth = new A('https://bmp.test/', '', '', 'p4', 'session');
    await expect(auth.login()).rejects.toMatchObject({ code: 'no-config-access' });
    expect(csAuthCalls).toBe(0); // no credentials to fall back to
  });

  it('session-only with no session surfaces needs-login', async () => {
    cookiePresent = false;
    const A = await BmpAuth();
    const auth = new A('https://bmp.test/', '', '', 'p5', 'session');
    await expect(auth.login()).rejects.toMatchObject({ code: 'needs-login' });
  });
});
