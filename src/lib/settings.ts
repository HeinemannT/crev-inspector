/**
 * Settings & profile management — extracted from service-worker.
 */

import type { InspectorSettings, ServerProfile } from './types';
import { getCtx } from './sw-context';
import { BmpClient } from './bmp-client';
import { resolveAuthMode, sessionTokenKey } from './bmp-auth';
import { normalizeUrl, resetConnectionState, pushConnectionState, runAuthTest, startHealthPolling, stopHealthPolling } from './connection';
import { incrementGeneration } from './enrichment';
import { clearAllContextRids } from './context-rid';
import { log } from './logger';
import { MANUAL_OVERRIDE_DURATION } from './constants';
import { encrypt, decrypt } from './crypto';

let resolveSettings: () => void;
let settingsReadyPromise: Promise<void>;
/** Per-profile manual override window. Auto-detect skips a profile when its
 *  override is still active — so manually picking "dev" on the sbx tab
 *  only suppresses detection back to sbx, not to prod. Previously this
 *  was a single global timestamp; one manual pick disabled auto-detect
 *  for every environment for 30 s. */
const manualOverrideUntil = new Map<string, number>();

/** Pool of warm BmpClient instances, one per profile. Switching between
 *  sbx/dev/prod tabs used to throw away the previous client (and its
 *  JWT) and re-authenticate from scratch on every cross-env hop. With
 *  the pool, dev → sbx → dev keeps the dev client warm so the second
 *  dev switch just swaps a pointer; runAuthTest's refresh-token fast
 *  path picks up the still-valid JWT. */
const clientPool = new Map<string, BmpClient>();

/** Profile-switch listeners — fired after `rebuildClient` resolves so
 *  per-profile UI state (context-menu compare-pivot title, etc.) can
 *  refresh without coupling those subsystems back to settings.ts. */
type ProfileSwitchListener = (profileId: string) => void;
const profileSwitchListeners: ProfileSwitchListener[] = [];
export function onProfileSwitch(fn: ProfileSwitchListener): void {
  profileSwitchListeners.push(fn);
}
function emitProfileSwitch(profileId: string): void {
  for (const fn of profileSwitchListeners) {
    try { fn(profileId); } catch (e) { log.swallow('settings:profileSwitchListener', e); }
  }
}
/** External handlers (SET_ACTIVE_PROFILE, SAVE_PROFILE, DELETE_PROFILE)
 *  reach in to fire the listener manually since they don't go through
 *  the autoDetectProfile path. */
export function fireProfileSwitch(profileId: string): void {
  emitProfileSwitch(profileId);
}

export function createSettingsReady(): { settingsReady: Promise<void>; resolveSettings: () => void } {
  settingsReadyPromise = new Promise<void>(r => { resolveSettings = r; });
  return { settingsReady: settingsReadyPromise, resolveSettings };
}

/** Apply schema migrations to a raw stored settings object, in place. Returns
 *  true if anything changed (so the caller can persist once). Pure + exported
 *  for unit testing — no ctx, no I/O.
 *  - v0 → v1: flat {bmpUrl,bmpUser,bmpPass} → a single profile in `profiles[]`.
 *  - v1 → v2: every profile gains an explicit `authMode` (password → `auto`,
 *    none → `session`). */
export function migrateStoredSettings(s: Record<string, unknown>): boolean {
  let migrated = false;
  if (!s.profiles && (s.bmpUrl || s.bmpUser)) {
    const id = crypto.randomUUID();
    s.profiles = [{ id, label: 'Default', bmpUrl: s.bmpUrl || '', bmpUser: s.bmpUser || '', bmpPass: s.bmpPass || '' }];
    s.activeProfileId = id;
    s.autoDetect = true;
    delete s.bmpUrl; delete s.bmpUser; delete s.bmpPass;
    s.schemaVersion = 1;
    migrated = true;
  }
  if (!s.schemaVersion) s.schemaVersion = 1;
  if ((s.schemaVersion as number) < 2 && Array.isArray(s.profiles)) {
    s.profiles = (s.profiles as ServerProfile[]).map(p => ({ ...p, authMode: resolveAuthMode(p) }));
    s.schemaVersion = 2;
    migrated = true;
  }
  return migrated;
}

