/**
 * Tests for the BmpAuth login mutex.
 * Validates: concurrent login dedup, failure clears promise, logout clears promise.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockChromeStorage } from './chrome-mock';

// We test BmpAuth directly — mock fetch at the global level
let fetchCallCount = 0;
let fetchShouldFail = false;

beforeEach(() => {
  mockChromeStorage();
  fetchCallCount = 0;
  fetchShouldFail = false;

  // Mock fetch: simulates the 3-step auth flow
  globalThis.fetch = vi.fn(async (url: string | URL | Request) => {
    fetchCallCount++;
    const urlStr = typeof url === 'string' ? url : url.toString();

    if (fetchShouldFail) {
      return { ok: false, status: 500, text: async () => '{}', json: async () => ({}), headers: new Headers(), type: 'basic' } as Response;
    }

    // Step 1: /cs/authentication
    if (urlStr.includes('cs/authentication')) {
      return {
        ok: true, status: 200, type: 'basic',
        headers: { getSetCookie: () => [], get: () => null } as any,
        text: async () => JSON.stringify({ userId: 'u1' }),
        json: async () => ({ userId: 'u1' }),
      } as any;
    }
    // Step 2: /graphql
    if (urlStr.includes('graphql')) {
      return {
        ok: true, status: 200,
        json: async () => ({ data: { authorizationCode: { code: 'auth-code-123' } } }),
      } as any;
    }
    // Step 3: /cstoken
    if (urlStr.includes('cstoken')) {
      return {
        ok: true, status: 200,
        json: async () => ({ accessToken: 'jwt-token-abc', refreshToken: 'rt-123' }),
      } as any;
    }
    return { ok: false, status: 404, text: async () => '' } as any;
  });
});

// Dynamic import to ensure mocks are in place
async function getBmpAuth() {
  const mod = await import('../bmp-auth');
  return mod.BmpAuth;
}

describe('BmpAuth login mutex', () => {
  it('4 concurrent login() calls produce only 1 fetch sequence (3 fetches)', async () => {
    const BmpAuth = await getBmpAuth();
    const auth = new BmpAuth('https://bmp.test/', 'admin', 'pass');

    const results = await Promise.all([
      auth.login(),
      auth.login(),
      auth.login(),
      auth.login(),
    ]);

    // All 4 should resolve to the same JWT
    for (const jwt of results) {
      expect(jwt).toBe('jwt-token-abc');
    }

    // Only 3 fetch calls (auth + graphql + cstoken), NOT 12
    expect(fetchCallCount).toBe(3);
  });

  it('failed login clears promise so next call retries', async () => {
    const BmpAuth = await getBmpAuth();
    const auth = new BmpAuth('https://bmp.test/', 'admin', 'pass');

    fetchShouldFail = true;
    const p1 = auth.login().catch(e => e);
    const p2 = auth.login().catch(e => e);

    const [r1, r2] = await Promise.all([p1, p2]);
    // Both get the same error (same underlying promise)
    expect(r1).toBeInstanceOf(Error);
    expect(r2).toBeInstanceOf(Error);

    // Now succeed — should start a fresh login
    fetchShouldFail = false;
    fetchCallCount = 0;
    const jwt = await auth.login();
    expect(jwt).toBe('jwt-token-abc');
    expect(fetchCallCount).toBe(3); // fresh 3-step flow
  });

  it('4 concurrent refreshAuth() calls produce only 1 fetch to /cstoken', async () => {
    const BmpAuth = await getBmpAuth();
    const auth = new BmpAuth('https://bmp.test/', 'admin', 'pass');

    // First, do a full login to populate refresh token
    await auth.login();
    fetchCallCount = 0;

    // Now 4 concurrent refreshAuth calls
    const results = await Promise.all([
      auth.refreshAuth(),
      auth.refreshAuth(),
      auth.refreshAuth(),
      auth.refreshAuth(),
    ]);

    // All 4 should get the same result
    for (const jwt of results) {
      expect(jwt).toBe('jwt-token-abc');
    }

    // Only 1 fetch call to /cstoken, NOT 4
    expect(fetchCallCount).toBe(1);
  });

  it('failed refreshAuth clears promise so next call retries', async () => {
    const BmpAuth = await getBmpAuth();
    const auth = new BmpAuth('https://bmp.test/', 'admin', 'pass');

    // Login first to get refresh token
    await auth.login();
    fetchCallCount = 0;

    // Make refresh fail
    fetchShouldFail = true;
    const r1 = await auth.refreshAuth();
    expect(r1).toBeNull();

    // Next call should try again (promise cleared)
    fetchShouldFail = false;
    fetchCallCount = 0;
    const r2 = await auth.refreshAuth();
    expect(r2).toBe('jwt-token-abc');
    expect(fetchCallCount).toBe(1);
  });

  it('logout() clears in-flight promise', async () => {
    const BmpAuth = await getBmpAuth();
    const auth = new BmpAuth('https://bmp.test/', 'admin', 'pass');

    // Start login
    const p1 = auth.login();
    // Logout while in flight
    auth.logout();

    // The original promise still resolves (already in flight)
    await p1.catch(() => {});

    // But a new login() should start fresh
    fetchCallCount = 0;
    const jwt = await auth.login();
    expect(jwt).toBe('jwt-token-abc');
    expect(fetchCallCount).toBe(3);
  });
});
