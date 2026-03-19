/**
 * Per-profile favorites manager — star toggle for quick access to important objects.
 * Follows ObjectCache pattern: storage key namespacing, switchProfile(), debounced persist.
 */

import { log } from './logger';
import { FAVORITES_MAX, HISTORY_SAVE_DELAY } from './constants';

export interface FavoriteEntry {
  rid: string;
  name?: string;
  type?: string;
  businessId?: string;
  addedAt: number;
}

export class FavoritesManager {
  private entries: FavoriteEntry[] = [];
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private profileId: string;

  constructor(profileId = '_default') {
    this.profileId = profileId;
  }

  private get storageKey() { return `crev_${this.profileId}_favorites`; }

  async load(): Promise<void> {
    try {
      const result = await chrome.storage.local.get(this.storageKey);
      const data = result[this.storageKey] as FavoriteEntry[] | undefined;
      if (Array.isArray(data)) {
        this.entries = data.slice(0, FAVORITES_MAX);
      }
    } catch (e) {
      log.swallow('favorites:load', e);
    }
  }

  async switchProfile(newProfileId: string): Promise<void> {
    if (newProfileId === this.profileId) return;
    await this.persist();
    this.profileId = newProfileId;
    this.entries = [];
    await this.load();
  }

  /** Toggle favorite state. Returns new isFavorite state. */
  toggle(rid: string, meta?: { name?: string; type?: string; businessId?: string }): boolean {
    const idx = this.entries.findIndex(e => e.rid === rid);
    if (idx >= 0) {
      // Remove
      this.entries.splice(idx, 1);
      this.scheduleSave();
      return false;
    }
    // Add — reject if at cap
    if (this.entries.length >= FAVORITES_MAX) return false;
    this.entries.push({
      rid,
      name: meta?.name,
      type: meta?.type,
      businessId: meta?.businessId,
      addedAt: Date.now(),
    });
    this.scheduleSave();
    return true;
  }

  isFavorite(rid: string): boolean {
    return this.entries.some(e => e.rid === rid);
  }

  getAll(): FavoriteEntry[] {
    return this.entries;
  }

  remove(rid: string): void {
    const idx = this.entries.findIndex(e => e.rid === rid);
    if (idx >= 0) {
      this.entries.splice(idx, 1);
      this.scheduleSave();
    }
  }

  private scheduleSave() {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.persist();
    }, HISTORY_SAVE_DELAY);
  }

  private async persist() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    try {
      await chrome.storage.local.set({ [this.storageKey]: this.entries });
    } catch (e) {
      log.swallow('favorites:persist', e);
    }
  }
}
