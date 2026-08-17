/**
 * Tests for src/lib/connection.ts — ConnectionState display computation.
 *
 * connection.ts owns module-level state (healthUp, authResult, healthVersion,
 * networkOffline) that's mutated by pollHealth() + runAuthTest() and read
 * by computeConnectionState(). The truth table comes from connection.ts:68-74
 * (the live source of truth for connection behavior).
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
import type { AuthErrorCode } from '../bmp-auth';

type TestConn = { ok: boolean; message: string; authenticated: boolean; code?: AuthErrorCode };

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
    const fakeAuth: any = {
      ensureAuth: vi.fn(async () => 'mock-jwt'),
      login: vi.fn(async () => 'mock-jwt'),
      invalidateLoginTicket: vi.fn(),
      refreshLoginTicket: vi.fn(async () => 'mock-ticket'),
      recoverAuth: vi.fn(async () => 'mock-jwt'),
      absorbAuth: vi.fn(),
      refreshAuth: vi.fn(async () => null), // default: refresh fails so full login runs
      jwt: null, // default: no JWT yet
      commandUser: 'admin',
      portalActor: null,
    };
    fakeAuth.logout = vi.fn(() => { fakeAuth.portalActor = null; });
    fakeAuth.bindPortalActor = vi.fn((actor: string) => { fakeAuth.portalActor = actor; });
    (client as any).auth = fakeAuth;
    vi.spyOn(bmpModule.BmpClient.prototype, 'testConnection').mockImplementation(async function (this: any) {
      // BmpAuth.jwt/via are getters — write to the backing fields. `this` is the
      // Mark the throwaway test client as authenticated.
      if (testConnResult.ok) {
        this.auth._jwt = 'mock-jwt';
      }
      return testConnResult;
    });
  }

  const settings: InspectorSettings = withProfile ? {
    schemaVersion: 1,
    profiles: [{ id: 'p1', label: 'P1', bmpUrl: 'https://bmp.test/Workspace/', bmpUser: 'admin', bmpPass: 'pass', commandAuthMode: 'portal' }],
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
    expect(state.identities.command.user).toBeNull();
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
    expect(state.identities.command.user).toBe('admin');
  });

  it('authResult=ok + healthUp=up: still connected', async () => {
    const h = await createHarness();
    h.setTestConnection({ ok: true, message: 'OK', authenticated: true });
    h.setHealthResult({ up: true, reachable: true });
    await h.conn.runAuthTest();
    await h.conn.pollHealth();

    expect(h.conn.computeConnectionState().display).toBe('connected');
  });

  it('a later unreachable health result overrides an earlier successful command probe', async () => {
    const h = await createHarness();
    h.setTestConnection({ ok: true, message: 'OK', authenticated: true });
    await h.conn.runAuthTest();
    expect(h.conn.computeConnectionState().display).toBe('connected');

    h.setHealthResult({ up: false, reachable: false });
    await h.conn.pollHealth();
    expect(h.conn.computeConnectionState().display).toBe('unreachable');
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

  it('health down overrides an earlier auth failure', async () => {
    const h = await createHarness();
    h.setTestConnection({ ok: false, message: 'bad credentials', authenticated: false });
    h.setHealthResult({ up: false, reachable: true });
    await h.conn.runAuthTest();
    await h.conn.pollHealth();

    expect(h.conn.computeConnectionState().display).toBe('server-down');
  });
});

describe('command outcome observation', () => {
  it('records only BMP requests that cross a load-pressure threshold', async () => {
    const h = await createHarness();
    let observer: ((outcome: any) => void) | null = null;
    vi.spyOn(h.ctx.client, 'setTransportOutcomeObserver').mockImplementation((fn: any) => { observer = fn; });
    h.conn.bindConnectionClient(h.ctx.client, 'p1');

    observer!({
      ok: true,
      intent: 'read',
      operation: 'ExtendedExecuteCommand',
      commandCount: 1,
      queueDepth: 2,
      queueWaitMs: 2_500,
      durationMs: 500,
      requestBytes: 800,
      responseBytes: 1_200,
      attempts: 1,
    });

    expect(h.ctx.logActivity).toHaveBeenCalledWith(
      'warn',
      'BMP ExtendedExecuteCommand completed under load',
      expect.stringContaining('queue 2500ms (depth 2)'),
    );
  });

  it('downgrades on an active-client network failure and recovers on command success', async () => {
    const h = await createHarness();
    let observer: ((outcome: any) => void) | null = null;
    vi.spyOn(h.ctx.client, 'setTransportOutcomeObserver').mockImplementation((fn: any) => { observer = fn; });
    h.conn.bindConnectionClient(h.ctx.client, 'p1');

    h.setTestConnection({ ok: true, message: 'OK', authenticated: true });
    await h.conn.runAuthTest();
    expect(h.conn.computeConnectionState().display).toBe('connected');
    const before = h.ctx.broadcastToContent.mock.calls.filter(([m]: any[]) => m.type === 'RE_ENRICH').length;

    observer!({ ok: false, intent: 'read', error: { kind: 'network', message: 'socket closed' } });
    expect(h.conn.computeConnectionState().display).toBe('command-failed');
    expect(h.conn.computeConnectionState().authError).toBe('socket closed');

    observer!({ ok: true, intent: 'read' });
    expect(h.conn.computeConnectionState().display).toBe('connected');
    const after = h.ctx.broadcastToContent.mock.calls.filter(([m]: any[]) => m.type === 'RE_ENRICH').length;
    expect(after).toBe(before + 1);
  });

  it('does not downgrade for permission denials or outcomes from an inactive client', async () => {
    const h = await createHarness();
    let observer: ((outcome: any) => void) | null = null;
    vi.spyOn(h.ctx.client, 'setTransportOutcomeObserver').mockImplementation((fn: any) => { observer = fn; });
    h.conn.bindConnectionClient(h.ctx.client, 'p1');
    h.setTestConnection({ ok: true, message: 'OK', authenticated: true });
    await h.conn.runAuthTest();

    observer!({ ok: false, intent: 'read', error: { kind: 'permission', message: 'denied', status: 403 } });
    expect(h.conn.computeConnectionState().display).toBe('connected');

    observer!({ ok: false, intent: 'read', error: { kind: 'cancelled', message: 'caller stopped' } });
    expect(h.conn.computeConnectionState().display).toBe('connected');

    h.ctx.client = {} as any;
    observer!({ ok: false, intent: 'read', error: { kind: 'network', message: 'late failure' } });
    expect(h.conn.computeConnectionState().display).toBe('connected');
  });
});

describe('computeConnectionState — explicit command identity', () => {
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

  it('connected portal mode surfaces the verified command actor', async () => {
    const h = await createHarness();
    h.setTestConnection({ ok: true, message: 'OK', authenticated: true });
    await h.conn.runAuthTest();
    expect(h.conn.computeConnectionState().identities.command).toMatchObject({
      status: 'connected',
      user: 'admin',
      source: 'portal-session',
    });
  });

  it('does not claim a command actor when auth fails', async () => {
    const h = await createHarness();
    h.setTestConnection({ ok: false, message: 'no role', authenticated: false, code: 'no-config-access' });
    h.setHealthResult({ up: true, reachable: true });
    await h.conn.runAuthTest();
    await h.conn.pollHealth();
    expect(h.conn.computeConnectionState().identities.command.user).toBeNull();
  });

  it('retires a borrowed command ticket after a verified portal logout', async () => {
    const h = await createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false,
      status: 401,
      redirected: false,
      url: 'https://bmp.test/Workspace/cs/authentication',
    } as Response)));
    try {
      h.setTestConnection({ ok: true, message: 'stale ticket still works', authenticated: true });
      await h.conn.runAuthTest();

      expect(h.ctx.client.auth.logout).toHaveBeenCalledTimes(1);
      expect(h.conn.computeConnectionState()).toMatchObject({
        display: 'needs-login',
        identities: {
          portal: { status: 'unavailable', user: null },
          command: { status: 'unavailable', user: null },
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }
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

describe('Blueprint version capability', () => {
  it('assumes lookup support when /buildNum is unavailable', async () => {
    const h = await createHarness();
    h.setHealthResult({ up: true, reachable: true });
    h.setBuildNumber(null);

    await h.conn.pollHealth();

    expect(h.ctx.client.supportsLookup).toBe(true);
    expect(h.conn.computeConnectionState().blueprintSupported).toBe(true);
  });

  it('disables Blueprint for a known pre-5.6.3 version', async () => {
    const h = await createHarness();
    h.setHealthResult({ up: true, reachable: true });
    h.setBuildNumber('5.6.2.9');

    await h.conn.pollHealth();

    expect(h.ctx.client.supportsLookup).toBe(false);
    expect(h.conn.computeConnectionState().blueprintSupported).toBe(false);
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

describe('computeConnectionState — host-permission gate', () => {
  it('no host permission → needs-access (probes skipped, not "unreachable")', async () => {
    const h = await createHarness();
    (globalThis as any).chrome.permissions = { contains: vi.fn(async () => false) };
    await h.conn.pollHealth();
    expect(h.conn.computeConnectionState().display).toBe('needs-access');
  });

  it('host permission granted → probes run (health up → not needs-access)', async () => {
    const h = await createHarness();
    (globalThis as any).chrome.permissions = { contains: vi.fn(async () => true) };
    h.setHealthResult({ up: true, reachable: true });
    await h.conn.pollHealth();
    expect(h.conn.computeConnectionState().display).not.toBe('needs-access');
  });
});

describe('separated reachability and identity lifecycle', () => {
  const portalResponse = (opts: { status?: number; user?: string; redirected?: boolean; url?: string } = {}) => ({
    ok: (opts.status ?? 200) >= 200 && (opts.status ?? 200) < 300,
    status: opts.status ?? 200,
    redirected: opts.redirected ?? false,
    url: opts.url ?? 'https://bmp.test/Workspace/cs/authentication',
    json: async () => opts.user ? { userName: opts.user } : {},
  } as unknown as Response);

  it.each([false, true])('three healthy reachability cycles never re-authenticate or log out (panel=%s)', async (hasPanel) => {
    const h = await createHarness();
    h.ctx.hasPanel = hasPanel;
    vi.stubGlobal('fetch', vi.fn(async () => portalResponse())); // ambiguous successful response, no actor
    try {
      await h.conn.runAuthTest('background');
      expect(h.conn.computeConnectionState().display).toBe('connected');
      h.ctx.client.auth.logout.mockClear();
      vi.mocked(h.ctx.client.testConnection).mockClear();
      h.ctx.logActivity.mockClear();
      h.setHealthResult({ up: true, reachable: true, responseMs: 4 });

      await h.conn.pollHealth(true);
      await h.conn.pollHealth(true);
      await h.conn.pollHealth(true);

      expect(h.ctx.client.auth.logout).not.toHaveBeenCalled();
      expect(h.ctx.client.testConnection).not.toHaveBeenCalled();
      expect(h.ctx.logActivity).not.toHaveBeenCalledWith(expect.anything(), 'Testing command connection…', expect.anything());
      expect(h.ctx.logActivity.mock.calls.flat().join(' ')).not.toMatch(/Connected to/);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('persistent portal/command mismatch reconciles once and health cycles stay pure', async () => {
    const h = await createHarness();
    h.ctx.client.auth.portalActor = 'portal.a';
    h.ctx.client.auth.logout = vi.fn(); // simulate a stubborn chain that remains bound to A
    h.ctx.client.auth.bindPortalActor = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async () => portalResponse({ user: 'portal.b' })));
    try {
      await h.conn.runAuthTest('background');
      expect(h.conn.computeConnectionState().display).toBe('identity-mismatch');
      expect(h.ctx.client.auth.logout).toHaveBeenCalledTimes(1);
      expect(h.ctx.client.testConnection).toHaveBeenCalledTimes(1);

      await h.conn.runAuthTest('background');
      expect(h.ctx.client.auth.logout).toHaveBeenCalledTimes(1);
      h.ctx.client.auth.logout.mockClear();
      vi.mocked(h.ctx.client.testConnection).mockClear();
      h.setHealthResult({ up: true, reachable: true });
      await h.conn.pollHealth(true);
      await h.conn.pollHealth(true);
      expect(h.ctx.client.auth.logout).not.toHaveBeenCalled();
      expect(h.ctx.client.testConnection).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('authoritative sign-out invalidates a borrowed chain once', async () => {
    const h = await createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => portalResponse({ status: 401 })));
    try {
      await h.conn.runAuthTest('background');
      await h.conn.runAuthTest('background');
      expect(h.ctx.client.auth.logout).toHaveBeenCalledTimes(1);
      expect(h.conn.computeConnectionState().display).toBe('needs-login');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('a confirmed actor A-to-B transition performs one reconcile and adopts B', async () => {
    const h = await createHarness();
    h.ctx.client.auth.portalActor = 'portal.a';
    vi.stubGlobal('fetch', vi.fn(async () => portalResponse({ user: 'portal.b' })));
    vi.mocked(h.ctx.client.testConnection).mockImplementation(async function (this: any) {
      this.auth.commandUser = 'admin';
      return { ok: true, authenticated: true, message: 'OK' };
    });
    try {
      await h.conn.runAuthTest('background');
      expect(h.ctx.client.auth.logout).toHaveBeenCalledTimes(1);
      expect(h.ctx.client.testConnection).toHaveBeenCalledTimes(1);
      expect(h.conn.computeConnectionState()).toMatchObject({
        display: 'connected', identities: { portal: { user: 'portal.b' }, command: { user: 'admin' }, sameUser: true },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('retires a command chain when the portal actor changes during login', async () => {
    const h = await createHarness();
    h.ctx.client.auth.portalActor = 'portal.a';
    const actors = ['portal.b', 'portal.c'];
    vi.stubGlobal('fetch', vi.fn(async () => portalResponse({ user: actors.shift() ?? 'portal.c' })));
    vi.mocked(h.ctx.client.testConnection).mockImplementation(async function (this: any) {
      this.auth.commandUser = 'admin';
      return { ok: true, authenticated: true, message: 'OK' };
    });
    try {
      await h.conn.runAuthTest('background');

      expect(h.ctx.client.auth.logout).toHaveBeenCalledTimes(2);
      expect(h.ctx.client.auth.bindPortalActor).not.toHaveBeenCalled();
      expect(h.conn.computeConnectionState()).toMatchObject({
        display: 'auth-failed',
        identities: { portal: { user: 'portal.c' }, command: { status: 'unavailable' }, sameUser: null },
        authError: 'The BMP portal user changed during authentication. Retry the connection.',
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('binds a portal actor RID to a differently formatted command principal', async () => {
    const h = await createHarness();
    vi.stubGlobal('fetch', vi.fn(async () => portalResponse({ user: '3663406580886322153' })));
    try {
      await h.conn.runAuthTest('background');
      expect(h.ctx.client.auth.logout).toHaveBeenCalledTimes(1);
      expect(h.ctx.client.auth.bindPortalActor).toHaveBeenCalledWith('3663406580886322153');
      expect(h.conn.computeConnectionState()).toMatchObject({
        display: 'connected',
        identities: {
          portal: { user: '3663406580886322153' },
          command: { user: 'admin' },
          sameUser: true,
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('quiet validation retains confirmed connected display while in flight', async () => {
    const h = await createHarness();
    await h.conn.runAuthTest('background');
    let release!: (value: TestConn) => void;
    vi.mocked(h.ctx.client.testConnection).mockImplementationOnce(() => new Promise<TestConn>(resolve => { release = resolve; }));
    const validating = h.conn.runAuthTest('background');
    await vi.waitFor(() => expect(h.ctx.client.testConnection).toHaveBeenCalledTimes(2));
    expect(h.conn.computeConnectionState()).toMatchObject({ display: 'connected', validation: 'validating' });
    release({ ok: true, authenticated: true, message: 'OK' });
    await validating;
    expect(h.conn.computeConnectionState()).toMatchObject({ display: 'connected', validation: 'idle' });
  });

  it('coalesces concurrent panel-attach validation triggers', async () => {
    const h = await createHarness();
    h.ctx.hasPanel = true;
    let release!: (value: TestConn) => void;
    vi.mocked(h.ctx.client.testConnection).mockImplementation(() => new Promise<TestConn>(resolve => { release = resolve; }));

    h.conn.ensureConnectionMonitoring();
    h.conn.ensureConnectionMonitoring();
    await vi.waitFor(() => expect(h.ctx.client.testConnection).toHaveBeenCalledTimes(1));
    release({ ok: true, authenticated: true, message: 'OK' });
    await vi.waitFor(() => expect(h.conn.computeConnectionState().validation).toBe('idle'));
  });

  it('revalidates a fresh restored snapshot instead of remaining validating forever', async () => {
    const h = await createHarness();
    const now = Date.now();
    await chrome.storage.session.set({
      crev_conn_snapshot: {
        schema: 1,
        profileId: 'p1',
        environment: 'p1@https://bmp.test/Workspace/',
        commandAuthRevision: '',
        expiresAt: now + 60_000,
        state: {
          display: 'connected',
          identities: {
            portal: { status: 'connected', user: 'admin', source: 'portal-session' },
            command: { status: 'connected', user: 'admin', source: 'portal-session' },
            sameUser: true,
          },
          version: '5.6.3', responseMs: 12, profileLabel: 'P1', workspace: 'Workspace',
          authError: null, networkOffline: false, lastUpdate: now,
          validation: 'idle', verifiedAt: now, semanticRevision: 7,
          incidentEpoch: 0, recoveryEpoch: 0,
          environment: 'p1@https://bmp.test/Workspace/',
        },
      },
    });
    h.setHealthResult({ up: true, reachable: true, responseMs: 9 });
    vi.mocked(h.ctx.client.testConnection).mockClear();

    await h.conn.restoreConnectionEvidence();
    expect(h.conn.computeConnectionState().validation).toBe('validating');
    h.conn.ensureConnectionMonitoring();

    await vi.waitFor(() => expect(h.conn.computeConnectionState().validation).toBe('idle'));
    expect(h.ctx.client.testConnection).toHaveBeenCalledTimes(1);
    expect(h.conn.computeConnectionState().display).toBe('connected');
  });

  it('explicit validation clears stale reachability failures as well as retesting auth', async () => {
    const h = await createHarness();
    h.setHealthResult({ up: false, reachable: false });
    await h.conn.pollHealth(true);
    expect(h.conn.computeConnectionState().display).toBe('unreachable');

    h.setHealthResult({ up: true, reachable: true, responseMs: 8 });
    await h.conn.validateConnection('explicit');

    expect(h.conn.computeConnectionState().display).toBe('connected');
  });

  it('deduplicates identical semantic publications even when wall-clock time advances', async () => {
    const h = await createHarness();
    h.conn.pushConnectionState();
    const sent = h.ctx.sendToPanel.mock.calls.length;
    const revision = h.conn.computeConnectionState().semanticRevision;

    await new Promise(resolve => setTimeout(resolve, 2));
    h.conn.pushConnectionState();

    expect(h.ctx.sendToPanel).toHaveBeenCalledTimes(sent);
    expect(h.conn.computeConnectionState().semanticRevision).toBe(revision);
  });

  it('persists fresher verified evidence without publishing a semantic update', async () => {
    const h = await createHarness();
    await h.conn.runAuthTest('background');
    const first = (await chrome.storage.session.get('crev_conn_snapshot')).crev_conn_snapshot as
      { state: { verifiedAt: number } };
    const sent = h.ctx.sendToPanel.mock.calls.length;
    h.conn.bindConnectionClient(h.ctx.client, 'p1');
    await new Promise(resolve => setTimeout(resolve, 2));

    (h.ctx.client as any).transport.outcomeObserver({
      ok: true, intent: 'read', operation: 'TreeItemCommand', commandCount: 1,
      queueDepth: 0, queueWaitMs: 0, durationMs: 2,
      requestBytes: 10, responseBytes: 20, attempts: 1,
    });
    await vi.waitFor(async () => {
      const latest = (await chrome.storage.session.get('crev_conn_snapshot')).crev_conn_snapshot as
        { state: { verifiedAt: number } };
      expect(latest.state.verifiedAt).toBeGreaterThan(first.state.verifiedAt);
    });

    expect(h.ctx.sendToPanel).toHaveBeenCalledTimes(sent);
  });
});
