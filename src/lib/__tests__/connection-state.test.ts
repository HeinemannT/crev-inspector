/**
 * Tests for src/lib/connection.ts — ConnectionState display computation.
 *
 * connection.ts owns module-level state (healthUp, authResult, healthVersion,
 * networkOffline) that's mutated by pollHealth() + runAuthTest() and read
 * by computeConnectionState(). The truth table comes from connection.ts:68-74
 * (the live source of truth — ARCHITECTURE.md is out of date).
 *
 * We exercise the truth table by mocking BmpClient static helpers + per-instance
 * auth, then driving state through the public functions and asserting against
 * computeConnectionState().display.
 *
 * Each test calls vi.resetModules() so module-level state starts fresh.
 */
import { describe, it, expect, vi } from 'vitest';
import { mockChromeStorage } from './chrome-mock';
import { ObjectCache } from '../object-cache';
import type { InspectorSettings } from '../types';
import type { AuthErrorCode, AuthVia } from '../bmp-auth';

type TestConn = { ok: boolean; message: string; authenticated: boolean; code?: AuthErrorCode; via?: AuthVia };

interface ConnHarness {
  ctx: any;
  conn: typeof import('../connection');
  setHealthResult: (r: { up: boolean; reachable: boolean; responseMs?: number }) => void;
  setBuildNumber: (v: string | null) => void;
  setTestConnection: (r: TestConn) => void;
  setNavigatorOnline: (online: boolean) => void;
}

let healthResult = { up: false, reachable: false, responseMs: 0 };
let buildNumber: string | null = null;
let testConnResult: TestConn = { ok: true, message: 'Authenticated', authenticated: true };

async function createHarness(opts: { withProfile?: boolean; withClient?: boolean } = {}): Promise<ConnHarness> {
  vi.resetModules();
  vi.clearAllMocks();
  mockChromeStorage();
  if (!('navigator' in globalThis)) {
    (globalThis as any).navigator = { onLine: true };
  } else {
    (globalThis as any).navigator.onLine = true;
  }

  const withProfile = opts.withProfile !== false;
  const withClient = opts.withClient !== false;

  // Reset call-time state to defaults
  healthResult = { up: false, reachable: false, responseMs: 0 };
  buildNumber = null;
  testConnResult = { ok: true, message: 'Authenticated', authenticated: true };

  // Set up the (now-fresh) sw-context for this test instance
  const swCtxMod = await import('../sw-context');
  const bmpModule = await import('../bmp-client');

  vi.spyOn(bmpModule.BmpClient, 'checkHealth').mockImplementation(async () => ({
    up: healthResult.up,
    reachable: healthResult.reachable,
    responseMs: healthResult.responseMs ?? 0,
  }));
  vi.spyOn(bmpModule.BmpClient, 'getBuildNumber').mockImplementation(async () => buildNumber);

  const client = withClient ? new bmpModule.BmpClient('https://bmp.test/Workspace/', 'admin', 'pass', 'p1') : null;
  if (client) {
    (client as any).auth = {
      ensureAuth: vi.fn(async () => 'mock-jwt'),
      login: vi.fn(async () => 'mock-jwt'),
      logout: vi.fn(),
      invalidateJwt: vi.fn(),
      absorbAuth: vi.fn(),
      refreshAuth: vi.fn(async () => null), // default: refresh fails so full login runs
      jwt: null, // default: no JWT yet
    };
    vi.spyOn(bmpModule.BmpClient.prototype, 'testConnection').mockImplementation(async function (this: any) {
      // BmpAuth.jwt/via are getters — write to the backing fields. `this` is the
      // throwaway testClient (a real BmpClient), so authVia reads back from here.
      if (testConnResult.ok) {
        this.auth._jwt = 'mock-jwt';
        this.auth._via = testConnResult.via ?? 'password';
      }
      return testConnResult;
    });
  }

  const settings: InspectorSettings = withProfile ? {
    schemaVersion: 1,
    profiles: [{ id: 'p1', label: 'P1', bmpUrl: 'https://bmp.test/Workspace/', bmpUser: 'admin', bmpPass: 'pass' }],
    activeProfileId: 'p1',
    autoDetect: true,
    saveTarget: 'instance',
    enrichMode: 'all',
  } : {
    schemaVersion: 1, profiles: [], activeProfileId: '',
    autoDetect: true, saveTarget: 'instance', enrichMode: 'all',
  };

  const ctx = {
    client,
    hasPanel: false,
    panelPortByWindow: new Map(),
    contentPorts: new Map(),
    cache: new ObjectCache(),
    settings,
    inspectActive: false,
    technicalOverlay: false,
    settingsReady: Promise.resolve(),
    logActivity: vi.fn(),
    sendToPanel: vi.fn(),
    sendToPanelByWindow: vi.fn(),
    sendToPanelByTab: vi.fn(),
    broadcastToContent: vi.fn(),
    toast: vi.fn(),
  };
  swCtxMod.setSwContext(ctx as any);

  const conn = await import('../connection');
  conn.resetConnectionState();

  return {
    ctx,
    conn,
    setHealthResult: (r) => { healthResult = { responseMs: 0, ...r }; },
    setBuildNumber: (v) => { buildNumber = v; },
    setTestConnection: (r) => { testConnResult = r; },
    setNavigatorOnline: (online) => { (globalThis as any).navigator.onLine = online; },
  };
}

