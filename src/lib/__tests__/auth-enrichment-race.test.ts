/**
 * Tests for the auth/enrichment race condition fix.
 *
 * Validates:
 * 1. rebuildClient() does NOT broadcast RE_ENRICH
 * 2. runAuthTest() broadcasts RE_ENRICH only AFTER auth succeeds
 * 3. Fast-path uses refreshAuth() (not unauthenticated health check)
 * 4. absorbAuth() persists tokens to session storage
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mockChromeStorage } from './chrome-mock';
import { setSwContext } from '../sw-context';
import type { SwContext } from '../sw-context';
import type { InspectorMessage, InspectorSettings } from '../types';
import { BmpAuth } from '../bmp-auth';
import { BmpClient } from '../bmp-client';
import { resetConnectionState, runAuthTest } from '../connection';
import { rebuildClient } from '../settings';

// ── Mock helpers ──

function makeSettings(overrides: Partial<InspectorSettings> = {}): InspectorSettings {
  return {
    schemaVersion: 1,
    profiles: [{
      id: 'prof-1',
      label: 'Test',
      bmpUrl: 'https://bmp.test/Workspace/',
      bmpUser: 'admin',
      bmpPass: 'pass',
      commandAuthMode: 'portal',
    }],
    activeProfileId: 'prof-1',
    autoDetect: true,
    saveTarget: 'template' as const,
    enrichMode: 'widgets' as const,
    ...overrides,
  };
}

function makeCtx(overrides: Partial<SwContext> = {}): SwContext & {
  broadcastedMessages: InspectorMessage[];
  panelMessages: InspectorMessage[];
  activityLog: Array<{ level: string; message: string }>;
} {
  const broadcastedMessages: InspectorMessage[] = [];
  const panelMessages: InspectorMessage[] = [];
  const activityLog: Array<{ level: string; message: string }> = [];

  const ctx = {
    client: null as any,
    contentPorts: new Map(),
    cache: { get: vi.fn(), put: vi.fn(), putAll: vi.fn(), size: 0, clear: vi.fn(), load: vi.fn(), switchProfile: vi.fn().mockResolvedValue(undefined) } as any,
    history: { record: vi.fn(), getAll: vi.fn(() => []), clear: vi.fn(), load: vi.fn(), switchProfile: vi.fn().mockResolvedValue(undefined) } as any,
    favorites: { toggle: vi.fn(), isFavorite: vi.fn(() => false), getAll: vi.fn(() => []), remove: vi.fn(), load: vi.fn(), switchProfile: vi.fn().mockResolvedValue(undefined) } as any,
    scriptHistory: { record: vi.fn(), getAll: vi.fn(() => []), clear: vi.fn(), load: vi.fn(), switchProfile: vi.fn().mockResolvedValue(undefined) } as any,
    stylePresets: { getAll: vi.fn(() => []), save: vi.fn(), remove: vi.fn(), load: vi.fn(), switchProfile: vi.fn(async () => {}) } as any,
    settings: makeSettings(),
    inspectActive: false,
    technicalOverlay: false,
    settingsReady: Promise.resolve(),
    logActivity: vi.fn((level: string, message: string) => activityLog.push({ level, message })),
    sendToPanel: vi.fn((msg: InspectorMessage) => panelMessages.push(msg)),
    sendToPanelByWindow: vi.fn(),
    sendToPanelByTab: vi.fn(),
    broadcastToContent: vi.fn((msg: InspectorMessage) => broadcastedMessages.push(msg)),
    toast: vi.fn(),
    broadcastedMessages,
    panelMessages,
    activityLog,
    ...overrides,
  } as any;

  return ctx;
}

// ── Tests ──

describe('absorbAuth persists tokens', () => {
  beforeEach(() => {
    mockChromeStorage();
  });

  it('should persist tokens to session storage after absorbing', async () => {
    const source = new BmpAuth('https://bmp.test/', 'admin', 'pass', 'prof-src');
    (source as any)._jwt = 'jwt-from-source';
    (source as any)._refreshToken = 'refresh-from-source';

    const target = new BmpAuth('https://bmp.test/', 'admin', 'pass', 'prof-tgt');
    target.absorbAuth(source);

    expect(target.jwt).toBe('jwt-from-source');

    // Wait for the async persist to complete
    await vi.waitFor(() => {
      expect(chrome.storage.session.set).toHaveBeenCalled();
    });

    // Verify the strategy-specific, stamped portal-token envelope.
    const setCall = (chrome.storage.session.set as any).mock.calls[0][0];
    const key = Object.keys(setCall)[0];
    expect(setCall[key]).toMatchObject({
      version: 2,
      kind: 'portal-token',
      jwt: 'jwt-from-source',
      refreshToken: 'refresh-from-source',
      stamp: { profileId: 'prof-tgt', mode: 'portal' },
    });
  });

  it('tokens survive session restore after absorbAuth', async () => {
    const source = new BmpAuth('https://bmp.test/', 'admin', 'pass', 'prof-1');
    (source as any)._jwt = 'my-jwt';
    (source as any)._refreshToken = 'my-refresh';

    const target = new BmpAuth('https://bmp.test/', 'admin', 'pass', 'prof-1');
    target.absorbAuth(source);

    // Wait for persist
    await vi.waitFor(() => {
      expect(chrome.storage.session.set).toHaveBeenCalled();
    });

    // Simulate fresh instance restoring from session storage
    const fresh = new BmpAuth('https://bmp.test/', 'admin', 'pass', 'prof-1');
    const jwt = await fresh.ensureAuth();
    expect(jwt).toBe('my-jwt');
  });
});

describe('rebuildClient does not broadcast RE_ENRICH', () => {
  beforeEach(() => {
    mockChromeStorage();
  });

  it('should not send RE_ENRICH when rebuilding client', async () => {
    const ctx = makeCtx();
    ctx.settings = makeSettings();
    setSwContext(ctx);

    await rebuildClient();

    const reEnrichMessages = ctx.broadcastedMessages.filter(m => m.type === 'RE_ENRICH');
    expect(reEnrichMessages).toHaveLength(0);
  });
});

describe('runAuthTest broadcasts RE_ENRICH after success', () => {
  beforeEach(() => {
    mockChromeStorage();
    setSwContext(makeCtx());
    resetConnectionState();
  });

  it('broadcasts RE_ENRICH after the active client command probe succeeds', async () => {
    const ctx = makeCtx();
    const testConnection = vi.fn().mockResolvedValue({
      ok: true, message: 'Authenticated and command channel ready', authenticated: true,
    });
    ctx.client = {
      jwt: 'new-jwt',
      commandUser: 'admin',
      testConnection,
      applyVersionFlags: vi.fn(),
      supportsLookup: true,
    } as any;

    setSwContext(ctx);

    vi.spyOn(BmpClient, 'getBuildNumber').mockResolvedValue('5.6.7.2');

    await runAuthTest();

    expect(testConnection).toHaveBeenCalledTimes(1);

    // RE_ENRICH should have been broadcast
    const reEnrichMessages = ctx.broadcastedMessages.filter(m => m.type === 'RE_ENRICH');
    expect(reEnrichMessages).toHaveLength(1);

    // Activity log should show connected
    expect(ctx.activityLog.some(e => e.level === 'success' && e.message.includes('Connected'))).toBe(true);
  });

  it('authenticated command failure does not broadcast RE_ENRICH', async () => {
    const ctx = makeCtx();
    ctx.client = {
      jwt: 'valid-jwt',
      commandUser: 'admin',
      testConnection: vi.fn().mockResolvedValue({
        ok: false, message: 'Cannot reach command socket', authenticated: true,
      }),
    } as any;

    setSwContext(ctx);
    await runAuthTest();

    const reEnrichMessages = ctx.broadcastedMessages.filter(m => m.type === 'RE_ENRICH');
    expect(reEnrichMessages).toHaveLength(0);
  });

  it('auth failure does NOT broadcast RE_ENRICH', async () => {
    const ctx = makeCtx();
    ctx.client = {
      jwt: null,
      testConnection: vi.fn().mockResolvedValue({
        ok: false, message: 'Wrong username or password', authenticated: false,
      }),
      applyVersionFlags: vi.fn(),
      supportsLookup: true,
    } as any;

    setSwContext(ctx);

    await runAuthTest();

    // No RE_ENRICH on failure
    const reEnrichMessages = ctx.broadcastedMessages.filter(m => m.type === 'RE_ENRICH');
    expect(reEnrichMessages).toHaveLength(0);
  });

  it('no client → no RE_ENRICH', async () => {
    const ctx = makeCtx();
    ctx.client = null;
    setSwContext(ctx);

    await runAuthTest();

    const reEnrichMessages = ctx.broadcastedMessages.filter(m => m.type === 'RE_ENRICH');
    expect(reEnrichMessages).toHaveLength(0);
  });

  it('profile not configured → no RE_ENRICH', async () => {
    const ctx = makeCtx();
    ctx.settings = makeSettings({ profiles: [], activeProfileId: '' });
    ctx.client = null;
    setSwContext(ctx);

    await runAuthTest();

    const reEnrichMessages = ctx.broadcastedMessages.filter(m => m.type === 'RE_ENRICH');
    expect(reEnrichMessages).toHaveLength(0);
  });

  it('ignores a successful probe that completes after the active client changes', async () => {
    const ctx = makeCtx();
    let finish!: (value: { ok: boolean; message: string; authenticated: boolean }) => void;
    const probe = new Promise<{ ok: boolean; message: string; authenticated: boolean }>(
      resolve => { finish = resolve; },
    );
    const oldClient = {
      jwt: 'old-jwt',
      commandUser: 'admin',
      testConnection: vi.fn(() => probe),
      applyVersionFlags: vi.fn(),
    } as any;
    ctx.client = oldClient;
    setSwContext(ctx);

    const pending = runAuthTest();
    await vi.waitFor(() => expect(oldClient.testConnection).toHaveBeenCalledTimes(1));
    ctx.client = { testConnection: vi.fn() } as any;
    resetConnectionState();
    finish({ ok: true, message: 'late success', authenticated: true });
    await pending;

    expect(ctx.broadcastedMessages.filter(m => m.type === 'RE_ENRICH')).toHaveLength(0);
  });
});

describe('no concurrent logins (race condition prevention)', () => {
  beforeEach(() => {
    mockChromeStorage();
    setSwContext(makeCtx());
    resetConnectionState();
  });

  it('deduplicates concurrent probes and broadcasts only after the probe completes', async () => {
    const ctx = makeCtx();
    const events: string[] = [];

    const testConnection = vi.fn(async () => {
      events.push('probe:start');
      await new Promise(r => setTimeout(r, 10));
      events.push('probe:done');
      return { ok: true, message: 'ready', authenticated: true };
    });

    ctx.client = {
      jwt: 'old-jwt',
      commandUser: 'admin',
      testConnection,
      applyVersionFlags: vi.fn(),
      supportsLookup: true,
    } as any;

    ctx.broadcastToContent = vi.fn((msg: InspectorMessage) => {
      if (msg.type === 'RE_ENRICH') events.push('RE_ENRICH:broadcast');
      ctx.broadcastedMessages.push(msg);
    });

    setSwContext(ctx);

    vi.spyOn(BmpClient, 'getBuildNumber').mockResolvedValue('5.6.7.2');

    await Promise.all([runAuthTest(), runAuthTest()]);

    expect(testConnection).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      'probe:start',
      'probe:done',
      'RE_ENRICH:broadcast',
    ]);
  });
});
