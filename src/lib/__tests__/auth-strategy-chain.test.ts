/**
 * Tests for the BmpAuth strategy chain: session-first ordering, password
 * fallback (including the no-config-access case that must NOT abort the chain),
 * the surfaced `via`, and the failure surfaced when every strategy is exhausted.
 *
 * There is NO cookie precheck — the session strategy tries the token exchange and
 * lets the graphql response classify the session (401 / SSO redirect / HTML → no
 * session; empty code → no Configuration Access; code → win). So these tests drive
 * the outcome entirely through the mocked graphql response, and deliberately run
 * without any `chrome.cookies` mock to prove the auth path no longer depends on it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockChromeStorage } from './chrome-mock';

// What the BORROWED browser session yields from /graphql (before any password login).
type Borrowed = 'code' | 'no-access' | 'none' | 'redirect' | 'html';
let borrowed: Borrowed = 'code';
let passwordPosted = false;   // flips once /cs/authentication is POSTed
let csAuthCalls = 0;

// A normal, access-granted graphql response (also what a fresh password session returns).
const okCode = () => ({ ok: true, status: 200, redirected: false, url: 'https://bmp.test/graphql',
  json: async () => ({ data: { authorizationCode: { code: 'code-1' } }, errors: [] }) } as any);

beforeEach(() => {
  mockChromeStorage();
  borrowed = 'code';
  passwordPosted = false;
  csAuthCalls = 0;
  // Intentionally NO chrome.cookies mock — the auth path must not touch it.

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
      // A password login establishes a fresh, access-granted session.
      if (passwordPosted) return okCode();
      // Otherwise the BORROWED session's outcome is what the knob says.
      switch (borrowed) {
        case 'none':      // no session → graphql 401
          return { ok: false, status: 401, redirected: false, url: 'https://bmp.test/graphql', json: async () => ({}) } as any;
        case 'redirect':  // SSO: /graphql 302s to the IdP; fetch chased it to an HTML page
          return { ok: true, status: 200, redirected: true, url: 'https://idp.example/login',
            text: async () => '<html>login</html>', json: async () => { throw new Error('not json'); } } as any;
        case 'html':      // SSO: 200 HTML interstitial in place, no redirect
          return { ok: true, status: 200, redirected: false, url: 'https://bmp.test/graphql',
            text: async () => '<html>sso</html>', json: async () => { throw new Error('not json'); } } as any;
        case 'no-access': // logged in, but the provider returned no code
          return { ok: true, status: 200, redirected: false, url: 'https://bmp.test/graphql',
            json: async () => ({ data: { authorizationCode: null }, errors: [] }) } as any;
        case 'code':
        default:
          return okCode();
      }
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

  it('no cookie inspection: the session is borrowed with no chrome.cookies present', async () => {
    expect((globalThis.chrome as any).cookies).toBeUndefined(); // guard: nothing mocked cookies
    const A = await BmpAuth();
    const auth = new A('https://bmp.test/', 'admin', 'pass', 'p1b', 'auto');
    expect(await auth.login()).toBe('jwt-1');
    expect(auth.via).toBe('session'); // exchange succeeded without ever reading a cookie
  });

  it('auto: a borrowed session lacking Configuration Access falls back to the password', async () => {
    borrowed = 'no-access'; // logged into BMP as a no-access user
    const A = await BmpAuth();
    const auth = new A('https://bmp.test/', 'admin', 'pass', 'p2', 'auto');
    const jwt = await auth.login();
    expect(jwt).toBe('jwt-1');
    expect(auth.via).toBe('password'); // fell through to credentials
    expect(csAuthCalls).toBe(1);
  });

  it('auto with no browser session at all uses the password', async () => {
    borrowed = 'none';
    const A = await BmpAuth();
    const auth = new A('https://bmp.test/', 'admin', 'pass', 'p3', 'auto');
    expect(await auth.login()).toBe('jwt-1');
    expect(auth.via).toBe('password');
  });

  it('session-only: no fallback — a no-access session surfaces no-config-access', async () => {
    borrowed = 'no-access';
    const A = await BmpAuth();
    const auth = new A('https://bmp.test/', '', '', 'p4', 'session');
    await expect(auth.login()).rejects.toMatchObject({ code: 'no-config-access' });
    expect(csAuthCalls).toBe(0); // no credentials to fall back to
  });

  it('session-only with no session surfaces needs-login', async () => {
    borrowed = 'none';
    const A = await BmpAuth();
    const auth = new A('https://bmp.test/', '', '', 'p5', 'session');
    await expect(auth.login()).rejects.toMatchObject({ code: 'needs-login' });
  });

  // --- SSO robustness: a graphql redirect / HTML interstitial is "no session"
  // (fall through), never a false no-config-access. ---

  it('SSO: a /graphql redirect to the IdP reads as needs-login, not no-config-access', async () => {
    borrowed = 'redirect';
    const A = await BmpAuth();
    const auth = new A('https://bmp.test/', '', '', 'sso1', 'session'); // session-only, no creds
    await expect(auth.login()).rejects.toMatchObject({ code: 'needs-login' });
  });

  it('SSO: an in-place HTML 200 (no redirect) also reads as needs-login', async () => {
    borrowed = 'html';
    const A = await BmpAuth();
    const auth = new A('https://bmp.test/', '', '', 'sso2', 'session');
    await expect(auth.login()).rejects.toMatchObject({ code: 'needs-login' });
  });

  it('SSO: an IdP redirect on the borrowed session falls through to the password', async () => {
    borrowed = 'redirect'; // the borrowed-session exchange bounces to the IdP...
    const A = await BmpAuth();
    const auth = new A('https://bmp.test/', 'admin', 'pass', 'sso3', 'auto');
    const jwt = await auth.login();
    expect(jwt).toBe('jwt-1');
    expect(auth.via).toBe('password'); // ...so the chain used credentials
    expect(csAuthCalls).toBe(1);
  });
});