describe('computeConnectionState — initial states', () => {
  it('no profile → not-configured', async () => {
    const h = await createHarness({ withProfile: false });
    const state = h.conn.computeConnectionState();
    expect(state.display).toBe('not-configured');
    expect(state.user).toBeNull();
    expect(state.profileLabel).toBeNull();
  });

  it('profile but no health/auth probes yet → checking', async () => {
    const h = await createHarness();
    const state = h.conn.computeConnectionState();
    expect(state.display).toBe('checking');
    expect(state.profileLabel).toBe('P1');
  });
});

describe('computeConnectionState — auth result precedence', () => {
  it('authResult=ok dominates: returns connected even if health unknown', async () => {
    const h = await createHarness();
    h.setTestConnection({ ok: true, message: 'OK', authenticated: true });
    await h.conn.runAuthTest();

    const state = h.conn.computeConnectionState();
    expect(state.display).toBe('connected');
    expect(state.user).toBe('admin');
  });

  it('authResult=ok + healthUp=up: still connected', async () => {
    const h = await createHarness();
    h.setTestConnection({ ok: true, message: 'OK', authenticated: true });
    h.setHealthResult({ up: true, reachable: true });
    await h.conn.runAuthTest();
    await h.conn.pollHealth();

    expect(h.conn.computeConnectionState().display).toBe('connected');
  });

  it('authResult=failed + healthUp=unreachable: returns unreachable (not auth-failed)', async () => {
    const h = await createHarness();
    h.setTestConnection({ ok: false, message: 'cannot reach', authenticated: false });
    h.setHealthResult({ up: false, reachable: false });
    h.setNavigatorOnline(true);
    await h.conn.runAuthTest();
    await h.conn.pollHealth();

    expect(h.conn.computeConnectionState().display).toBe('unreachable');
  });

  it('authResult=failed + healthUp=up: returns auth-failed', async () => {
    const h = await createHarness();
    h.setTestConnection({ ok: false, message: 'bad credentials', authenticated: false });
    h.setHealthResult({ up: true, reachable: true });
    await h.conn.runAuthTest();
    await h.conn.pollHealth();

    const state = h.conn.computeConnectionState();
    expect(state.display).toBe('auth-failed');
    expect(state.authError).toBe('bad credentials');
  });

  it('authResult=failed + healthUp=down: returns auth-failed (auth failure trumps server-down)', async () => {
    const h = await createHarness();
    h.setTestConnection({ ok: false, message: 'bad credentials', authenticated: false });
    h.setHealthResult({ up: false, reachable: true });
    await h.conn.runAuthTest();
    await h.conn.pollHealth();

    // Per connection.ts:70: failed + (healthUp != unreachable) → auth-failed
    expect(h.conn.computeConnectionState().display).toBe('auth-failed');
  });
});

