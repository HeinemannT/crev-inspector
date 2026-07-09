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
import { runAuthTest } from '../connection';
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
    (source as any)._via = 'session';

    const target = new BmpAuth('https://bmp.test/', 'admin', 'pass', 'prof-tgt');
    target.absorbAuth(source);

    expect(target.jwt).toBe('jwt-from-source');
    // absorbAuth also carries the "how we connected" marker.
    expect(target.via).toBe('session');

    // Wait for the async persist to complete
    await vi.waitFor(() => {
      expect(chrome.storage.session.set).toHaveBeenCalled();
    });

    // Verify the stored data (the via is persisted alongside the tokens so it
    // survives refresh + SW restart).
    const setCall = (chrome.storage.session.set as any).mock.calls[0][0];
    const key = Object.keys(setCall)[0];
    expect(setCall[key]).toEqual({ jwt: 'jwt-from-source', refreshToken: 'refresh-from-source', via: 'session' });
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
  });

  it('fast-path: broadcasts RE_ENRICH after refreshAuth succeeds', async () => {
    const ctx = makeCtx();

    const mockRefreshAuth = vi.fn().mockResolvedValue('new-jwt');
    ctx.client = {
      jwt: 'existing-jwt',
      auth: { refreshAuth: mockRefreshAuth, jwt: 'existing-jwt' },
      absorbAuth: vi.fn(),
      applyVersionFlags: vi.fn(),
      supportsLookup: true,
    } as any;

    setSwContext(ctx);

    vi.spyOn(BmpClient, 'getBuildNumber').mockResolvedValue('5.6.7.2');

    await runAuthTest();

    // refreshAuth should have been called (not checkHealth)
    expect(mockRefreshAuth).toHaveBeenCalledTimes(1);

    // RE_ENRICH should have been broadcast
    const reEnrichMessages = ctx.broadcastedMessages.filter(m => m.type === 'RE_ENRICH');
    expect(reEnrichMessages).toHaveLength(1);

    // Activity log should show connected
    expect(ctx.activityLog.some(e => e.level === 'success' && e.message.includes('Connected'))).toBe(true);
  });

  it('fast-path failure falls through to full auth, then broadcasts RE_ENRICH', async () => {
    const ctx = makeCtx();

    // refreshAuth fails → returns null
    const mockRefreshAuth = vi.fn().mockResolvedValue(null);
    const mockAbsorbAuth = vi.fn();
    ctx.client = {
      jwt: 'stale-jwt',
      auth: { refreshAuth: mockRefreshAuth, jwt: 'stale-jwt' },
      absorbAuth: mockAbsorbAuth,
    } as any;

    setSwContext(ctx);

    vi.spyOn(BmpClient, 'getBuildNumber').mockResolvedValue('5.6.7.2');

    // Mock the BmpClient constructor-created testClient's testConnection
    vi.spyOn(BmpClient.prototype, 'testConnection').mockResolvedValue({
      ok: true, message: 'Authenticated', authenticated: true,
    });

    await runAuthTest();

    // refreshAuth was tried first
    expect(mockRefreshAuth).toHaveBeenCalledTimes(1);

    // absorbAuth was called on the real client
    expect(mockAbsorbAuth).toHaveBeenCalledTimes(1);

    // RE_ENRICH was broadcast after success
    const reEnrichMessages = ctx.broadcastedMessages.filter(m => m.type === 'RE_ENRICH');
    expect(reEnrichMessages).toHaveLength(1);
  });

  it('auth failure does NOT broadcast RE_ENRICH', async () => {
    const ctx = makeCtx();
    ctx.client = {
      jwt: null,
      auth: { refreshAuth: vi.fn() },
      absorbAuth: vi.fn(),
      applyVersionFlags: vi.fn(),
      supportsLookup: true,
    } as any;

    setSwContext(ctx);

    vi.spyOn(BmpClient.prototype, 'testConnection').mockResolvedValue({
      ok: false, message: 'Wrong username or password', authenticated: false,
    });

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
});

describe('no concurrent logins (race condition prevention)', () => {
  beforeEach(() => {
    mockChromeStorage();
  });

  it('RE_ENRICH is sequenced after auth, not concurrent', async () => {
    const ctx = makeCtx();
    const events: string[] = [];

    const mockRefreshAuth = vi.fn(async () => {
      events.push('refreshAuth:start');
      await new Promise(r => setTimeout(r, 10));
      events.push('refreshAuth:done');
      return 'new-jwt';
    });

    ctx.client = {
      jwt: 'old-jwt',
      auth: { refreshAuth: mockRefreshAuth, jwt: 'old-jwt' },
      absorbAuth: vi.fn(),
      applyVersionFlags: vi.fn(),
      supportsLookup: true,
    } as any;

    ctx.broadcastToContent = vi.fn((msg: InspectorMessage) => {
      if (msg.type === 'RE_ENRICH') events.push('RE_ENRICH:broadcast');
      ctx.broadcastedMessages.push(msg);
    });

    setSwContext(ctx);

    vi.spyOn(BmpClient, 'getBuildNumber').mockResolvedValue('5.6.7.2');

    await runAuthTest();

    // RE_ENRICH must come AFTER refreshAuth completes
    expect(events).toEqual([
      'refreshAuth:start',
      'refreshAuth:done',
      'RE_ENRICH:broadcast',
    ]);
  });
});