export async function loadSettingsFrom(stored: unknown): Promise<void> {
  const ctx = getCtx();
  let migrated = false;
  try {
    if (stored && typeof stored === 'object') {
      const s = stored as Record<string, unknown>;
      migrated = migrateStoredSettings(s);
      ctx.settings = { ...ctx.settings, ...s } as InspectorSettings;
      // Defend against malformed stored data — a non-array `profiles` would
      // throw in the map below and silently wipe settings. Recover to empty.
      if (!Array.isArray(ctx.settings.profiles)) ctx.settings.profiles = [];
      // Decrypt passwords after loading from storage
      ctx.settings.profiles = await Promise.all(ctx.settings.profiles.map(async p => ({
        ...p,
        bmpPass: p.bmpPass ? await decrypt(p.bmpPass) : '',
      })));
    }
    await rebuildClient();
    // Persist a migration once so stored data advances (idempotent re-runs each
    // boot are harmless, but read-only users would otherwise stay at v1 forever).
    if (migrated) void saveSettings();
  } catch (e) {
    log.swallow('settings:load', e);
  }
  resolveSettings();
}

let saveChain: Promise<void> = Promise.resolve();

export function saveSettings(): Promise<void> {
  // Serialize — concurrent saves must not interleave encrypt/write
  saveChain = saveChain.then(async () => {
    try {
      const settings = getCtx().settings;
      const profiles = await Promise.all(settings.profiles.map(async p => ({
        ...p,
        bmpPass: p.bmpPass ? await encrypt(p.bmpPass) : '',
      })));
      await chrome.storage.local.set({ crev_settings: { ...settings, profiles } });
    } catch (e) { log.swallow('settings:save', e); }
  });
  return saveChain;
}

/** Snapshot settings to session storage for instant panel boot.
 *
 *  Passwords are STRIPPED before writing — the snapshot is just enough to
 *  render the connect-tab UI structure (profile list, labels, URLs, active
 *  ID, autoDetect / enrichMode toggles). The panel re-requests full settings
 *  via GET_SETTINGS during boot (sidepanel.ts), and the SW response carries
 *  the decrypted password in memory only. This way an attacker who only
 *  reads chrome.storage.session never sees plaintext credentials. */
export function snapshotSettings(): void {
  const s = getCtx().settings;
  const sanitized = {
    ...s,
    profiles: s.profiles.map(p => ({ ...p, bmpPass: '' })),
  };
  chrome.storage.session.set({ crev_settings_snapshot: sanitized }).catch(e => log.swallow('settings:snapshot', e));
}

export function getActiveProfile() {
  const ctx = getCtx();
  return ctx.settings.profiles.find(p => p.id === ctx.settings.activeProfileId);
}

let rebuildInFlight: Promise<void> | null = null;

export async function rebuildClient(clearCache = false) {
  // Serialize — rapid profile switches must not overlap
  if (rebuildInFlight) await rebuildInFlight;
  const p = rebuildClientInternal(clearCache);
  rebuildInFlight = p;
  try { await p; } finally { rebuildInFlight = null; }
}

/** Get a warm BmpClient for the profile, or construct one. Returned clients
 *  are kept in `clientPool` so subsequent switches are pointer-swaps rather
 *  than fresh constructions. If credentials changed (rename / re-key on
 *  same profileId) we evict the stale entry and rebuild. */
function getOrCreateClient(profile: ServerProfile): BmpClient {
  const bmpUrl = normalizeUrl(profile.bmpUrl);
  const authMode = resolveAuthMode(profile);
  const existing = clientPool.get(profile.id);
  // Stale if the URL, username, or auth mode changed under the same profileId.
  // Password changes don't invalidate the in-memory JWT — refresh handles that;
  // but a mode flip (session ↔ password) changes which strategy runs, so the
  // mode must match for reuse.
  if (existing && existing.serverUrl === bmpUrl && existing.username === profile.bmpUser && existing.authMode === authMode) {
    // Refresh password in case it was rotated since the client was minted.
    existing.updateCredentials(profile.bmpUser, profile.bmpPass, authMode);
    return existing;
  }
  if (existing) {
    existing.logout();
    clientPool.delete(profile.id);
  }
  const client = new BmpClient(bmpUrl, profile.bmpUser, profile.bmpPass, profile.id, authMode);
  clientPool.set(profile.id, client);
  return client;
}

/** Evict a profile from the pool (called when the profile is deleted). */
export function evictPooledClient(profileId: string): void {
  const c = clientPool.get(profileId);
  if (c) { c.logout(); clientPool.delete(profileId); }
}

