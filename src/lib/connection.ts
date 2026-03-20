import type { ConnectionState } from './types';
import { getCtx } from './sw-context';
import { BmpClient } from './bmp-client';
import { log, errorMessage } from './logger';
import { HEALTH_POLL_INTERVAL } from './constants';
import { updateBadge } from './badge';
import { incrementGeneration } from './enrichment';

let healthUp: 'unknown' | 'up' | 'down' | 'unreachable' = 'unknown';
let healthVersion: string | null = null;
let healthResponseMs: number | null = null;
let authResult: 'pending' | 'ok' | 'failed' = 'pending';
let authError: string | null = null;
let healthTimer: ReturnType<typeof setInterval> | null = null;
let networkOffline = false;

/** Apply BMP version flags to client (auth mode, lookup support).
 *  When version is null (e.g. /buildNum returned 401), assume old BMP —
 *  binary mode with ticket auth is the safe fallback that works on all versions. */
function applyVersionFlags(version: string | null) {
  const ctx = getCtx();
  if (!ctx.client) return;
  if (!version) {
    // Version detection failed — assume old BMP (safe default)
    ctx.client.assumeOldBmp();
    log.info('connection:versionFlags', 'Version detection failed — assuming old BMP (binary + ticket auth)');
    return;
  }
  ctx.client.applyVersionFlags(version);
}

