import type { ConnectionState } from './types';
import type { AuthErrorCode, AuthVia } from './bmp-auth';
import { getCtx } from './sw-context';
import { originPatternFor } from './site-access';
import { BmpClient } from './bmp-client';
import type { BmpTransportOutcome } from './bmp-transport';
import { log, errorMessage } from './logger';
import { HEALTH_POLL_INTERVAL } from './constants';
import { updateBadge } from './badge';
import { incrementGeneration, registerConnectionDisplayFn } from './enrichment';
import { environmentToken } from './environment';

// Register connection display accessor for enrichment module (breaks circular dependency)
registerConnectionDisplayFn(() => computeConnectionState().display);

let healthUp: 'unknown' | 'up' | 'down' | 'unreachable' = 'unknown';
let healthVersion: string | null = null;
let healthResponseMs: number | null = null;
let authResult: 'pending' | 'ok' | 'failed' = 'pending';
let authError: string | null = null;
let authErrorCode: AuthErrorCode | null = null;
let authVia: AuthVia | null = null;
let commandResult: 'unknown' | 'probing' | 'ok' | 'failed' = 'unknown';
let commandError: string | null = null;
let healthTimer: ReturnType<typeof setInterval> | null = null;
let networkOffline = false;
let needsAccess = false;
let lastPollTime = 0;
let lastBroadcastDisplay: string | null = null;
let connectionGeneration = 0;
let authTestInFlight: Promise<void> | null = null;
let authTestGeneration = -1;
let healthPollInFlight: Promise<void> | null = null;
let healthPollGeneration = -1;
let lastConfirmedConnected = false;

/** True when the extension holds host permission for this BMP origin. Direct SW fetches to an
 *  un-granted host are CORS-blocked (BMP sends no Access-Control-Allow-Origin), so we gate the health +
 *  auth probes on this and surface a 'needs-access' state instead of the misleading 'unreachable'.
 *  Degrades to true when the permissions API is unavailable (tests / older runtimes) — unchanged there. */
async function hasHostAccess(bmpUrl: string): Promise<boolean> {
  const origin = originPatternFor(bmpUrl);
  if (!origin || typeof chrome === 'undefined' || !chrome.permissions?.contains) return true;
  try { return await chrome.permissions.contains({ origins: [origin] }); }
  catch { return true; }
}

// Granting host access (site-access strip or Chrome's site settings) fires this — clear the gate and
// re-probe at once so a 'needs-access' connection flips to connected without waiting for the next poll.
if (typeof chrome !== 'undefined' && chrome.permissions?.onAdded) {
  chrome.permissions.onAdded.addListener(() => {
    needsAccess = false;
    lastPollTime = 0; // bypass the poll throttle
    void runAuthTest().finally(() => { void pollHealth(); });
  });
}

/** Apply BMP version flags to client. When /buildNum is unavailable, prefer
 *  modern capabilities: current deployments may hide that endpoint. */
function applyVersionFlags(version: string | null, reason?: string) {
  const ctx = getCtx();
  if (!ctx.client) return;
  if (!version) {
    ctx.client.supportsLookup = true;
    log.info('connection:versionFlags', reason
      ? `Version detection: ${reason} — assuming lookup() support`
      : 'Version detection failed — assuming lookup() support');
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
  connectionGeneration++;
  healthUp = 'unknown';
  healthVersion = null;
  healthResponseMs = null;
  authResult = 'pending';
  authError = null;
  authErrorCode = null;
  authVia = null;
  commandResult = 'unknown';
  commandError = null;
  needsAccess = false;
  lastBroadcastDisplay = null;
  lastPollTime = 0;
  lastConfirmedConnected = false;
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
    return { display: 'not-configured', version: null, responseMs: null, profileLabel: null, user: null, workspace: null, authError: null, authVia: null, networkOffline: false, lastUpdate: Date.now(), environment: environmentToken(ctx) };
  }

  let display: ConnectionState['display'];
  if (needsAccess) display = 'needs-access';
  else if (healthUp === 'unreachable') display = 'unreachable';
  else if (healthUp === 'down') display = 'server-down';
  else if (authResult === 'ok' && commandResult === 'ok') display = 'connected';
  else if (authResult === 'ok' && commandResult === 'probing') display = 'reconnecting';
  else if (authResult === 'ok' && commandResult === 'failed') display = 'command-failed';
  else if (authResult === 'failed') {
    if (authErrorCode === 'needs-login') display = 'needs-login';
    else if (authErrorCode === 'no-config-access') display = 'no-config-access';
    else display = 'auth-failed';
  }
  else if (healthUp === 'up') display = 'online';
  else if (commandResult === 'probing') display = 'checking';
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
    blueprintSupported: ctx.client?.supportsLookup !== false,
    responseMs: healthResponseMs,
    profileLabel: profile.label,
    user: authResult === 'ok' ? (profile.bmpUser || null) : null,
    workspace,
    authError: authResult === 'failed' ? authError : commandResult === 'failed' ? commandError : null,
    authVia: authResult === 'ok' ? authVia : null,
    networkOffline,
    lastUpdate: Date.now(),
    environment: environmentToken(ctx),
  };
}