/** When a BMP session cookie is removed (the user logged out, or it expired),
 *  any profile whose LIVE connection was borrowed from that session must drop
 *  its minted token chain — otherwise the extension keeps Configuration Access
 *  after the user logged out.
 *
 *  Robustness notes:
 *  - Only `explicit` (logout / API removal) and `expired` (true expiry) mean the
 *    session is gone. `overwrite` / `expired_overwrite` (a cookie being
 *    replaced, e.g. on session refresh, or by our own password login) and
 *    `evicted` (jar pressure) are NOT logouts and must not tear down.
 *  - Gated on `settingsReady`: a removal arriving during SW boot must not be
 *    evaluated against empty settings (it would be silently dropped, leaving a
 *    usable token behind).
 *  - Rather than hand-matching the event's domain/path (which mis-fires on
 *    `/Foo` vs `/Foo2`, ports, and domain cookies), we RE-PROBE each candidate
 *    profile's own cookie via `chrome.cookies.get({url: bmpUrl})` — that applies
 *    RFC-correct host+path scoping for free.
 *  - "Borrowed" = a `session`-mode profile, or an `auto` profile whose pooled
 *    client actually connected via the session (`authVia === 'session'`). A
 *    password-authed connection holds its own chain and is left alone. */
export async function handleSessionCookieRemoved(info: chrome.cookies.CookieChangeInfo): Promise<void> {
  if (info.cookie.name !== 'JSESSIONID' || !info.removed) return;
  if (info.cause !== 'explicit' && info.cause !== 'expired') return;

  const ctx = getCtx();
  await ctx.settingsReady;

  for (const p of ctx.settings.profiles) {
    const client = clientPool.get(p.id);
    const borrowed = resolveAuthMode(p) === 'session' || client?.authVia === 'session';
    if (!borrowed) continue;

    let stillPresent = false;
    try {
      stillPresent = (await chrome.cookies.get({ url: normalizeUrl(p.bmpUrl), name: 'JSESSIONID' })) != null;
    } catch (e) { log.warn('settings:cookieReprobe', e, 'cookie re-probe failed; treating as gone'); }
    if (stillPresent) continue;  // the cookie that changed wasn't this profile's

    client?.logout();
    // Clear the persisted chain even when no client is pooled (logout already
    // does this for a pooled client; this covers a warm-but-unpooled profile).
    chrome.storage.session.remove(sessionTokenKey(p.id)).catch(e => log.swallow('settings:clearTeardownToken', e));
    log.info('settings:sessionCookieGone', `BMP session ended for ${p.label}; cleared the borrowed token`);
    if (p.id === ctx.settings.activeProfileId) {
      resetConnectionState();
      if (ctx.hasPanel) void runAuthTest(); else pushConnectionState();
    }
  }
}

async function rebuildClientInternal(clearCache: boolean) {
  const ctx = getCtx();
  const profile = getActiveProfile();

  // A URL is the only hard requirement now — a `session` profile carries no
  // username (it borrows the browser session), so gating on bmpUser would
  // wrongly null out the client for SSO/session profiles.
  if (profile?.bmpUrl) {
    ctx.client = getOrCreateClient(profile);
    ctx.client.cache = ctx.cache;
  } else {
    ctx.client = null;
  }
  if (clearCache) {
    ctx.cache.clear();
    ctx.sendToPanel({ type: 'CACHE_STATS', count: 0 });
  }
  // Switch storage FIRST — cache must point to new profile before
  // incrementGeneration() allows new enrichment to write to it.
  const newProfileId = profile?.id ?? '_default';
  await Promise.all([
    ctx.cache.switchProfile(newProfileId).catch(e => log.swallow('settings:switchCache', e)),
    ctx.history.switchProfile(newProfileId).catch(e => log.swallow('settings:switchHistory', e)),
    ctx.favorites.switchProfile(newProfileId).catch(e => log.swallow('settings:switchFavorites', e)),
    ctx.scriptHistory.switchProfile(newProfileId).catch(e => log.swallow('settings:switchScriptHistory', e)),
    ctx.stylePresets.switchProfile(newProfileId).catch(e => log.swallow('settings:switchStylePresets', e)),
  ]);
  // NOW safe to open the gate for new enrichment
  incrementGeneration();

  resetConnectionState();
  if (ctx.hasPanel) {
    stopHealthPolling();
    startHealthPolling();
    void runAuthTest(); // pushes CONNECTION_STATE on completion — intentionally not awaited
  } else {
    pushConnectionState(); // no panel = no runAuthTest, push once for content scripts
  }
}

