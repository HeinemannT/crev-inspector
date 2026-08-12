import type { BmpObject } from './types';
import { mergeBmpObject } from './merge';
import { log } from './logger';
import { CACHE_MAX_SIZE, CACHE_SAVE_DELAY } from './constants';
import { getCtx } from './sw-context';

/**
 * In-memory object cache backed by chrome.storage.local.
 * RID → BmpObject, merges metadata from multiple sources.
 * Per-profile isolation with day-based invalidation.
 */
export class ObjectCache {
  private cache = new Map<string, BmpObject>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private cachedValues: BmpObject[] | null = null;
  private profileId: string;
  private persistWarnLogged = false;

  constructor(profileId = '_default') {
    this.profileId = profileId;
  }

  private get storageKey() { return `crev_${this.profileId}_cache`; }
  private get dateKey() { return `crev_${this.profileId}_cache_date`; }

  async load(): Promise<void> {
    try {
      // Migration: move old global cache to active profile key
      const oldResult = await chrome.storage.local.get('crev_object_cache');
      if (oldResult.crev_object_cache) {
        await chrome.storage.local.set({ [this.storageKey]: oldResult.crev_object_cache });
        await chrome.storage.local.remove('crev_object_cache');
      }

      const result = await chrome.storage.local.get([this.storageKey, this.dateKey]);
      const storedDate = result[this.dateKey] as string | undefined;
      const today = new Date().toDateString();

      // Day-based invalidation: clear if cache is from a different day
      if (storedDate && storedDate !== today) {
        await chrome.storage.local.remove([this.storageKey, this.dateKey]);
        return;
      }

      const data = result[this.storageKey] as Record<string, BmpObject> | undefined;
      if (data) {
        for (const [rid, obj] of Object.entries(data)) {
          this.cache.set(rid, obj);
        }
      }
    } catch (e) {
      log.swallow('cache:load', e);
    }
  }

  private switching = false;

  /** Switch to a different profile's cache — persist current, load new */
  async switchProfile(newProfileId: string): Promise<void> {
    if (newProfileId === this.profileId) return;
    this.switching = true;
    try {
      // Persist current profile's cache, then swap
      await this.persist();
      this.profileId = newProfileId;
      this.cache.clear();
      this.cachedValues = null;
      if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
      await this.load();
    } finally {
      this.switching = false;
    }
  }

  /** Merge an object into the cache, enriching existing entries */
  put(obj: BmpObject): void {
    if (this.switching) return; // profile switch in progress — discard stale writes
    this.mergeObject(obj);
    this.scheduleSave();
    this.evictIfNeeded();
  }

  /** Merge multiple objects (batched: single save + evict) */
  putAll(objects: BmpObject[]): void {
    if (this.switching) return;
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

  /** TTL for cached enrichment data. If an entry is older than this,
   *  treat it as cache miss and force the caller to re-fetch. Mainly
   *  protects against server-side renames (Config Studio) that we
   *  can't detect via the extension — eventually the cache catches up.
   *
   *  1 hour: long enough to not hammer BMP during a normal session,
   *  short enough that a rename done in Config Studio propagates
   *  before the user finishes their work in another tab. */
  private static readonly TTL_MS = 60 * 60 * 1000;

  get(rid: string): BmpObject | undefined {
    const obj = this.cache.get(rid);
    if (!obj) return undefined;
    if (Date.now() - obj.updatedAt > ObjectCache.TTL_MS) {
      // Stale — evict and report miss so the caller re-enriches.
      this.cache.delete(rid);
      this.cachedValues = null;
      return undefined;
    }
    // LRU: move to end of Map insertion order
    this.cache.delete(rid);
    this.cache.set(rid, obj);
    this.cachedValues = null;
    return obj;
  }

  /** Drop a single rid from the cache. Used after edits (SAVE_PROPERTY /
   *  APPLY_OBJECT_CHANGES succeed) so the next read re-fetches from
   *  BMP and we don't serve stale name/type/businessId. */
  invalidate(rid: string): void {
    if (this.cache.delete(rid)) {
      this.cachedValues = null;
    }
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
      obj.businessId?.toLowerCase().includes(lower) ||
      obj.templateBusinessId?.toLowerCase().includes(lower)
    );
  }

