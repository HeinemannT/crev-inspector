/**
 * Settings & profile management — extracted from service-worker.
 */

import type { InspectorSettings } from './types';
import { getCtx } from './sw-context';
import { DEFAULT_SETTINGS } from './types';
import { BmpClient } from './bmp-client';
import { normalizeUrl, resetConnectionState, pushConnectionState, runAuthTest, startHealthPolling, stopHealthPolling } from './connection';
import { incrementGeneration } from './enrichment';
import { log } from './logger';
import { MANUAL_OVERRIDE_DURATION } from './constants';

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
    }
    rebuildClient();
  } catch (e) {
    log.swallow('settings:load', e);
  }
  resolveSettings();
}

export async function saveSettings(): Promise<void> {
  try {
    await chrome.storage.local.set({ crev_settings: getCtx().settings });
  } catch (e) { log.swallow('settings:save', e); }
}

export function getActiveProfile() {
  const ctx = getCtx();
  return ctx.settings.profiles.find(p => p.id === ctx.settings.activeProfileId);
}

export function rebuildClient(clearCache = false) {
  const ctx = getCtx();
  incrementGeneration(); // bumps generation (cancels in-flight enrichment) + clears enrichedRids/permanentlyFailed
  const profile = getActiveProfile();
  const oldClient = ctx.client;

  if (profile?.bmpUrl && profile?.bmpUser) {
    const bmpUrl = normalizeUrl(profile.bmpUrl);
    ctx.client = new BmpClient(bmpUrl, profile.bmpUser, profile.bmpPass, profile.id);
    ctx.client.cache = ctx.cache;
    // Transfer auth from old client to avoid unnecessary re-authentication
    if (oldClient?.jwt) {
      ctx.client.absorbAuth(oldClient);
    }
  } else {
    ctx.client = null;
  }
  if (clearCache) {
    ctx.cache.clear();
    ctx.sendToPanel({ type: 'CACHE_STATS', count: 0 });
  }
  // Switch cache/history/favorites to new profile (no-op if profileId unchanged)
  const newProfileId = profile?.id ?? '_default';
  ctx.cache.switchProfile(newProfileId).catch(e => log.swallow('settings:switchCache', e));
  ctx.history.switchProfile(newProfileId).catch(e => log.swallow('settings:switchHistory', e));
  ctx.favorites.switchProfile(newProfileId).catch(e => log.swallow('settings:switchFavorites', e));
  ctx.scriptHistory.switchProfile(newProfileId).catch(e => log.swallow('settings:switchScriptHistory', e));

  resetConnectionState();
  pushConnectionState();
  if (ctx.panelPort) {
    stopHealthPolling();
    startHealthPolling();
    runAuthTest();
  }
}

export function autoDetectProfile(pageUrl: string) {
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
        rebuildClient(true);
        ctx.sendToPanel({ type: 'PROFILE_SWITCHED', profileId: p.id, label: p.label });
        ctx.broadcastToContent({ type: 'PROFILE_SWITCHED', profileId: p.id, label: p.label });
        ctx.sendToPanel({ type: 'SETTINGS_DATA', settings: ctx.settings });
      }
      return;
    }
  }
}

export function setManualOverride() {
  manualOverrideUntil = Date.now() + MANUAL_OVERRIDE_DURATION;
}