/** Tracks the in-flight auto-switch's target so rapid alt-tabs through
 *  multiple environments don't pile up redundant rebuilds. Only the
 *  most recent target matters — if the user is now on sbx but a dev
 *  rebuild is still mid-flight, we let it finish (the cache/JWT for
 *  dev is harmless to warm), then fire one more rebuild for sbx. */
let inflightAutoDetectTarget: string | null = null;

/** Best-match profile for a page URL, or null. Picks the LONGEST matching
 *  prefix to avoid the "first-match wins" bug when one profile's URL is a
 *  prefix of another (e.g. `https://x.de/A` vs `https://x.de/A/B`). */
export function matchProfile(pageUrl: string, profiles: ServerProfile[]): ServerProfile | null {
  let best: { profile: ServerProfile; len: number } | null = null;
  for (const p of profiles) {
    const base = normalizeUrl(p.bmpUrl).replace(/\/+$/, '');
    if (base && pageUrl.startsWith(base) && (!best || base.length > best.len)) {
      best = { profile: p, len: base.length };
    }
  }
  return best?.profile ?? null;
}

export async function autoDetectProfile(pageUrl: string) {
  const ctx = getCtx();
  if (!ctx.settings.autoDetect || ctx.settings.profiles.length === 0) return;

  const matched = matchProfile(pageUrl, ctx.settings.profiles);
  if (!matched) return;

  if (matched.id === ctx.settings.activeProfileId) return;

  // Per-profile manual override — when the user explicitly picks dev
  // (while on sbx), we set an override on sbx so alt-tabbing back to
  // the sbx tab doesn't undo the manual pick. But prod still wins on
  // a prod tab — its override is fresh, so the auto-switch proceeds.
  // Previously this was a single global timestamp that blocked *every*
  // auto-detect for 30 s.
  const overrideUntil = manualOverrideUntil.get(matched.id) ?? 0;
  if (overrideUntil > Date.now()) return;

  // Dedupe: if we're already rebuilding *for the same target*, skip.
  // Three rapid alt-tabs (sbx → dev → prod → dev) used to enqueue all
  // four; now the second "dev" exits immediately since the first is
  // still in flight.
  if (inflightAutoDetectTarget === matched.id) return;
  inflightAutoDetectTarget = matched.id;
  try {
    ctx.settings = { ...ctx.settings, activeProfileId: matched.id };
    void saveSettings();
    // Workspace changed — drop per-tab context RIDs (they belong to the old
    // workspace and would resolve to wrong/missing objects in the new one).
    clearAllContextRids();
    // clearCache=false — `switchProfile` already swaps cache stores
    // atomically, and the in-memory entries from the old profile would
    // get re-fetched on next view anyway. Wiping in-memory cache here
    // dropped the heavy code-field shadow copies (expression/html/js/
    // css) that `NON_PERSISTED_PROPS` keeps for the active session.
    await rebuildClient(false);
    ctx.sendToPanel({ type: 'PROFILE_SWITCHED', profileId: matched.id, label: matched.label });
    ctx.broadcastToContent({ type: 'PROFILE_SWITCHED', profileId: matched.id, label: matched.label });
    ctx.sendToPanel({ type: 'SETTINGS_DATA', settings: ctx.settings });
    snapshotSettings();
    emitProfileSwitch(matched.id);
  } finally {
    if (inflightAutoDetectTarget === matched.id) inflightAutoDetectTarget = null;
  }
}

/** Set a 30 s "don't auto-detect back to this profile" timer. Caller
 *  passes the profile the user was switching AWAY from — i.e. the
 *  pre-pick active profile — so that alt-tabbing back to that
 *  profile's URL won't undo the manual pick. Auto-detect to OTHER
 *  profiles is unaffected, which is the whole point of scoping it
 *  per-profile (previously a single global timestamp blocked
 *  detection across every environment for 30 s). */
export function setManualOverride(suppressedProfileId: string) {
  if (!suppressedProfileId) return;
  manualOverrideUntil.set(suppressedProfileId, Date.now() + MANUAL_OVERRIDE_DURATION);
}