  get size(): number {
    return this.cache.size;
  }

  clear(): void {
    this.cache.clear();
    this.cachedValues = null;
    // Cancel any pending debounced save and remove the persisted copy
    // immediately. Going through scheduleSave (2s debounce) means a SW
    // idle-restart in the debounce window would resurrect the data we
    // just cleared — exactly the bug RESET_ALL was supposed to fix.
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    chrome.storage.local.remove([this.storageKey, this.dateKey])
      .catch(e => log.swallow('cache:clear:persist', e));
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
      void this.persist();
    }, CACHE_SAVE_DELAY);
  }

  /** Flush pending writes immediately (call before SW may suspend). */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
      await this.persist();
    }
  }

  /** Properties stripped before persisting. Code fields can be 30-80 KB on a
   *  single CVO/DashboardHTML; persisting them blew through the 10 MB quota
   *  on heavy workspaces. We keep them in the in-memory cache for the active
   *  session but re-fetch on cold start via fetchCodeViaEc — that's a single
   *  EC round-trip per object the user opens, against the cost of repeatedly
   *  hitting quota silently. */
  private static readonly NON_PERSISTED_PROPS = new Set(['expression', 'html', 'javascript', 'css']);

  private stripNonPersisted(obj: BmpObject): BmpObject {
    if (!obj.properties) return obj;
    let hasHeavy = false;
    for (const k of ObjectCache.NON_PERSISTED_PROPS) {
      if (k in obj.properties) { hasHeavy = true; break; }
    }
    if (!hasHeavy) return obj;
    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj.properties)) {
      if (!ObjectCache.NON_PERSISTED_PROPS.has(k)) props[k] = v;
    }
    return { ...obj, properties: props };
  }

  /** Approximate cache size in bytes — JSON-serialized length of the lean
   *  persisted form. Used by the Connect tab to surface "you're using X MB
   *  of the 10 MB quota". O(n) over the cache; called on demand only. */
  getApproxBytes(): number {
    let total = 0;
    for (const obj of this.cache.values()) {
      try { total += JSON.stringify(this.stripNonPersisted(obj)).length; } catch { /* skip */ }
    }
    return total;
  }

  private async persist() {
    // Lean payload — drop code-bearing fields (expression / html / javascript
    // / css) before writing. Cuts persisted size 5-10× on workspaces heavy
    // on CVO + DashboardHTML. Code re-fetches on demand via fetchCodeViaEc.
    const leanEntries: Record<string, BmpObject> = {};
    for (const [rid, obj] of this.cache) {
      leanEntries[rid] = this.stripNonPersisted(obj);
    }
    try {
      await chrome.storage.local.set({
        [this.storageKey]: leanEntries,
        [this.dateKey]: new Date().toDateString(),
      });
      this.persistWarnLogged = false;
    } catch (e) {
      if (!this.persistWarnLogged) {
        log.warn('cache:persist', e, '— evicting LRU entries to recover');
        this.persistWarnLogged = true;
        // Surface to the panel so the user knows the cache is at its limit.
        // Swallowed if no panel is listening; the next CACHE_STATS broadcast
        // also carries the count so the user sees the eviction effect.
        try {
          getCtx().sendToPanel({ type: 'CACHE_QUOTA_WARNING', size: this.cache.size });
        } catch { /* ignore */ }
      }
      // Evict 20% of entries (LRU — oldest in Map insertion order) and retry once
      const evictCount = Math.max(1, Math.floor(this.cache.size * 0.2));
      let count = 0;
      for (const rid of this.cache.keys()) {
        if (count >= evictCount) break;
        this.cache.delete(rid);
        count++;
      }
      this.cachedValues = null;
      try {
        const retryEntries: Record<string, BmpObject> = {};
        for (const [rid, obj] of this.cache) {
          retryEntries[rid] = this.stripNonPersisted(obj);
        }
        await chrome.storage.local.set({
          [this.storageKey]: retryEntries,
          [this.dateKey]: new Date().toDateString(),
        });
      } catch (e2) {
        log.swallow('cache:persist:retry', e2);
      }
    }
  }
}
