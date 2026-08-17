import type { ConnectionState } from './types';
import type { AuthErrorCode } from './bmp-auth';
import { getCtx } from './sw-context';
import { hasHostAccess, HostAccessError } from './site-access';
import { BmpClient, type ConnectionResult } from './bmp-client';
import type { BmpTransportOutcome } from './bmp-transport';
import { log, errorMessage } from './logger';
import { CONNECTION_FRESHNESS_TARGET } from './constants';
import { updateBadge } from './badge';
import { incrementGeneration, registerConnectionDisplayFn } from './enrichment';
import { environmentToken } from './environment';
import { probePortalIdentity } from './portal-identity';
import { unknownIdentityMap, withSameUser, type IdentityMap } from './identity-map';
import { setCurrentIdentities } from './command-actor';
import { createConnectionSnapshot, provisionalConnectionSnapshot } from './connection-snapshot';
import { traceConnectionDiagnostic } from './connection-trace';

// Register connection display accessor for enrichment module (breaks circular dependency)
registerConnectionDisplayFn(() => computeConnectionState().display);

let healthUp: 'unknown' | 'up' | 'down' | 'unreachable' = 'unknown';
let healthVersion: string | null = null;
let healthResponseMs: number | null = null;
let authResult: 'pending' | 'ok' | 'failed' = 'pending';
let authError: string | null = null;
let authErrorCode: AuthErrorCode | null = null;
let identities: IdentityMap = unknownIdentityMap();
let commandResult: 'unknown' | 'probing' | 'ok' | 'failed' = 'unknown';
let commandError: string | null = null;
let networkOffline = false;
let needsAccess = false;
let lastPollTime = 0;
let connectionGeneration = 0;
let authTestInFlight: Promise<void> | null = null;
let authTestGeneration = -1;
let healthPollInFlight: Promise<void> | null = null;
let healthPollGeneration = -1;
let validation: 'idle' | 'validating' = 'idle';
let verifiedAt: number | null = null;
let semanticRevision = 0;
let lastSemanticUpdate = 0;
let lastSemanticKey: string | null = null;
let lastSnapshotSignature: string | null = null;
let nextIncidentEpoch = 0;
let activeIncidentEpoch = 0;
let recoveryEpoch = 0;
let identityMismatch = false;
const identityReconcileKeys = new Set<string>();

/** True when the extension holds host permission for this BMP origin. Direct SW fetches to an
 *  un-granted host are CORS-blocked (BMP sends no Access-Control-Allow-Origin), so we gate the health +
 *  auth probes on this and surface a 'needs-access' state instead of the misleading 'unreachable'.
 *  Degrades to true when the permissions API is unavailable (tests / older runtimes) — unchanged there. */
// Granting host access (site-access strip or Chrome's site settings) fires this — clear the gate and
// re-probe at once so a 'needs-access' connection flips to connected without waiting for the next poll.
if (typeof chrome !== 'undefined' && chrome.permissions?.onAdded) {
  chrome.permissions.onAdded.addListener(() => {
    needsAccess = false;
    lastPollTime = 0; // bypass the poll throttle
    void validateConnection('evidence-change');
  });
}

if (typeof chrome !== 'undefined' && chrome.permissions?.onRemoved) {
  chrome.permissions.onRemoved.addListener(() => {
    lastPollTime = 0;
    markHostAccessRequired();
  });
}

/** Move the connection into the existing repairable access state after a
 * feature-level HTTP guard detects a revoked or stale grant. */
export function markHostAccessRequired(): void {
  needsAccess = true;
  authResult = 'pending';
  commandResult = 'unknown';
  commandError = null;
  validation = 'idle';
  verifiedAt = Date.now();
  pushConnectionState();
}

/** Browser logout affects the portal actor even when commands use an
 * independent stored ticket. It must not tear that command ticket down. */
