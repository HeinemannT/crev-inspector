/**
 * Profile and settings CRUD handlers.
 */

import { register } from '../handler-registry';
import { getCtx } from '../sw-context';
import { invalidateColorSets } from '../color-set-cache';
import { activateProfile, saveSettings, rebuildClient, setManualOverride, snapshotSettings, evictPooledClient } from '../settings';
import { computeConnectionState, validateConnection } from '../connection';
import { reconcileProfileOrigins } from '../site-access';
import { log } from '../logger';

/** Keep host grants equal to BMP profile origins plus the selected AI provider origin.
 *  Profile changes revoke orphaned grants and re-sync content-script registrations. */
const reconcileAccess = (): void => {
  const ctx = getCtx();
  void reconcileProfileOrigins(ctx.settings.profiles.map(p => p.bmpUrl), ctx.settings.ai);
};

register('GET_SETTINGS', (msg, respond) => {
  respond({ type: 'SETTINGS_DATA', settings: getCtx().settings });
  snapshotSettings();
});

// Settings that don't affect the BMP client/auth — changing only these skips
// the (re-auth) client rebuild.
const CLIENT_IRRELEVANT_SETTINGS = new Set([
  'enrichMode',
  'commandAuthMigrationNotices',
]);

register('SAVE_SETTINGS', async (msg) => {
  const ctx = getCtx();
  const changedKeys = Object.keys(msg.settings);
  const skipRebuild = changedKeys.length > 0 && changedKeys.every(k => CLIENT_IRRELEVANT_SETTINGS.has(k));
  const prevMode = ctx.settings.enrichMode;
  ctx.settings = { ...ctx.settings, ...msg.settings };
  void saveSettings();
  if (ctx.settings.enrichMode !== prevMode) {
    ctx.broadcastToContent({ type: 'ENRICH_MODE', mode: ctx.settings.enrichMode });
  }
  if (!skipRebuild) await rebuildClient();
});

register('SAVE_PROFILE', async (msg, respond) => {
  const ctx = getCtx();
  const profiles = [...ctx.settings.profiles];
  const idx = profiles.findIndex(p => p.id === msg.profile.id);
  const previous = idx >= 0 ? profiles[idx] : undefined;
  const authChanged = !previous
    || previous.bmpUrl !== msg.profile.bmpUrl
    || previous.bmpUser !== msg.profile.bmpUser
    || previous.bmpPass !== msg.profile.bmpPass
    || (previous.commandAuthMode ?? 'portal') !== (msg.profile.commandAuthMode ?? 'portal');
  const profile = {
    ...msg.profile,
    commandAuthMode: msg.profile.commandAuthMode ?? 'portal',
    commandAuthRevision: authChanged
      ? crypto.randomUUID()
      : previous?.commandAuthRevision ?? msg.profile.commandAuthRevision ?? crypto.randomUUID(),
  };
  if (authChanged && previous) evictPooledClient(previous.id);
  if (idx >= 0) profiles[idx] = profile; else profiles.push(profile);
  let activeId = ctx.settings.activeProfileId;
  if (!activeId || profiles.length === 1) activeId = profile.id;
  ctx.settings = { ...ctx.settings, profiles, activeProfileId: activeId };
  void saveSettings();
  reconcileAccess(); // an edited URL orphans its old origin; the new one was requested in the panel
  await rebuildClient(true);
  respond({ type: 'SETTINGS_DATA', settings: ctx.settings });
  snapshotSettings();
});

register('DELETE_PROFILE', async (msg, respond) => {
  const ctx = getCtx();
  const profiles = ctx.settings.profiles.filter(p => p.id !== msg.profileId);
  let activeId = ctx.settings.activeProfileId;
  if (activeId === msg.profileId) activeId = profiles[0]?.id ?? '';
  ctx.settings = { ...ctx.settings, profiles, activeProfileId: activeId };
  void saveSettings();
  // Drop the pooled client + JWT before the rebuild so we don't hand
  // out a stale client for a now-deleted profile.
  evictPooledClient(msg.profileId);
  await rebuildClient(true);
  const orphanKeys = ['cache', 'cache_date', 'history', 'favorites', 'script_history', 'style_presets']
    .map(k => `crev_${msg.profileId}_${k}`);
  chrome.storage.local.remove(orphanKeys).catch(e => log.swallow('handler:cleanupProfile', e));
  reconcileAccess(); // revoke the deleted profile's origin (unless another profile shares it)
  respond({ type: 'SETTINGS_DATA', settings: ctx.settings });
  snapshotSettings();
});

register('SET_ACTIVE_PROFILE', async (msg, respond) => {
  const ctx = getCtx();
  if (ctx.settings.activeProfileId !== msg.profileId) {
    const previousId = ctx.settings.activeProfileId;
    const profile = ctx.settings.profiles.find(p => p.id === msg.profileId);
    if (!profile) return;
    // Suppress auto-detect back to whatever the user just *switched away
    // from* — not the profile they picked. Picking dev while on the sbx
    // tab should keep dev "sticky" against sbx URL matches, not against
    // prod URL matches.
    if (previousId) setManualOverride(previousId);
    invalidateColorSets(); // colours are per-workspace — drop the SW cache so the new profile refetches
    if (!(await activateProfile(msg.profileId, { clearCache: true }))) return;
    respond({ type: 'SETTINGS_DATA', settings: ctx.settings });
  }
});

register('CONNECTION_TEST', () => {
  void validateConnection('explicit');
});

register('GET_CONNECTION_STATE', (_msg, respond) => {
  respond({ type: 'CONNECTION_STATE', state: computeConnectionState() });
});
