/**
 * Multi-environment tab-switching audit fixes (v0.20.2):
 *  - matchProfile picks the LONGEST-prefix winner (not first-match)
 *  - setManualOverride is per-profile, scoped to the FROM profile
 *  - autoDetectProfile dedupes rapid switches to the same target
 *  - clientPool reuses warm BmpClient instances across profile swaps
 *  - BmpAuth.restoreFromSession() loads persisted JWT without
 *    falling through to a full login
 *
 * These tests drive the public surface (no internal poking) so they
 * remain meaningful if the implementation is refactored further.
 */
import { describe, it, expect, vi } from 'vitest';
import { mockChromeStorage } from './chrome-mock';
import { ObjectCache } from '../object-cache';
import type { InspectorSettings, ServerProfile } from '../types';

function makeProfiles(): ServerProfile[] {
  return [
    { id: 'sbx', label: 'sbx', bmpUrl: 'https://sbx.x.de/Steadfast/', bmpUser: 'u', bmpPass: 'p', commandAuthMode: 'portal' },
    { id: 'dev', label: 'dev', bmpUrl: 'https://dev.x.de/Steadfast/', bmpUser: 'u', bmpPass: 'p', commandAuthMode: 'portal' },
    { id: 'prod', label: 'prod', bmpUrl: 'https://prod.x.de/Steadfast/', bmpUser: 'u', bmpPass: 'p', commandAuthMode: 'portal' },
  ];
}

interface Harness {
  ctx: any;
  settings: typeof import('../settings');
  bmp: typeof import('../bmp-client');
}