/** Normalize user-entered URL: add scheme if missing, ensure trailing slash */
export function normalizeUrl(raw: string): string {
  let url = raw.trim();
  if (url && !/^https?:\/\//i.test(url)) url = 'https://' + url;
  if (url && !url.endsWith('/')) url += '/';
  return url;
}

export function resetConnectionState() {
  healthUp = 'unknown';
  healthVersion = null;
  healthResponseMs = null;
  authResult = 'pending';
  authError = null;
  // Reset version flags — will be re-evaluated when version is detected
  const ctx = getCtx();
  if (ctx.client) {
    ctx.client.supportsLookup = null;
  }
}

export function computeConnectionState(): ConnectionState {
  const ctx = getCtx();
  const profile = ctx.settings.profiles.find(p => p.id === ctx.settings.activeProfileId);
  if (!profile?.bmpUser) {
    return { display: 'not-configured', version: null, responseMs: null, profileLabel: null, user: null, workspace: null, authError: null, networkOffline: false, lastUpdate: Date.now() };
  }

  let display: ConnectionState['display'];
  if (authResult === 'ok') display = 'connected';
  else if (authResult === 'failed') display = healthUp === 'unreachable' ? 'unreachable' : 'auth-failed';
  else if (healthUp === 'unreachable') display = 'unreachable';
  else if (healthUp === 'up') display = 'online';
  else if (healthUp === 'down') display = 'server-down';
  else display = 'checking';

  let workspace: string | null = null;
  if (profile?.bmpUrl) {
    try {
      const pathname = new URL(normalizeUrl(profile.bmpUrl)).pathname.replace(/\/+$/, '');
      if (pathname && pathname !== '/') {
        const lastSlash = pathname.lastIndexOf('/');
        workspace = pathname.substring(lastSlash + 1) || null;
      }
    } catch (e) { log.swallow('connection:parseUrl', e); }
  }

  return {
    display,
    version: healthVersion || null,
    responseMs: healthResponseMs,
    profileLabel: profile.label,
    user: authResult === 'ok' ? profile.bmpUser : null,
    workspace,
    authError: authResult === 'failed' ? authError : null,
    networkOffline,
    lastUpdate: Date.now(),
  };
}

export function pushConnectionState() {
  const state = computeConnectionState();
  updateBadge(state.display);
  const ctx = getCtx();
  ctx.sendToPanel({ type: 'CONNECTION_STATE', state });
  // Also broadcast to all content scripts for env tag + toasts
  ctx.broadcastToContent({ type: 'CONNECTION_STATE', state });
}

export async function runAuthTest() {
  const ctx = getCtx();
  const profile = ctx.settings.profiles.find(p => p.id === ctx.settings.activeProfileId);
  if (!profile?.bmpUrl || !profile?.bmpUser) {
    authResult = 'pending';
    authError = null;
    pushConnectionState();
    return;
  }

  const bmpUrl = normalizeUrl(profile.bmpUrl);
  const clientAtStart = ctx.client;

  // Fast path: validate via refresh (1 request vs 3 for full login)
  if (ctx.client?.jwt) {
    try {
      const refreshed = await ctx.client.auth.refreshAuth();
      if (ctx.client !== clientAtStart) return;
      if (refreshed) {
        authResult = 'ok';
        authError = null;
        if (!healthVersion) {
          healthVersion = await BmpClient.getBuildNumber(bmpUrl, ctx.client.jwt ?? undefined);
          applyVersionFlags(healthVersion);
        }
        ctx.logActivity('success', `Connected to ${profile.label}`);
        pushConnectionState();
        incrementGeneration(); // clear enrichedRids + permanentlyFailed from any pre-auth attempts
        ctx.broadcastToContent({ type: 'RE_ENRICH' });
        return;
      }
    } catch (e) {
      if (ctx.client !== clientAtStart) return;
      log.swallow('connection:fastAuth', e);
    }
    // Refresh failed — fall through to full auth test
  }

  ctx.logActivity('info', 'Testing connection\u2026');
  const testClient = new BmpClient(bmpUrl, profile.bmpUser, profile.bmpPass);
  try {
    const result = await testClient.testConnection();
    if (ctx.client !== clientAtStart) return;
    authResult = result.ok ? 'ok' : 'failed';
    authError = result.ok ? null : result.message;
    ctx.logActivity(result.ok ? 'success' : 'warn', result.ok ? `Connected to ${profile.label}` : 'Connection failed', result.message);
    if (result.ok && ctx.client) {
      ctx.client.absorbAuth(testClient);
    }
    if (result.ok && !healthVersion) {
      healthVersion = await BmpClient.getBuildNumber(bmpUrl, testClient.jwt ?? undefined);
      applyVersionFlags(healthVersion);
    }
  } catch (e) {
    if (ctx.client !== clientAtStart) return;
    authResult = 'failed';
    authError = errorMessage(e);
  }
  pushConnectionState();
  if (authResult === 'ok' && ctx.client) {
    incrementGeneration(); // clear enrichedRids + permanentlyFailed from any pre-auth attempts
    ctx.broadcastToContent({ type: 'RE_ENRICH' });
  }
}

export async function pollHealth() {
  const ctx = getCtx();
  const profile = ctx.settings.profiles.find(p => p.id === ctx.settings.activeProfileId);
  if (!profile?.bmpUrl) {
    healthUp = 'unknown';
    healthVersion = null;
    healthResponseMs = null;
    pushConnectionState();
    return;
  }

  // Check browser network state before attempting fetch
  if (!navigator.onLine) {
    healthUp = 'unreachable';
    healthResponseMs = null;
    networkOffline = true;
    pushConnectionState();
    return;
  }
  networkOffline = false;

  const bmpUrl = normalizeUrl(profile.bmpUrl);
  try {
    const result = await BmpClient.checkHealth(bmpUrl);
    if (result.up) {
      if (!healthVersion) {
        healthVersion = await BmpClient.getBuildNumber(bmpUrl, ctx.client?.jwt ?? undefined) ?? '';
        applyVersionFlags(healthVersion);
      }
      healthUp = 'up';
      healthResponseMs = result.responseMs;
    } else if (result.reachable) {
      healthUp = 'down';
      healthResponseMs = result.responseMs;
    } else {
      healthUp = 'unreachable';
      healthResponseMs = null;
    }
  } catch (e) {
    log.swallow('connection:pollHealth', e);
    healthUp = 'unreachable';
    healthResponseMs = null;
  }
  pushConnectionState();
}

export function startHealthPolling() {
  if (healthTimer) return;
  // Delay first poll so runAuthTest() completes first
  healthTimer = setTimeout(() => {
    pollHealth();
    healthTimer = setInterval(pollHealth, HEALTH_POLL_INTERVAL);
  }, 500);
}

export function stopHealthPolling() {
  if (healthTimer) {
    clearTimeout(healthTimer);
    clearInterval(healthTimer);
    healthTimer = null;
  }
}