export function markPortalSignedOut(): void {
  identities = withSameUser({
    portal: {
      status: 'unavailable',
      user: null,
      source: 'portal-session',
      error: 'No active BMP portal login.',
    },
    command: identities.command,
  });
  setCurrentIdentities(identities);
  pushConnectionState();
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
  const profile = getCtx().settings.profiles.find(p => p.id === getCtx().settings.activeProfileId);
  identities = unknownIdentityMap(profile?.commandAuthMode ?? 'portal');
  setCurrentIdentities(identities);
  commandResult = 'unknown';
  commandError = null;
  needsAccess = false;
  lastPollTime = 0;
  validation = 'idle';
  verifiedAt = null;
  semanticRevision = 0;
  lastSemanticUpdate = 0;
  lastSemanticKey = null;
  lastSnapshotSignature = null;
  nextIncidentEpoch = 0;
  activeIncidentEpoch = 0;
  recoveryEpoch = 0;
  identityMismatch = false;
  identityReconcileKeys.clear();
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
    return { display: 'not-configured', identities: unknownIdentityMap(), version: null, responseMs: null, profileLabel: null, workspace: null, authError: null, networkOffline: false, lastUpdate: lastSemanticUpdate, validation, verifiedAt, semanticRevision, incidentEpoch: activeIncidentEpoch, recoveryEpoch, environment: environmentToken(ctx) };
  }

  let display: ConnectionState['display'];
  if (needsAccess) display = 'needs-access';
  else if (healthUp === 'unreachable') display = 'unreachable';
  else if (healthUp === 'down') display = 'server-down';
  else if (identityMismatch) display = 'identity-mismatch';
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
    identities,
    workspace,
    authError: authResult === 'failed' ? authError : commandResult === 'failed' ? commandError : null,
    networkOffline,
    lastUpdate: lastSemanticUpdate,
    validation,
    verifiedAt,
    semanticRevision,
    incidentEpoch: activeIncidentEpoch,
    recoveryEpoch,
    environment: environmentToken(ctx),
  };
}

function isConfirmedIncident(display: ConnectionState['display']): boolean {
  return !['not-configured', 'checking', 'reconnecting', 'connected', 'online'].includes(display);
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
      verifiedAt = Date.now();
    } else {
      if (outcome.error.kind === 'cancelled') return;
      // A permission response (and other non-5xx HTTP rejection) proves the
      // command channel is alive. It is an operation result, not a connection
      // failure, so a denied edit must not turn the global status red.
      if (outcome.error.kind === 'permission'
        || (outcome.error.kind === 'http' && (outcome.error.status ?? 0) < 500)) return;
      commandResult = 'failed';
      commandError = outcome.error.message;
      verifiedAt = Date.now();
    }
    pushConnectionState();
    if (!outcome.ok && !authTestInFlight && ctx.hasPanel
      && healthUp !== 'down' && healthUp !== 'unreachable') {
      void runAuthTest('evidence-change');
    }
  });
}

export function pushConnectionState(): { incidentStarted: boolean; recovered: boolean } {
  let state = computeConnectionState();
  let incidentStarted = false;
  let recovered = false;
  if (isConfirmedIncident(state.display) && activeIncidentEpoch === 0) {
    activeIncidentEpoch = ++nextIncidentEpoch;
    incidentStarted = true;
  } else if (state.display === 'connected' && activeIncidentEpoch > 0) {
    recoveryEpoch = activeIncidentEpoch;
    activeIncidentEpoch = 0;
    recovered = true;
    // A confirmed command recovery can invalidate cached enrichment. Routine
    // Port repair and connected revalidation never reach this branch.
    incrementGeneration();
    getCtx().broadcastToContent({ type: 'RE_ENRICH' });
  }
  state = computeConnectionState();
  const semanticKey = JSON.stringify({
    display: state.display,
    identities: state.identities,
    version: state.version,
    blueprintSupported: state.blueprintSupported,
    responseMs: state.responseMs,
    profileLabel: state.profileLabel,
    workspace: state.workspace,
    authError: state.authError,
    networkOffline: state.networkOffline,
    validation: state.validation,
    incidentEpoch: state.incidentEpoch,
    recoveryEpoch: state.recoveryEpoch,
    environment: state.environment,
  });
  if (semanticKey === lastSemanticKey) {
    persistConnectionSnapshot(state);
    return { incidentStarted, recovered };
  }
  lastSemanticKey = semanticKey;
  semanticRevision++;
  lastSemanticUpdate = Date.now();
  state = computeConnectionState();
  updateBadge(state.display);
  const ctx = getCtx();
  traceConnectionDiagnostic({
    source: 'worker-state',
    profileId: ctx.settings.activeProfileId,
    semanticRevision: state.semanticRevision,
    decision: `publish:${state.display}:incident=${state.incidentEpoch ?? 0}:recovery=${state.recoveryEpoch ?? 0}`,
  });
  ctx.sendToPanel({ type: 'CONNECTION_STATE', state });
  persistConnectionSnapshot(state);
  ctx.broadcastToContent({ type: 'CONNECTION_STATE', state });
  return { incidentStarted, recovered };
}

