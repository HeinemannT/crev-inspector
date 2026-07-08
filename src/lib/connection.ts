import type { ConnectionState } from './types';
import { resolveAuthMode, type AuthErrorCode, type AuthVia } from './bmp-auth';
import { getCtx } from './sw-context';
import { BmpClient } from './bmp-client';
import { log, errorMessage } from './logger';
import { HEALTH_POLL_INTERVAL } from './constants';
import { updateBadge } from './badge';
import { incrementGeneration, registerConnectionDisplayFn } from './enrichment';

// Register connection display accessor for enrichment module (breaks circular dependency)
registerConnectionDisplayFn(() => computeConnectionState().display);

let healthUp: 'unknown' | 'up' | 'down' | 'unreachable' = 'unknown';
let healthVersion: string | null = null;
let healthResponseMs: number | null = null;
let authResult: 'pending' | 'ok' | 'failed' = 'pending';
let authError: string | null = null;
let authErrorCode: AuthErrorCode | null = null;
let authVia: AuthVia | null = null;
let healthTimer: ReturnType<typeof setInterval> | null = null;
let networkOffline = false;
let lastPollTime = 0;
let lastBroadcastDisplay: string | null = null;

/** Apply BMP version flags to client (auth mode, lookup support).
 *  When version is null, assume old BMP — binary mode with ticket auth
 *  is the safe fallback that works on all versions. */
function applyVersionFlags(version: string | null, reason?: string) {
  const ctx = getCtx();
  if (!ctx.client) return;
  if (!version) {
    ctx.client.assumeOldBmp();
    log.info('connection:versionFlags', reason
      ? `Version detection: ${reason} — assuming old BMP (binary + ticket auth)`
      : 'Version detection failed — assuming old BMP (binary + ticket auth)');
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
  authErrorCode = null;
  authVia = null;
  lastBroadcastDisplay = null;
  lastPollTime = 0;
  // Reset version flags — will be re-evaluated when version is detected
  const ctx = getCtx();
  if (ctx.client) {
    ctx.client.supportsLookup = null;
  }
}

export function computeConnectionState(): ConnectionState {
  const ctx = getCtx();
  const profile = ctx.settings.profiles.find(p => p.id === ctx.settings.activeProfileId);
  // A URL alone configures a profile now — `session` profiles have no username.
  if (!profile?.bmpUrl) {
    return { display: 'not-configured', version: null, responseMs: null, profileLabel: null, user: null, workspace: null, authError: null, authVia: null, networkOffline: false, lastUpdate: Date.now() };
  }

  let display: ConnectionState['display'];
  if (authResult === 'ok') display = 'connected';
  else if (authResult === 'failed') {
    // Health can only downgrade to unreachable; otherwise the auth-error code
    // picks the precise state (open-BMP-and-login vs no-access vs bad-creds).
    if (healthUp === 'unreachable') display = 'unreachable';
    else if (authErrorCode === 'needs-login') display = 'needs-login';
    else if (authErrorCode === 'no-config-access') display = 'no-config-access';
    else display = 'auth-failed';
  }
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
    } catch (e) { log.warn('connection:parseUrl', e, 'invalid BMP URL — workspace extraction skipped'); }
  }

  return {
    display,
    version: healthVersion || null,
    responseMs: healthResponseMs,
    profileLabel: profile.label,
    user: authResult === 'ok' ? (profile.bmpUser || null) : null,
    workspace,
    authError: authResult === 'failed' ? authError : null,
    authVia: authResult === 'ok' ? authVia : null,
    networkOffline,
    lastUpdate: Date.now(),
  };
}

export function pushConnectionState() {
  const state = computeConnectionState();
  updateBadge(state.display);
  const ctx = getCtx();
  ctx.sendToPanel({ type: 'CONNECTION_STATE', state });
  // Snapshot for instant panel boot (read before SW round-trip)
  chrome.storage.session.set({ crev_conn_snapshot: state }).catch(e => log.swallow('conn:snapshot', e));
  // Only broadcast to content scripts when display actually changes
  // (content only uses it for the connect/disconnect transition toasts)
  if (state.display !== lastBroadcastDisplay) {
    lastBroadcastDisplay = state.display;
    ctx.broadcastToContent({ type: 'CONNECTION_STATE', state });
  }
}

