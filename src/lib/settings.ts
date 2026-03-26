/**
 * Settings & profile management — extracted from service-worker.
 */

import type { InspectorSettings, ServerProfile } from './types';
import { getCtx } from './sw-context';
import { DEFAULT_SETTINGS } from './types';
import { BmpClient } from './bmp-client';
import { normalizeUrl, resetConnectionState, pushConnectionState, runAuthTest, startHealthPolling, stopHealthPolling } from './connection';
import { incrementGeneration } from './enrichment';
import { log } from './logger';
import { MANUAL_OVERRIDE_DURATION } from './constants';
import { encrypt, decrypt } from './crypto';

let resolveSettings: () => void;
let settingsReadyPromise: Promise<void>;
let manualOverrideUntil = 0;

export function createSettingsReady(): { settingsReady: Promise<void>; resolveSettings: () => void } {
  settingsReadyPromise = new Promise<void>(r => { resolveSettings = r; });
  return { settingsReady: settingsReadyPromise, resolveSettings };
}

export async function loadSettingsFrom(stored: unknown): Promise<void> {
  const ctx = getCtx();
  try {
    if (stored && typeof stored === 'object') {
      const s = stored as Record<string, unknown>;
      // v0 → v1: Migrate old flat fields → profiles array
      if (!s.profiles && (s.bmpUrl || s.bmpUser)) {
        const id = crypto.randomUUID();
        s.profiles = [{
          id,
          label: 'Default',
          bmpUrl: s.bmpUrl || '',
          bmpUser: s.bmpUser || '',
          bmpPass: s.bmpPass || '',
        }];
        s.activeProfileId = id;
        s.autoDetect = true;
        delete s.bmpUrl;
        delete s.bmpUser;
        delete s.bmpPass;
        s.schemaVersion = 1;
      }
      if (!s.schemaVersion) s.schemaVersion = 1;
      ctx.settings = { ...ctx.settings, ...s } as InspectorSettings;
      // Decrypt passwords after loading from storage
      ctx.settings.profiles = await Promise.all(ctx.settings.profiles.map(async p => ({
        ...p,
        bmpPass: p.bmpPass ? await decrypt(p.bmpPass) : '',
      })));
    }
    await rebuildClient();
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

/** Snapshot settings to session storage for instant panel boot */
export function snapshotSettings(): void {
  chrome.storage.session.set({ crev_settings_snapshot: getCtx().settings }).catch(e => log.swallow('settings:snapshot', e));
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

async function rebuildClientInternal(clearCache: boolean) {
  const ctx = getCtx();
  const profile = getActiveProfile();
  const oldClient = ctx.client;

  if (profile?.bmpUrl && profile?.bmpUser) {
    const bmpUrl = normalizeUrl(profile.bmpUrl);
    ctx.client = new BmpClient(bmpUrl, profile.bmpUser, profile.bmpPass, profile.id);
    ctx.client.cache = ctx.cache;
    // Transfer auth from old client to avoid unnecessary re-authentication (same server only)
    if (oldClient?.jwt && oldClient.serverUrl === bmpUrl) {
      ctx.client.absorbAuth(oldClient);
    }
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
  ]);
  // NOW safe to open the gate for new enrichment
  incrementGeneration();

  resetConnectionState();
  if (ctx.panelPort) {
    stopHealthPolling();
    startHealthPolling();
    runAuthTest(); // pushes CONNECTION_STATE on completion — intentionally not awaited
  } else {
    pushConnectionState(); // no panel = no runAuthTest, push once for content scripts
  }
}

export async function autoDetectProfile(pageUrl: string) {
  const ctx = getCtx();
  if (!ctx.settings.autoDetect || ctx.settings.profiles.length === 0) return;

  if (manualOverrideUntil > Date.now()) {
    const active = getActiveProfile();
    if (active) {
      const activeBase = normalizeUrl(active.bmpUrl).replace(/\/+$/, '');
      if (activeBase && pageUrl.startsWith(activeBase)) {
        manualOverrideUntil = 0;
      }
    }
    if (manualOverrideUntil > Date.now()) return;
  }

  for (const p of ctx.settings.profiles) {
    const base = normalizeUrl(p.bmpUrl).replace(/\/+$/, '');
    if (base && pageUrl.startsWith(base)) {
      if (p.id !== ctx.settings.activeProfileId) {
        ctx.settings = { ...ctx.settings, activeProfileId: p.id };
        saveSettings();
        await rebuildClient(true);
        ctx.sendToPanel({ type: 'PROFILE_SWITCHED', profileId: p.id, label: p.label });
        ctx.broadcastToContent({ type: 'PROFILE_SWITCHED', profileId: p.id, label: p.label });
        ctx.sendToPanel({ type: 'SETTINGS_DATA', settings: ctx.settings });
        snapshotSettings();
      }
      return;
    }
  }
}

export function setManualOverride() {
  manualOverrideUntil = Date.now() + MANUAL_OVERRIDE_DURATION;
}