/** Persist newly verified evidence even when its user-visible semantics did
 * not change. Quiet command successes intentionally avoid a panel broadcast,
 * but their fresher timestamp still needs to survive a worker restart. */
function persistConnectionSnapshot(state: ConnectionState): void {
  const ctx = getCtx();
  const snapshot = createConnectionSnapshot(state, ctx.settings);
  if (!snapshot) return;
  const signature = `${state.semanticRevision}:${state.verifiedAt}`;
  if (signature === lastSnapshotSignature) return;
  lastSnapshotSignature = signature;
  chrome.storage.session.set({ crev_conn_snapshot: snapshot }).catch(e => {
    if (lastSnapshotSignature === signature) lastSnapshotSignature = null;
    log.swallow('conn:snapshot', e);
  });
}

export type ConnectionValidationReason = 'explicit' | 'background' | 'evidence-change';

export function runAuthTest(reason: ConnectionValidationReason = 'explicit'): Promise<void> {
  const generationAtStart = connectionGeneration;
  if (authTestInFlight && authTestGeneration === generationAtStart) return authTestInFlight;
  const clientAtStart = getCtx().client;
  const task = runAuthTestInternal(generationAtStart, clientAtStart, reason);
  authTestInFlight = task;
  authTestGeneration = generationAtStart;
  const clear = () => {
    if (authTestInFlight === task) authTestInFlight = null;
  };
  void task.then(clear, clear);
  return task;
}

