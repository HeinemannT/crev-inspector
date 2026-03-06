import type { BmpObject } from './types';
import { mergeBmpObject } from './merge';
import { log } from './logger';
import { CACHE_MAX_SIZE, CACHE_SAVE_DELAY } from './constants';

const STORAGE_KEY = 'crev_object_cache';

/**
 * In-memory object cache backed by chrome.storage.local.
 * RID → BmpObject, merges metadata from multiple sources.
 */
export class ObjectCache {
  private cache = new Map<string, BmpObject>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private cachedValues: BmpObject[] | null = null;

  async load(): Promise<void> {
    try {
      const result = await chrome.storage.local.get(STORAGE_KEY);
      const data = result[STORAGE_KEY] as Record<string, BmpObject> | undefined;
      if (data) {
        for (const [rid, obj] of Object.entries(data)) {
          this.cache.set(rid, obj);
        }
      }
    } catch (e) {
      log.swallow('cache:load', e);
    }
  }

  /** Merge an object into the cache, enriching existing entries */
  put(obj: BmpObject): void {
    this.mergeObject(obj);
    this.scheduleSave();
    this.evictIfNeeded();
  }

  /** Merge multiple objects (batched: single save + evict) */
  putAll(objects: BmpObject[]): void {
    for (const obj of objects) this.mergeObject(obj);
    if (objects.length > 0) {
      this.scheduleSave();
      this.evictIfNeeded();
    }
  }

  private mergeObject(obj: BmpObject): void {
    const existing = this.cache.get(obj.rid);
    this.cache.set(obj.rid, existing ? mergeBmpObject(existing, obj) : obj);
  }

  get(rid: string): BmpObject | undefined {
    const obj = this.cache.get(rid);
    if (obj) {
      // LRU: move to end of Map insertion order
      this.cache.delete(rid);
      this.cache.set(rid, obj);
      this.cachedValues = null;
    }
    return obj;
  }

  getAll(): BmpObject[] {
    if (!this.cachedValues) this.cachedValues = Array.from(this.cache.values());
    return this.cachedValues;
  }

  search(filter: string): BmpObject[] {
    const lower = filter.toLowerCase();
    return this.getAll().filter(obj =>
      obj.rid.includes(lower) ||
      obj.name?.toLowerCase().includes(lower) ||
      obj.type?.toLowerCase().includes(lower) ||
      obj.businessId?.toLowerCase().includes(lower)
    );
  }

  get size(): number {
    return this.cache.size;
  }

  clear(): void {
    this.cache.clear();
    this.scheduleSave();
  }

  private evictIfNeeded() {
    if (this.cache.size <= CACHE_MAX_SIZE) return;

    // LRU eviction: Map insertion order tracks access recency (get() re-inserts)
    const excess = this.cache.size - CACHE_MAX_SIZE;
    let count = 0;
    for (const rid of this.cache.keys()) {
      if (count >= excess) break;
      this.cache.delete(rid);
      count++;
    }
  }

  private scheduleSave() {
    this.cachedValues = null;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.persist();
    }, CACHE_SAVE_DELAY);
  }

  private async persist() {
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: Object.fromEntries(this.cache) });
    } catch (e) {
      log.swallow('cache:persist', e);
    }
  }
}