export async function runAuthTest() {
  const ctx = getCtx();
  const profile = ctx.settings.profiles.find(p => p.id === ctx.settings.activeProfileId);
  if (!profile?.bmpUrl) {
    authResult = 'pending';
    authError = null;
    authErrorCode = null;
    pushConnectionState();
    return;
  }

  const bmpUrl = normalizeUrl(profile.bmpUrl);
  const clientAtStart = ctx.client;

  // Session JWT recovery: when the client pool minted a fresh BmpClient
  // for a profile we've authed against this browser session (and the SW
  // didn't restart), the JWT lives in chrome.storage.session under
  // crev_jwt_<profileId> but the in-memory `auth._jwt` is null.
  // restoreFromSession() pulls it back without falling through to a
  // full login — that turns sbx → dev → sbx into "two refreshes" rather
  // than "two full logins".
  if (ctx.client && !ctx.client.jwt) {
    try {
      await ctx.client.auth.restoreFromSession();
      if (ctx.client !== clientAtStart) return;
    } catch (e) {
      if (ctx.client !== clientAtStart) return;
      log.warn('connection:restoreSession', e, 'session-JWT restore failed — will full-login');
    }
  }

  // Fast path: validate via refresh (1 request vs 3 for full login)
  if (ctx.client?.jwt) {
    try {
      const refreshed = await ctx.client.auth.refreshAuth();
      if (ctx.client !== clientAtStart) return;
      if (refreshed) {
        authResult = 'ok';
        authError = null;
        authErrorCode = null;
        // Refresh keeps the via the chain recorded at login. A token restored
        // from a pre-upgrade blob may lack it — infer from the profile so a
        // connected state never shows a blank "via".
        authVia = ctx.client.authVia ?? (resolveAuthMode(profile) === 'session' ? 'session' : 'password');
        if (!healthVersion) {
          healthVersion = await BmpClient.getBuildNumber(bmpUrl, ctx.client.jwt ?? undefined);
          applyVersionFlags(healthVersion, healthVersion ? undefined : '/buildNum not available (likely old BMP)');
        }
        ctx.logActivity('success', `Connected to ${profile.label}`);
        pushConnectionState();
        incrementGeneration(); // clear enrichedRids + permanentlyFailed from any pre-auth attempts
        ctx.broadcastToContent({ type: 'RE_ENRICH' });
        return;
      }
    } catch (e) {
      if (ctx.client !== clientAtStart) return;
      log.warn('connection:fastAuth', e, 'refresh-token auth failed — will try full login');
    }
    // Refresh failed — fall through to full auth test
  }

  ctx.logActivity('info', 'Testing connection\u2026');
  const testClient = new BmpClient(bmpUrl, profile.bmpUser, profile.bmpPass, profile.id, resolveAuthMode(profile));
  try {
    const result = await testClient.testConnection();
    if (ctx.client !== clientAtStart) return;
    authResult = result.ok ? 'ok' : 'failed';
    authError = result.ok ? null : result.message;
    authErrorCode = result.ok ? null : (result.code ?? null);
    authVia = result.ok ? testClient.authVia : null;
    ctx.logActivity(result.ok ? 'success' : 'warn', result.ok ? `Connected to ${profile.label}` : 'Connection failed', result.message);
    if (result.ok && ctx.client) {
      ctx.client.absorbAuth(testClient);
    }
    if (result.ok && !healthVersion) {
      healthVersion = await BmpClient.getBuildNumber(bmpUrl, testClient.jwt ?? undefined);
      applyVersionFlags(healthVersion, healthVersion ? undefined : '/buildNum not available (likely old BMP)');
    }
  } catch (e) {
    if (ctx.client !== clientAtStart) return;
    authResult = 'failed';
    authError = errorMessage(e);
    authErrorCode = null;
    authVia = null;
  }
  pushConnectionState();
  if (authResult === 'ok' && ctx.client) {
    incrementGeneration(); // clear enrichedRids + permanentlyFailed from any pre-auth attempts
    ctx.broadcastToContent({ type: 'RE_ENRICH' });
  }
}

export async function pollHealth() {
  // Skip if recently polled (prevents double-polls from online event + timer)
  const now = Date.now();
  if (now - lastPollTime < HEALTH_POLL_INTERVAL * 0.8) return;
  lastPollTime = now;

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
        applyVersionFlags(healthVersion || null, healthVersion ? undefined : '/buildNum not available (likely old BMP)');
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
  // Always clear first — timer IDs become stale after SW suspension
  stopHealthPolling();
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
