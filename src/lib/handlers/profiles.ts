/**
 * Profile and settings CRUD handlers.
 */

import { register } from '../handler-registry';
import { getCtx } from '../sw-context';
import { clearAllContextRids } from '../context-rid';
import { saveSettings, rebuildClient, setManualOverride, snapshotSettings, evictPooledClient, fireProfileSwitch } from '../settings';
import { pushConnectionState, runAuthTest } from '../connection';
import { log } from '../logger';

register('GET_SETTINGS', (msg, respond) => {
  respond({ type: 'SETTINGS_DATA', settings: getCtx().settings });
  snapshotSettings();
});

// Settings that don't affect the BMP client/auth — changing only these skips
// the (re-auth) client rebuild.
const CLIENT_IRRELEVANT_SETTINGS = new Set(['enrichMode', 'paintProps']);

register('SAVE_SETTINGS', async (msg) => {
  const ctx = getCtx();
  const changedKeys = Object.keys(msg.settings);
  const skipRebuild = changedKeys.length > 0 && changedKeys.every(k => CLIENT_IRRELEVANT_SETTINGS.has(k));
  const prevMode = ctx.settings.enrichMode;
  ctx.settings = { ...ctx.settings, ...msg.settings };
  saveSettings();
  if (ctx.settings.enrichMode !== prevMode) {
    ctx.broadcastToContent({ type: 'ENRICH_MODE', mode: ctx.settings.enrichMode });
  }
  if (!skipRebuild) await rebuildClient();
});

register('SAVE_PROFILE', async (msg, respond) => {
  const ctx = getCtx();
  const profiles = [...ctx.settings.profiles];
  const idx = profiles.findIndex(p => p.id === msg.profile.id);
  if (idx >= 0) profiles[idx] = msg.profile; else profiles.push(msg.profile);
  let activeId = ctx.settings.activeProfileId;
  if (!activeId || profiles.length === 1) activeId = msg.profile.id;
  ctx.settings = { ...ctx.settings, profiles, activeProfileId: activeId };
  saveSettings();
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
  saveSettings();
  // Drop the pooled client + JWT before the rebuild so we don't hand
  // out a stale client for a now-deleted profile.
  evictPooledClient(msg.profileId);
  await rebuildClient(true);
  const orphanKeys = ['cache', 'cache_date', 'history', 'favorites', 'script_history']
    .map(k => `crev_${msg.profileId}_${k}`);
  chrome.storage.local.remove(orphanKeys).catch(e => log.swallow('handler:cleanupProfile', e));
  respond({ type: 'SETTINGS_DATA', settings: ctx.settings });
  snapshotSettings();
});

register('SET_ACTIVE_PROFILE', async (msg, respond) => {
  const ctx = getCtx();
  if (ctx.settings.activeProfileId !== msg.profileId) {
    const previousId = ctx.settings.activeProfileId;
    const profile = ctx.settings.profiles.find(p => p.id === msg.profileId);
    ctx.settings = { ...ctx.settings, activeProfileId: msg.profileId };
    // Suppress auto-detect back to whatever the user just *switched away
    // from* — not the profile they picked. Picking dev while on the sbx
    // tab should keep dev "sticky" against sbx URL matches, not against
    // prod URL matches.
    if (previousId) setManualOverride(previousId);
    saveSettings();
    // Workspace changed — per-tab context RIDs belong to the old workspace
    // and would resolve to wrong/missing objects in the new one.
    clearAllContextRids();
    await rebuildClient(true);
    respond({ type: 'SETTINGS_DATA', settings: ctx.settings });
    snapshotSettings();
    if (profile) {
      // Notify the panel (reset stale context/detail/layout) AND content.
      ctx.sendToPanel({ type: 'PROFILE_SWITCHED', profileId: msg.profileId, label: profile.label });
      ctx.broadcastToContent({ type: 'PROFILE_SWITCHED', profileId: msg.profileId, label: profile.label });
    }
    fireProfileSwitch(msg.profileId);
  }
});

register('CONNECTION_TEST', () => {
  runAuthTest();
});

register('GET_CONNECTION_STATE', () => {
  pushConnectionState();
});