async function runAuthTestInternal(
  generationAtStart: number,
  clientAtStart: BmpClient | null,
  reason: ConnectionValidationReason,
): Promise<void> {
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
    markHostAccessRequired(); // no grant → command/identity probes would CORS-fail
    return;
  }
  if (connectionGeneration !== generationAtStart || ctx.client !== clientAtStart) return;
  needsAccess = false;
  if (!clientAtStart || ctx.client !== clientAtStart) {
    authResult = 'failed';
    authError = 'Connection client is not ready';
    authErrorCode = null;
    commandResult = 'unknown';
    validation = 'idle';
    verifiedAt = Date.now();
    pushConnectionState();
    return;
  }

  const retainConfirmed = authResult === 'ok' && commandResult === 'ok';
  validation = 'validating';
  if (!retainConfirmed) {
    authResult = 'pending';
    authError = null;
    authErrorCode = null;
    commandResult = 'probing';
    commandError = null;
  }
  pushConnectionState();
  if (reason === 'explicit') ctx.logActivity('info', 'Testing command connection\u2026');
  const hadIncident = activeIncidentEpoch > 0;
  try {
    // Resolve the browser actor before validating the command channel. When a
    // borrowed chain is unbound (legacy state) or belongs to another actor,
    // discard it first so this validation performs exactly one command login.
    let portalActor = await probePortalIdentity(bmpUrl);
    if (connectionGeneration !== generationAtStart || ctx.client !== clientAtStart) return;
    let reconcileKey: string | null = null;
    if (profile.commandAuthMode === 'portal' && portalActor.status === 'connected' && portalActor.user
      && clientAtStart.portalActor !== portalActor.user) {
      const previousActor = clientAtStart.portalActor ?? 'unbound';
      const candidateKey = `${generationAtStart}|${profile.id}|${previousActor}|${portalActor.user}`;
      if (!identityReconcileKeys.has(candidateKey)) {
        identityReconcileKeys.add(candidateKey);
        reconcileKey = candidateKey;
        clientAtStart.logout();
      }
    }

    let result: ConnectionResult;
    if (profile.commandAuthMode === 'portal' && portalActor.status === 'unavailable') {
      const signoutKey = `${profile.id}|signed-out`;
      if (!identityReconcileKeys.has(signoutKey)) {
        identityReconcileKeys.add(signoutKey);
        clientAtStart.logout();
      }
      result = {
        ok: false,
        authenticated: false,
        code: 'needs-login',
        message: portalActor.error ?? 'No active BMP portal login.',
      };
    } else {
      if (portalActor.status === 'connected') identityReconcileKeys.delete(`${profile.id}|signed-out`);
      result = await clientAtStart.testConnection();
      if (connectionGeneration !== generationAtStart || ctx.client !== clientAtStart) return;
    }

    // Re-probe after minting before binding. This prevents a browser actor
    // switch during the login operation from attaching stale evidence.
    if (reconcileKey && result.authenticated) {
      const actorBeforeLogin = portalActor.status === 'connected' ? portalActor.user : null;
      portalActor = await probePortalIdentity(bmpUrl);
      if (connectionGeneration !== generationAtStart || ctx.client !== clientAtStart) return;
      if (actorBeforeLogin && portalActor.status === 'connected' && portalActor.user === actorBeforeLogin) {
        clientAtStart.bindPortalActor(portalActor.user);
      } else {
        identityReconcileKeys.delete(reconcileKey);
        // The command chain was minted while the browser actor changed (or
        // became unverifiable). It is not evidence for the actor visible now.
        // Retire it immediately and require a later bounded validation rather
        // than publishing Connected with sameUser=null.
        clientAtStart.logout();
        result = {
          ok: false,
          authenticated: false,
          code: 'auth-failed',
          message: 'The BMP portal user changed during authentication. Retry the connection.',
        };
      }
    } else if (reconcileKey) {
      identityReconcileKeys.delete(reconcileKey);
    }
    const commandSource = profile.commandAuthMode === 'stored' ? 'stored-login' : 'portal-session';
    const mapIdentity = () => {
      const commandUser = clientAtStart.commandUser
        ?? (profile.commandAuthMode !== 'stored' && portalActor.status === 'connected' ? portalActor.user : null);
      const mapped = withSameUser({
        portal: portalActor,
        command: result.authenticated && commandUser
          ? { status: 'connected' as const, user: commandUser, source: commandSource }
          : {
              status: result.authenticated ? 'failed' as const : 'unavailable' as const,
              user: null,
              source: commandSource,
              error: result.ok ? undefined : result.message,
            },
      });
      // The portal endpoint reports an actor RID while LoginTicket reports a
      // principal name (for example RID 366… versus "admin"). In borrowed
      // portal mode, compare the portal actor to the actor bound when the
      // command chain was minted; raw string equality is not meaningful.
      if (profile.commandAuthMode === 'portal') {
        const boundActor = clientAtStart.portalActor;
        return {
          ...mapped,
          sameUser: portalActor.status === 'connected' && result.authenticated && boundActor
            ? boundActor === portalActor.user
            : null,
        };
      }
      return mapped;
    };
    identities = mapIdentity();
    identityMismatch = profile.commandAuthMode === 'portal' && identities.sameUser === false;
    setCurrentIdentities(identities);
    authResult = result.authenticated ? 'ok' : 'failed';
    authError = result.ok ? null : result.message;
    authErrorCode = result.authenticated ? null : (result.code ?? null);
    commandResult = result.ok ? 'ok' : result.authenticated ? 'failed' : 'unknown';
    commandError = result.ok ? null : result.authenticated ? result.message : null;
    if (result.ok && !healthVersion) {
      healthVersion = await BmpClient.getBuildNumber(bmpUrl, clientAtStart.jwt ?? undefined);
      if (connectionGeneration !== generationAtStart || ctx.client !== clientAtStart) return;
      applyVersionFlags(healthVersion, healthVersion ? undefined : '/buildNum not available');
    }
  } catch (e) {
    if (connectionGeneration !== generationAtStart || ctx.client !== clientAtStart) return;
    if (e instanceof HostAccessError) {
      markHostAccessRequired();
      return;
    }
    authResult = 'failed';
    authError = errorMessage(e);
    authErrorCode = null;
    identities = withSameUser({
      portal: identities.portal,
      command: {
        status: 'failed',
        user: null,
        source: profile.commandAuthMode === 'stored' ? 'stored-login' : 'portal-session',
        error: errorMessage(e),
      },
    });
    setCurrentIdentities(identities);
    commandResult = 'unknown';
    commandError = null;
  }
  validation = 'idle';
  verifiedAt = Date.now();
  const transition = pushConnectionState();
  if (reason === 'explicit') {
    const state = computeConnectionState();
    ctx.logActivity(state.display === 'connected' ? 'success' : 'warn',
      state.display === 'connected' ? `Connection test passed for ${profile.label}` : 'Connection failed',
      state.authError ?? undefined);
  }
  if (hadIncident && transition.recovered) {
    ctx.logActivity('success', `Connected to ${profile.label}`);
  } else if (transition.incidentStarted && reason !== 'explicit') {
    ctx.logActivity('warn', 'Connection problem detected', computeConnectionState().authError ?? undefined);
  }
}

