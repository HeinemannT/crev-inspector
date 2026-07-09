/**
 * Per-profile saved-style library — named widget appearance presets for the blueprint paintbrush.
 * Follows the FavoritesManager pattern: `crev_<profileId>_style_presets` storage key, switchProfile(),
 * debounced persist. Colours are CorpoColor businessIds (workspace-global), so a preset saved on one
 * scorecard paints onto any scorecard in the same workspace.
 */
import { log } from './logger';
import type { NodeStyle } from './layout/types';

export interface StylePreset {
  id: string;
  name: string;
  style: NodeStyle;
  createdAt: number;
}

const STYLE_PRESETS_MAX = 60;
const SAVE_DELAY = 400;

export class StylePresetStore {
  private entries: StylePreset[] = [];
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private profileId: string;

  constructor(profileId = '_default') {
    this.profileId = profileId;
  }

  private get storageKey(): string { return `crev_${this.profileId}_style_presets`; }

  async load(): Promise<void> {
    try {
      const result = await chrome.storage.local.get(this.storageKey);
      const data = result[this.storageKey] as StylePreset[] | undefined;
      if (Array.isArray(data)) this.entries = data.slice(0, STYLE_PRESETS_MAX);
    } catch (e) {
      log.swallow('stylePresets:load', e);
    }
  }

  async switchProfile(newProfileId: string): Promise<void> {
    if (newProfileId === this.profileId) return;
    await this.persist();
    this.profileId = newProfileId;
    this.entries = [];
    await this.load();
  }

  getAll(): StylePreset[] { return this.entries; }

  /** Save a preset. A blank name is rejected (returns null). Saving over an existing (case-insensitive)
   *  name REPLACES it in place; otherwise the new preset is prepended (most-recent first). */
  save(name: string, style: NodeStyle): StylePreset | null {
    const trimmed = name.trim();
    if (!trimmed) return null;
    const idx = this.entries.findIndex(e => e.name.toLowerCase() === trimmed.toLowerCase());
    if (idx >= 0) {
      const preset: StylePreset = { ...this.entries[idx], name: trimmed, style };
      this.entries[idx] = preset;
      this.scheduleSave();
      return preset;
    }
    const preset: StylePreset = { id: crypto.randomUUID(), name: trimmed, style, createdAt: Date.now() };
    this.entries.unshift(preset);
    this.entries = this.entries.slice(0, STYLE_PRESETS_MAX);
    this.scheduleSave();
    return preset;
  }

  remove(id: string): void {
    const idx = this.entries.findIndex(e => e.id === id);
    if (idx >= 0) { this.entries.splice(idx, 1); this.scheduleSave(); }
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; void this.persist(); }, SAVE_DELAY);
  }

  private async persist(): Promise<void> {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    try {
      await chrome.storage.local.set({ [this.storageKey]: this.entries });
    } catch (e) {
      log.swallow('stylePresets:persist', e);
    }
  }
}
