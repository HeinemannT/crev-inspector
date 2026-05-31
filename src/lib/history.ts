/**
 * Per-profile history manager — tracks recently interacted objects.
 * Follows ObjectCache pattern: storage key namespacing, switchProfile(), debounced persist.
 */

import { log } from './logger';
import { HISTORY_MAX, HISTORY_SAVE_DELAY } from './constants';

export interface HistoryEntry {
  rid: string;
  name?: string;
  type?: string;
  businessId?: string;
  action: 'viewed' | 'edited' | 'painted' | 'ec-executed';
  timestamp: number;
}

export class HistoryManager {
  private entries: HistoryEntry[] = [];
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private profileId: string;

  constructor(profileId = '_default') {
    this.profileId = profileId;
  }

  private get storageKey() { return `crev_${this.profileId}_history`; }

  async load(): Promise<void> {
    try {
      const result = await chrome.storage.local.get(this.storageKey);
      const data = result[this.storageKey] as HistoryEntry[] | undefined;
      if (Array.isArray(data)) {
        this.entries = data.slice(0, HISTORY_MAX);
      }
    } catch (e) {
      log.swallow('history:load', e);
    }
  }

  async switchProfile(newProfileId: string): Promise<void> {
    if (newProfileId === this.profileId) return;
    await this.persist();
    this.profileId = newProfileId;
    this.entries = [];
    await this.load();
  }

  /** Record an interaction. Deduplicates by RID (newest wins), caps at HISTORY_MAX. */
  record(entry: HistoryEntry): void {
    // Remove existing entry with same RID
    this.entries = this.entries.filter(e => e.rid !== entry.rid);
    // Push to front (most recent first)
    this.entries.unshift(entry);
    // Cap
    if (this.entries.length > HISTORY_MAX) {
      this.entries = this.entries.slice(0, HISTORY_MAX);
    }
    this.scheduleSave();
  }

  getAll(): HistoryEntry[] {
    return this.entries;
  }

  clear(): void {
    this.entries = [];
    this.scheduleSave();
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
      log.swallow('history:persist', e);
    }
  }
}