async function createHarness(profiles = makeProfiles(), activeId = 'sbx'): Promise<Harness> {
  vi.resetModules();
  vi.clearAllMocks();
  mockChromeStorage();
  if (!('navigator' in globalThis)) (globalThis as any).navigator = { onLine: true };

  const swCtxMod = await import('../sw-context');
  const bmp = await import('../bmp-client');

  // Don't fire network — login + refresh just stamp the JWT and move on.
  vi.spyOn(bmp.BmpClient.prototype, 'testConnection').mockImplementation(async function (this: any) {
    this.auth._jwt = 'mock-jwt-' + Math.random().toString(36).slice(2, 8);
    return { ok: true, message: 'Authenticated', authenticated: true };
  });
  vi.spyOn(bmp.BmpClient, 'getBuildNumber').mockImplementation(async () => 'v5.6.10.0');
  vi.spyOn(bmp.BmpClient, 'checkHealth').mockImplementation(async () => ({ up: true, reachable: true, responseMs: 5 }));

  const settings: InspectorSettings = {
    schemaVersion: 1,
    profiles,
    activeProfileId: activeId,
    autoDetect: true,
    saveTarget: 'instance',
    enrichMode: 'all',
  };

  const ctx: any = {
    client: null,
    hasPanel: false,
    panelPortByWindow: new Map(),
    contentPorts: new Map(),
    cache: new ObjectCache(),
    history: { switchProfile: vi.fn(async () => {}), clear: vi.fn(), load: vi.fn() },
    favorites: { switchProfile: vi.fn(async () => {}), clear: vi.fn(), load: vi.fn() },
    scriptHistory: { switchProfile: vi.fn(async () => {}), clear: vi.fn(), load: vi.fn() },
    stylePresets: { getAll: vi.fn(() => []), save: vi.fn(), remove: vi.fn(), load: vi.fn(), switchProfile: vi.fn(async () => {}) } as any,
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
  swCtxMod.setSwContext(ctx);

  const settingsMod = await import('../settings');
  // Initial rebuild so ctx.client is populated for the active profile.
  await settingsMod.rebuildClient(false);

  return { ctx, settings: settingsMod, bmp };
}

describe('matchProfile — longest-prefix winner', () => {
  it('matches each environment by hostname', async () => {
    const h = await createHarness();
    expect(h.settings.matchProfile('https://sbx.x.de/Steadfast/?rid=1', h.ctx.settings.profiles)?.id).toBe('sbx');
    expect(h.settings.matchProfile('https://dev.x.de/Steadfast/?rid=1', h.ctx.settings.profiles)?.id).toBe('dev');
    expect(h.settings.matchProfile('https://prod.x.de/Steadfast/?rid=1', h.ctx.settings.profiles)?.id).toBe('prod');
  });

  it('returns null for an unmatched URL', async () => {
    const h = await createHarness();
    expect(h.settings.matchProfile('https://example.com/', h.ctx.settings.profiles)).toBeNull();
  });

  it('prefers the longer prefix when one profile URL is a prefix of another', async () => {
    const profiles: ServerProfile[] = [
      { id: 'short', label: 'short', bmpUrl: 'https://x.de/A/', bmpUser: 'u', bmpPass: 'p', commandAuthMode: 'portal' },
      { id: 'long',  label: 'long',  bmpUrl: 'https://x.de/A/B/', bmpUser: 'u', bmpPass: 'p', commandAuthMode: 'portal' },
    ];
    const h = await createHarness(profiles, 'short');
    expect(h.settings.matchProfile('https://x.de/A/B/?rid=1', h.ctx.settings.profiles)?.id).toBe('long');
    expect(h.settings.matchProfile('https://x.de/A/?rid=1', h.ctx.settings.profiles)?.id).toBe('short');
  });

  it('matches a CorpoWebserver base and every path below it', async () => {
    const profiles: ServerProfile[] = [
      { id: 'corpo', label: 'corpo', bmpUrl: 'https://x.de/CorpoWebserver', bmpUser: 'u', bmpPass: 'p', commandAuthMode: 'portal' },
    ];
    const h = await createHarness(profiles, 'corpo');

    expect(h.settings.matchProfile('https://x.de/CorpoWebserver', profiles)?.id).toBe('corpo');
    expect(h.settings.matchProfile('https://x.de/CorpoWebserver/', profiles)?.id).toBe('corpo');
    expect(h.settings.matchProfile('https://x.de/CorpoWebserver/Steadfast/page?rid=1#tab', profiles)?.id).toBe('corpo');
  });

  it('does not match sibling paths that merely share the same string prefix', async () => {
    const profiles: ServerProfile[] = [
      { id: 'corpo', label: 'corpo', bmpUrl: 'https://x.de/CorpoWebserver/', bmpUser: 'u', bmpPass: 'p', commandAuthMode: 'portal' },
    ];
    const h = await createHarness(profiles, 'corpo');

    expect(h.settings.matchProfile('https://x.de/CorpoWebserverTest/', profiles)).toBeNull();
    expect(h.settings.matchProfile('https://x.de/CorpoWebserver-old/', profiles)).toBeNull();
    expect(h.settings.matchProfile('https://other.x.de/CorpoWebserver/', profiles)).toBeNull();
  });
});

describe('setManualOverride — per-profile scope', () => {
  it('blocks auto-detect back to the suppressed profile', async () => {
    const h = await createHarness(makeProfiles(), 'sbx');
    // User picks dev manually while on sbx — suppress sbx for 30s.
    h.settings.setManualOverride('sbx');
    h.ctx.settings.activeProfileId = 'dev';

    await h.settings.autoDetectProfile('https://sbx.x.de/Steadfast/?rid=1');
    expect(h.ctx.settings.activeProfileId).toBe('dev'); // sbx blocked
  });

  it('does NOT block auto-detect to other profiles (the audit fix)', async () => {
    const h = await createHarness(makeProfiles(), 'sbx');
    h.settings.setManualOverride('sbx');
    h.ctx.settings.activeProfileId = 'dev';

    // prod has no override — alt-tab to prod should still auto-switch.
    await h.settings.autoDetectProfile('https://prod.x.de/Steadfast/?rid=1');
    expect(h.ctx.settings.activeProfileId).toBe('prod');
  });

  it('expires after MANUAL_OVERRIDE_DURATION', async () => {
    const h = await createHarness(makeProfiles(), 'sbx');
    h.settings.setManualOverride('sbx');
    h.ctx.settings.activeProfileId = 'dev';
    // Advance time past the override window by mocking Date.now once.
    const constants = await import('../constants');
    const realNow = Date.now;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + constants.MANUAL_OVERRIDE_DURATION + 1000);
    try {
      await h.settings.autoDetectProfile('https://sbx.x.de/Steadfast/?rid=1');
      expect(h.ctx.settings.activeProfileId).toBe('sbx');
    } finally {
      (Date.now as any).mockRestore?.();
    }
  });
});