describe('computeConnectionState — session-piggyback states + authVia', () => {
  it('failed + code needs-login + health up → needs-login', async () => {
    const h = await createHarness();
    h.setTestConnection({ ok: false, message: 'no session', authenticated: false, code: 'needs-login' });
    h.setHealthResult({ up: true, reachable: true });
    await h.conn.runAuthTest();
    await h.conn.pollHealth();
    expect(h.conn.computeConnectionState().display).toBe('needs-login');
  });

  it('failed + code no-config-access + health up → no-config-access', async () => {
    const h = await createHarness();
    h.setTestConnection({ ok: false, message: 'no role', authenticated: false, code: 'no-config-access' });
    h.setHealthResult({ up: true, reachable: true });
    await h.conn.runAuthTest();
    await h.conn.pollHealth();
    expect(h.conn.computeConnectionState().display).toBe('no-config-access');
  });

  it('health unreachable overrides a needs-login auth code', async () => {
    const h = await createHarness();
    h.setTestConnection({ ok: false, message: 'no session', authenticated: false, code: 'needs-login' });
    h.setHealthResult({ up: false, reachable: false });
    h.setNavigatorOnline(true);
    await h.conn.runAuthTest();
    await h.conn.pollHealth();
    expect(h.conn.computeConnectionState().display).toBe('unreachable');
  });

  it('connected via session surfaces authVia=session; via=password when bootstrapped', async () => {
    const h = await createHarness();
    h.setTestConnection({ ok: true, message: 'OK', authenticated: true, via: 'session' });
    await h.conn.runAuthTest();
    expect(h.conn.computeConnectionState().authVia).toBe('session');

    const h2 = await createHarness();
    h2.setTestConnection({ ok: true, message: 'OK', authenticated: true, via: 'password' });
    await h2.conn.runAuthTest();
    expect(h2.conn.computeConnectionState().authVia).toBe('password');
  });

  it('authVia is null when not connected', async () => {
    const h = await createHarness();
    h.setTestConnection({ ok: false, message: 'no role', authenticated: false, code: 'no-config-access' });
    h.setHealthResult({ up: true, reachable: true });
    await h.conn.runAuthTest();
    await h.conn.pollHealth();
    expect(h.conn.computeConnectionState().authVia).toBeNull();
  });
});

describe('computeConnectionState — health-only states (auth pending)', () => {
  it('healthUp=unreachable + authResult=pending → unreachable', async () => {
    const h = await createHarness();
    h.setHealthResult({ up: false, reachable: false });
    await h.conn.pollHealth();
    expect(h.conn.computeConnectionState().display).toBe('unreachable');
  });

  it('healthUp=up + authResult=pending → online', async () => {
    const h = await createHarness();
    h.setHealthResult({ up: true, reachable: true });
    await h.conn.pollHealth();
    expect(h.conn.computeConnectionState().display).toBe('online');
  });

  it('healthUp=down + authResult=pending → server-down', async () => {
    const h = await createHarness();
    h.setHealthResult({ up: false, reachable: true });
    await h.conn.pollHealth();
    expect(h.conn.computeConnectionState().display).toBe('server-down');
  });

  it('navigator.onLine=false → unreachable (networkOffline=true)', async () => {
    const h = await createHarness();
    h.setNavigatorOnline(false);
    await h.conn.pollHealth();

    const state = h.conn.computeConnectionState();
    expect(state.display).toBe('unreachable');
    expect(state.networkOffline).toBe(true);
  });
});

describe('computeConnectionState — workspace extraction', () => {
  it('extracts workspace name from BMP URL', async () => {
    const h = await createHarness();
    const state = h.conn.computeConnectionState();
    expect(state.workspace).toBe('Workspace');
  });
});

describe('resetConnectionState — clears stale state', () => {
  it('after auth ok, resetConnectionState() returns display to checking', async () => {
    const h = await createHarness();
    h.setTestConnection({ ok: true, message: 'OK', authenticated: true });
    await h.conn.runAuthTest();
    expect(h.conn.computeConnectionState().display).toBe('connected');

    h.conn.resetConnectionState();
    expect(h.conn.computeConnectionState().display).toBe('checking');
  });

  it('reset clears supportsLookup on the client (re-detected on next poll)', async () => {
    const h = await createHarness();
    h.setHealthResult({ up: true, reachable: true });
    h.setBuildNumber('5.6.7.2');
    await h.conn.pollHealth();
    // After health probe with version, client.supportsLookup is set (5.6.7.2 >= 5.6.3 → true)
    expect(h.ctx.client.supportsLookup).toBe(true);

    h.conn.resetConnectionState();
    expect(h.ctx.client.supportsLookup).toBeNull();
  });
});

describe('normalizeUrl', () => {
  it('adds https:// scheme when missing and trailing slash', async () => {
    const h = await createHarness();
    expect(h.conn.normalizeUrl('bmp.test/Workspace')).toBe('https://bmp.test/Workspace/');
    expect(h.conn.normalizeUrl('http://bmp.test/x')).toBe('http://bmp.test/x/');
    expect(h.conn.normalizeUrl('  https://x.test/y/  ')).toBe('https://x.test/y/');
  });
});
