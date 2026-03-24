/**
 * Profile and settings CRUD handlers.
 */

import { register } from '../handler-registry';
import { getCtx } from '../sw-context';
import { saveSettings, rebuildClient, setManualOverride, snapshotSettings } from '../settings';
import { pushConnectionState, runAuthTest } from '../connection';
import { log } from '../logger';

register('GET_SETTINGS', (msg, respond) => {
  const ctx = getCtx();
  ctx.settingsReady.then(() => {
    respond({ type: 'SETTINGS_DATA', settings: ctx.settings });
    snapshotSettings();
  });
}, true);

register('SAVE_SETTINGS', async (msg) => {
  const ctx = getCtx();
  const onlyEnrichMode = Object.keys(msg.settings).length === 1 && 'enrichMode' in msg.settings;
  const prevMode = ctx.settings.enrichMode;
  ctx.settings = { ...ctx.settings, ...msg.settings };
  saveSettings();
  if (ctx.settings.enrichMode !== prevMode) {
    ctx.broadcastToContent({ type: 'ENRICH_MODE', mode: ctx.settings.enrichMode });
  }
  if (!onlyEnrichMode) await rebuildClient();
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
}, true);

register('DELETE_PROFILE', async (msg, respond) => {
  const ctx = getCtx();
  const profiles = ctx.settings.profiles.filter(p => p.id !== msg.profileId);
  let activeId = ctx.settings.activeProfileId;
  if (activeId === msg.profileId) activeId = profiles[0]?.id ?? '';
  ctx.settings = { ...ctx.settings, profiles, activeProfileId: activeId };
  saveSettings();
  await rebuildClient(true);
  const orphanKeys = ['cache', 'cache_date', 'history', 'favorites', 'script_history']
    .map(k => `crev_${msg.profileId}_${k}`);
  chrome.storage.local.remove(orphanKeys).catch(e => log.swallow('handler:cleanupProfile', e));
  respond({ type: 'SETTINGS_DATA', settings: ctx.settings });
  snapshotSettings();
}, true);

register('SET_ACTIVE_PROFILE', async (msg, respond) => {
  const ctx = getCtx();
  if (ctx.settings.activeProfileId !== msg.profileId) {
    const profile = ctx.settings.profiles.find(p => p.id === msg.profileId);
    ctx.settings = { ...ctx.settings, activeProfileId: msg.profileId };
    setManualOverride();
    saveSettings();
    await rebuildClient(true);
    respond({ type: 'SETTINGS_DATA', settings: ctx.settings });
    snapshotSettings();
    if (profile) {
      ctx.broadcastToContent({ type: 'PROFILE_SWITCHED', profileId: msg.profileId, label: profile.label });
    }
  }
}, true);

register('CONNECTION_TEST', () => {
  runAuthTest();
});

register('GET_CONNECTION_STATE', () => {
  pushConnectionState();
});