describe('autoDetectProfile — dedupe + cross-env switch', () => {
  it('switches profiles when URL matches a different profile', async () => {
    const h = await createHarness(makeProfiles(), 'sbx');
    await h.settings.autoDetectProfile('https://dev.x.de/Steadfast/?rid=1');
    expect(h.ctx.settings.activeProfileId).toBe('dev');
  });

  it('no-ops when URL matches the active profile', async () => {
    const h = await createHarness(makeProfiles(), 'sbx');
    const sendToPanelCalls = h.ctx.sendToPanel.mock.calls.length;
    await h.settings.autoDetectProfile('https://sbx.x.de/Steadfast/?rid=1');
    expect(h.ctx.settings.activeProfileId).toBe('sbx');
    // No PROFILE_SWITCHED broadcast should have been issued.
    const after = h.ctx.sendToPanel.mock.calls;
    const switched = after.slice(sendToPanelCalls).filter((c: any[]) => c[0]?.type === 'PROFILE_SWITCHED');
    expect(switched.length).toBe(0);
  });

  it('does nothing when no profile matches', async () => {
    const h = await createHarness(makeProfiles(), 'sbx');
    await h.settings.autoDetectProfile('https://example.com/something');
    expect(h.ctx.settings.activeProfileId).toBe('sbx');
  });

  it('skips when autoDetect is disabled', async () => {
    const h = await createHarness(makeProfiles(), 'sbx');
    h.ctx.settings.autoDetect = false;
    await h.settings.autoDetectProfile('https://dev.x.de/Steadfast/?rid=1');
    expect(h.ctx.settings.activeProfileId).toBe('sbx');
  });

  it('serializes queued rebuilds and commits only the latest active profile', async () => {
    const h = await createHarness(makeProfiles(), 'sbx');
    let releaseDev!: () => void;
    const devBlocked = new Promise<void>(resolve => { releaseDev = resolve; });
    let activeSwitches = 0;
    let maxActiveSwitches = 0;
    const switchedProfiles: string[] = [];
    h.ctx.history.switchProfile = vi.fn(async (profileId: string) => {
      activeSwitches++;
      maxActiveSwitches = Math.max(maxActiveSwitches, activeSwitches);
      switchedProfiles.push(profileId);
      if (profileId === 'dev') await devBlocked;
      activeSwitches--;
    });

    h.ctx.settings.activeProfileId = 'dev';
    const devRebuild = h.settings.rebuildClient(false);
    await vi.waitFor(() => expect(switchedProfiles).toContain('dev'));

    h.ctx.settings.activeProfileId = 'prod';
    const prodRebuild = h.settings.rebuildClient(false);
    await Promise.resolve();
    expect(switchedProfiles).not.toContain('prod');

    releaseDev();
    await Promise.all([devRebuild, prodRebuild]);

    expect(maxActiveSwitches).toBe(1);
    expect(switchedProfiles).toEqual(['dev', 'prod']);
    expect(h.ctx.client.serverUrl).toContain('prod.x.de');
  });
});

