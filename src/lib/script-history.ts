/**
 * Per-profile script history manager — tracks recently executed EC scripts.
 * Follows HistoryManager pattern: storage key namespacing, switchProfile(), immediate persist.
 */

import type { ScriptHistoryEntry } from './types';
import { log } from './logger';
import { SCRIPT_HISTORY_MAX } from './constants';

export class ScriptHistoryManager {
  private entries: ScriptHistoryEntry[] = [];
  private profileId: string;

  constructor(profileId = '_default') {
    this.profileId = profileId;
  }

  private get storageKey() { return `crev_${this.profileId}_script_history`; }

  async load(): Promise<void> {
    try {
      const result = await chrome.storage.local.get(this.storageKey);
      const data = result[this.storageKey] as ScriptHistoryEntry[] | undefined;
      if (Array.isArray(data)) {
        this.entries = data.slice(0, SCRIPT_HISTORY_MAX);
      }
    } catch (e) {
      log.swallow('scriptHistory:load', e);
    }
  }

  async switchProfile(newProfileId: string): Promise<void> {
    if (newProfileId === this.profileId) return;
    await this.persist();
    this.profileId = newProfileId;
    this.entries = [];
    await this.load();
  }

  /** Record a script execution. Caps at SCRIPT_HISTORY_MAX. Persists immediately. */
  record(entry: ScriptHistoryEntry): void {
    // Deduplicate by code (keep latest)
    this.entries = this.entries.filter(e => e.code !== entry.code);
    this.entries.unshift(entry);
    if (this.entries.length > SCRIPT_HISTORY_MAX) {
      this.entries = this.entries.slice(0, SCRIPT_HISTORY_MAX);
    }
    this.persist();
  }

  getAll(): ScriptHistoryEntry[] {
    return this.entries;
  }

  clear(): void {
    this.entries = [];
    this.persist();
  }

  private async persist() {
    try {
      await chrome.storage.local.set({ [this.storageKey]: this.entries });
    } catch (e) {
      log.swallow('scriptHistory:persist', e);
    }
  }
}