function announceConnectedTransition(): void {
  const connected = computeConnectionState().display === 'connected';
  if (!connected) {
    lastConfirmedConnected = false;
    return;
  }
  if (lastConfirmedConnected) return;
  lastConfirmedConnected = true;
  const ctx = getCtx();
  incrementGeneration();
  ctx.broadcastToContent({ type: 'RE_ENRICH' });
}

/** Bind command outcomes from the active pooled client to connection state.
 *  The profile/client identity check prevents a late result from an inactive
 *  warm client from changing the current profile's status. */
export function bindConnectionClient(client: BmpClient, profileId: string): void {
  client.setTransportOutcomeObserver((outcome: BmpTransportOutcome) => {
    const ctx = getCtx();
    if (ctx.client !== client || ctx.settings.activeProfileId !== profileId) return;
    const stressed = outcome.durationMs >= 10_000
      || outcome.queueWaitMs >= 2_000
      || outcome.attempts > 1
      || outcome.requestBytes >= 256 * 1024
      || outcome.responseBytes >= 1024 * 1024;
    if (stressed) {
      const result = outcome.ok ? 'completed' : `failed (${outcome.error.kind})`;
      ctx.logActivity(
        outcome.ok ? 'warn' : 'error',
        `BMP ${outcome.operation} ${result} under load`,
        [
          `run ${outcome.durationMs}ms`,
          `queue ${outcome.queueWaitMs}ms (depth ${outcome.queueDepth})`,
          `${outcome.attempts} attempt${outcome.attempts === 1 ? '' : 's'}`,
          `${outcome.requestBytes}B request`,
          `${outcome.responseBytes}B response`,
        ].join(' · '),
      );
    }
    if (outcome.ok) {
      commandResult = 'ok';
      commandError = null;
    } else {
      if (outcome.error.kind === 'cancelled') return;
      // A permission response (and other non-5xx HTTP rejection) proves the
      // command channel is alive. It is an operation result, not a connection
      // failure, so a denied edit must not turn the global status red.
      if (outcome.error.kind === 'permission'
        || (outcome.error.kind === 'http' && (outcome.error.status ?? 0) < 500)) return;
      commandResult = 'failed';
      commandError = outcome.error.message;
      lastConfirmedConnected = false;
    }
    pushConnectionState();
    announceConnectedTransition();
    if (!outcome.ok
      && !authTestInFlight
      && ctx.hasPanel
      && healthUp !== 'down'
      && healthUp !== 'unreachable') void runAuthTest();
  });
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

export function runAuthTest(): Promise<void> {
  const generationAtStart = connectionGeneration;
  if (authTestInFlight && authTestGeneration === generationAtStart) return authTestInFlight;
  const clientAtStart = getCtx().client;
  const task = runAuthTestInternal(generationAtStart, clientAtStart);
  authTestInFlight = task;
  authTestGeneration = generationAtStart;
  const clear = () => {
    if (authTestInFlight === task) authTestInFlight = null;
  };
  void task.then(clear, clear);
  return task;
}

async function runAuthTestInternal(generationAtStart: number, clientAtStart: BmpClient | null): Promise<void> {
  const ctx = getCtx();
  const profile = ctx.settings.profiles.find(p => p.id === ctx.settings.activeProfileId);
  if (!profile?.bmpUrl) {
    authResult = 'pending';
    authError = null;
    authErrorCode = null;
    commandResult = 'unknown';
    commandError = null;
    pushConnectionState();
    return;
  }

  const bmpUrl = normalizeUrl(profile.bmpUrl);
  if (!(await hasHostAccess(bmpUrl))) {
    if (connectionGeneration !== generationAtStart || ctx.client !== clientAtStart) return;
    needsAccess = true; // no host permission → the graphql/token fetches would CORS-fail; don't try
    authResult = 'pending';
    commandResult = 'unknown';
    pushConnectionState();
    return;
  }
  if (connectionGeneration !== generationAtStart || ctx.client !== clientAtStart) return;
  needsAccess = false;
  if (!clientAtStart || ctx.client !== clientAtStart) {
    authResult = 'failed';
    authError = 'Connection client is not ready';
    authErrorCode = null;
    commandResult = 'unknown';
    pushConnectionState();
    return;
  }

  authResult = 'pending';
  authError = null;
  authErrorCode = null;
  commandResult = 'probing';
  commandError = null;
  pushConnectionState();
  ctx.logActivity('info', 'Testing command connection\u2026');
  try {
    const result = await clientAtStart.testConnection();
    if (connectionGeneration !== generationAtStart || ctx.client !== clientAtStart) return;
    authResult = result.authenticated ? 'ok' : 'failed';
    authError = result.ok ? null : result.message;
    authErrorCode = result.authenticated ? null : (result.code ?? null);
    authVia = result.authenticated ? clientAtStart.authVia : null;
    commandResult = result.ok ? 'ok' : result.authenticated ? 'failed' : 'unknown';
    commandError = result.ok ? null : result.authenticated ? result.message : null;
    ctx.logActivity(result.ok ? 'success' : 'warn', result.ok ? `Connected to ${profile.label}` : 'Connection failed', result.message);
    if (result.ok && !healthVersion) {
      healthVersion = await BmpClient.getBuildNumber(bmpUrl, clientAtStart.jwt ?? undefined);
      if (connectionGeneration !== generationAtStart || ctx.client !== clientAtStart) return;
      applyVersionFlags(healthVersion, healthVersion ? undefined : '/buildNum not available');
    }
  } catch (e) {
    if (connectionGeneration !== generationAtStart || ctx.client !== clientAtStart) return;
    authResult = 'failed';
    authError = errorMessage(e);
    authErrorCode = null;
    authVia = null;
    commandResult = 'unknown';
    commandError = null;
  }
  pushConnectionState();
  announceConnectedTransition();
}

export function pollHealth(force = false): Promise<void> {
  const generationAtStart = connectionGeneration;
  if (healthPollInFlight && healthPollGeneration === generationAtStart) return healthPollInFlight;
  // Skip if recently polled (prevents double-polls from online event + timer)
  const now = Date.now();
  if (!force && now - lastPollTime < HEALTH_POLL_INTERVAL * 0.8) return Promise.resolve();
  lastPollTime = now;
  const clientAtStart = getCtx().client;
  const task = pollHealthInternal(generationAtStart, clientAtStart);
  healthPollInFlight = task;
  healthPollGeneration = generationAtStart;
  const clear = () => {
    if (healthPollInFlight === task) healthPollInFlight = null;
  };
  void task.then(clear, clear);
  return task;
}

async function pollHealthInternal(generationAtStart: number, clientAtStart: BmpClient | null): Promise<void> {
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
  if (!(await hasHostAccess(bmpUrl))) {
    if (connectionGeneration !== generationAtStart || ctx.client !== clientAtStart) return;
    needsAccess = true; // no host permission → the fetch would CORS-fail; don't even try
    healthUp = 'unknown';
    healthResponseMs = null;
    pushConnectionState();
    return;
  }
  if (connectionGeneration !== generationAtStart || ctx.client !== clientAtStart) return;
  needsAccess = false;
  try {
    const result = await BmpClient.checkHealth(bmpUrl);
    if (connectionGeneration !== generationAtStart || ctx.client !== clientAtStart) return;
    if (result.up) {
      if (!healthVersion) {
        healthVersion = await BmpClient.getBuildNumber(bmpUrl, ctx.client?.jwt ?? undefined) ?? '';
        if (connectionGeneration !== generationAtStart || ctx.client !== clientAtStart) return;
        applyVersionFlags(healthVersion || null, healthVersion ? undefined : '/buildNum not available');
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
    if (connectionGeneration !== generationAtStart || ctx.client !== clientAtStart) return;
    log.swallow('connection:pollHealth', e);
    healthUp = 'unreachable';
    healthResponseMs = null;
  }
  pushConnectionState();
  announceConnectedTransition();
  if (healthUp === 'up' && commandResult !== 'ok' && ctx.hasPanel) {
    void runAuthTest();
  }
}

export function startHealthPolling() {
  // Always clear first — timer IDs become stale after SW suspension
  stopHealthPolling();
  // Delay first poll so runAuthTest() completes first
  healthTimer = setTimeout(() => {
    void pollHealth();
    healthTimer = setInterval(() => { void pollHealth(); }, HEALTH_POLL_INTERVAL);
  }, 500);
}

/** Start the panel-owned connection monitor without disturbing a monitor or
 *  verified command channel that is already live. A newly opened second panel
 *  and a replacement panel both use the existing state; only the first panel
 *  after an idle/no-panel period needs to resume monitoring. */
export function ensureConnectionMonitoring() {
  if (!healthTimer) startHealthPolling();
  if (computeConnectionState().display === 'connected') {
    pushConnectionState();
    return;
  }
  void runAuthTest();
}

export function stopHealthPolling() {
  if (healthTimer) {
    clearTimeout(healthTimer);
    clearInterval(healthTimer);
    healthTimer = null;
  }
}