export function pollHealth(force = false): Promise<void> {
  const generationAtStart = connectionGeneration;
  if (healthPollInFlight && healthPollGeneration === generationAtStart) return healthPollInFlight;
  // Skip if recently polled (prevents double-polls from online event + timer)
  const now = Date.now();
  if (!force && now - lastPollTime < CONNECTION_FRESHNESS_TARGET * 0.8) return Promise.resolve();
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
    if (e instanceof HostAccessError) {
      markHostAccessRequired();
      return;
    }
    log.swallow('connection:pollHealth', e);
    healthUp = 'unreachable';
    healthResponseMs = null;
  }
  pushConnectionState();
}

/** Start the panel-owned connection monitor without disturbing a monitor or
 *  verified command channel that is already live. A newly opened second panel
 *  and a replacement panel both use the existing state; only the first panel
 *  after an idle/no-panel period needs to resume monitoring. */
export function ensureConnectionMonitoring() {
  if (validation !== 'validating'
    && verifiedAt && Date.now() - verifiedAt < CONNECTION_FRESHNESS_TARGET) {
    pushConnectionState();
    return;
  }
  void validateConnection('background');
}

/** Coalesced event-driven validation. Reachability stays pure and identity is
 * reconciled only in the explicit auth operation. */
export async function validateConnection(reason: ConnectionValidationReason = 'background'): Promise<void> {
  await Promise.all([pollHealth(true), runAuthTest(reason)]);
}

/** Restore scope-matching confirmed evidence before the first publication of
 * a rebuilt worker/client. The next attach validates it quietly. */
export async function restoreConnectionEvidence(): Promise<void> {
  const ctx = getCtx();
  const raw = await chrome.storage.session.get('crev_conn_snapshot').catch(() => ({} as Record<string, unknown>));
  const state = provisionalConnectionSnapshot((raw as Record<string, unknown>).crev_conn_snapshot, ctx.settings);
  if (!state) return;
  identities = state.identities;
  setCurrentIdentities(identities);
  healthVersion = state.version;
  healthResponseMs = state.responseMs;
  networkOffline = state.networkOffline;
  needsAccess = state.display === 'needs-access';
  healthUp = state.display === 'server-down' ? 'down'
    : state.display === 'unreachable' ? 'unreachable'
      : state.display === 'connected' || state.display === 'online' || state.display === 'identity-mismatch' ? 'up' : 'unknown';
  authResult = ['connected', 'command-failed', 'identity-mismatch'].includes(state.display) ? 'ok'
    : ['auth-failed', 'needs-login', 'no-config-access'].includes(state.display) ? 'failed' : 'pending';
  authErrorCode = state.display === 'needs-login' ? 'needs-login'
    : state.display === 'no-config-access' ? 'no-config-access' : null;
  commandResult = state.display === 'connected' || state.display === 'identity-mismatch' ? 'ok'
    : state.display === 'command-failed' ? 'failed' : 'unknown';
  authError = state.authError;
  commandError = state.display === 'command-failed' || state.display === 'identity-mismatch' ? state.authError : null;
  identityMismatch = state.display === 'identity-mismatch';
  validation = 'validating';
  verifiedAt = state.verifiedAt ?? null;
  semanticRevision = state.semanticRevision ?? 0;
  lastSemanticUpdate = state.lastUpdate;
  nextIncidentEpoch = Math.max(state.incidentEpoch ?? 0, state.recoveryEpoch ?? 0);
  activeIncidentEpoch = state.incidentEpoch ?? 0;
  recoveryEpoch = state.recoveryEpoch ?? 0;
  lastSemanticKey = null;
  lastSnapshotSignature = `${state.semanticRevision}:${state.verifiedAt}`;
}