describe('client pool — reuse warm clients across profile swaps', () => {
  it('reuses the same BmpClient when switching back to a profile', async () => {
    const h = await createHarness(makeProfiles(), 'sbx');
    const sbxClient = h.ctx.client;
    expect(sbxClient).toBeTruthy();

    // sbx → dev
    await h.settings.autoDetectProfile('https://dev.x.de/Steadfast/?rid=1');
    const devClient = h.ctx.client;
    expect(devClient).not.toBe(sbxClient);

    // dev → sbx (manual override on dev so autoDetect doesn't bounce back)
    h.settings.setManualOverride('dev');
    h.ctx.settings.activeProfileId = 'sbx';
    await h.settings.rebuildClient(false);
    expect(h.ctx.client).toBe(sbxClient); // POOL HIT
  });

  it('evicts pooled client when URL changes under the same id', async () => {
    const h = await createHarness(makeProfiles(), 'sbx');
    const beforeClient = h.ctx.client;

    // Simulate a profile edit: change sbx's URL to a different host.
    h.ctx.settings.profiles = h.ctx.settings.profiles.map((p: ServerProfile) =>
      p.id === 'sbx' ? { ...p, bmpUrl: 'https://sbx-new.x.de/Steadfast/' } : p
    );
    await h.settings.rebuildClient(false);
    expect(h.ctx.client).not.toBe(beforeClient);
    expect(h.ctx.client.serverUrl).toContain('sbx-new');
  });

  it('evictPooledClient drops the entry so next switch rebuilds', async () => {
    const h = await createHarness(makeProfiles(), 'sbx');
    const sbxClient = h.ctx.client;

    h.settings.evictPooledClient('sbx');
    // Force a rebuild — should mint a fresh client, not reuse the evicted one.
    await h.settings.rebuildClient(false);
    expect(h.ctx.client).not.toBe(sbxClient);
  });
});

describe('BmpAuth.restoreFromSession — JWT without full-login', () => {
  it('returns true and populates _jwt when session has a saved token', async () => {
    await createHarness();
    const auth = new (await import('../bmp-auth')).BmpAuth('https://sbx.x.de/Steadfast/', 'u', 'p', 'sbx');
    // Seed the session store directly.
    await chrome.storage.session.set({ crev_jwt_sbx: { jwt: 'persisted-jwt', refreshToken: 'rt' } });

    const ok = await auth.restoreFromSession();
    expect(ok).toBe(true);
    expect(auth.jwt).toBe('persisted-jwt');
  });

  it('returns false (no full login) when session has no entry', async () => {
    await createHarness();
    const auth = new (await import('../bmp-auth')).BmpAuth('https://sbx.x.de/Steadfast/', 'u', 'p', 'sbx');
    const loginSpy = vi.spyOn(auth, 'login');

    const ok = await auth.restoreFromSession();
    expect(ok).toBe(false);
    expect(auth.jwt).toBeNull();
    // Critically: restoreFromSession must NOT trigger a full login.
    expect(loginSpy).not.toHaveBeenCalled();
  });

  it('no-ops when JWT is already in memory', async () => {
    await createHarness();
    const auth = new (await import('../bmp-auth')).BmpAuth('https://sbx.x.de/Steadfast/', 'u', 'p', 'sbx');
    (auth as any)._jwt = 'already-here';
    const getSpy = vi.spyOn(chrome.storage.session, 'get');

    const ok = await auth.restoreFromSession();
    expect(ok).toBe(true);
    // Logger init may have called .get('crev_debug') — only assert no
    // JWT-key lookups happened.
    const jwtReads = getSpy.mock.calls.filter(
      (c: any[]) => typeof c[0] === 'string' && c[0].startsWith('crev_jwt_'),
    );
    expect(jwtReads.length).toBe(0);
  });
});

describe('onProfileSwitch listeners fire on switch paths', () => {
  it('autoDetect cross-env fires the listener with the new profileId', async () => {
    const h = await createHarness(makeProfiles(), 'sbx');
    const seen: string[] = [];
    h.settings.onProfileSwitch((id: string) => seen.push(id));

    await h.settings.autoDetectProfile('https://dev.x.de/Steadfast/?rid=1');
    expect(seen).toContain('dev');
  });

  it('fireProfileSwitch invokes all registered listeners', async () => {
    const h = await createHarness();
    const fnA = vi.fn();
    const fnB = vi.fn();
    h.settings.onProfileSwitch(fnA);
    h.settings.onProfileSwitch(fnB);

    h.settings.fireProfileSwitch('prod');
    expect(fnA).toHaveBeenCalledWith('prod');
    expect(fnB).toHaveBeenCalledWith('prod');
  });
});
