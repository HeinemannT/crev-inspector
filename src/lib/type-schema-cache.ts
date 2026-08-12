/**
 * Persistent type-schema cache for the extended-code Vars panel.
 *
 * The Vars panel needs per-type property lists to power the property
 * picker + the `*` autocomplete expansion. Each list costs ~90 ms to
 * fetch from BMP, so we cache.
 *
 * Two tiers:
 *   - in-memory Map (session, fast)
 *   - chrome.storage.local (across sessions, survives extension reload)
 *
 * Keyed by `${serverId}:${className}` so users on multiple BMP profiles
 * never see each other's schemas. Optional `bmpBuildId` segment lets
 * a server upgrade auto-invalidate.
 *
 * Lazy by design — nothing is ever pre-fetched. First lookup of a
 * (serverId, className) pair pays the round-trip; second is instant.
 *
 * Freshness is bounded by a seven-day TTL. RESET_ALL clears both schema and
 * root-category knowledge through the single `clear()` recovery operation.
 */
import type { TypeSchemaProp } from './types';

// v2 adds the master property RID/ID needed by direct property navigation.
const STORAGE_KEY = 'crev_schema_cache_v2';
const TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

interface CacheEntry {
  serverId: string;
  className: string;
  bmpBuildId?: string;
  fetchedAt: number;
  props: TypeSchemaProp[];
  /** BMP's canonical PascalCase for this type (last segment of the FQ Java
   *  id). Lets a warm-cache hit still tell the client the canonical casing. */
  canonicalClassName?: string;
}

const mem = new Map<string, CacheEntry>();
let loadPromise: Promise<void> | null = null;

function key(serverId: string, className: string): string {
  return `${serverId}::${className.toLowerCase()}`;
}

/** Load the persisted cache into memory. Idempotent + concurrency-safe:
 *  parallel callers all wait on the same in-flight promise so we never
 *  read storage twice, and never let a caller see an empty mem during
 *  the initial async window. */
export function load(): Promise<void> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const raw = await chrome.storage.local.get(STORAGE_KEY);
      const entries = raw[STORAGE_KEY] as Record<string, CacheEntry> | undefined;
      if (!entries) return;
      const now = Date.now();
      for (const e of Object.values(entries)) {
        // Drop expired entries on load — keeps storage from growing
        // unbounded when types fall out of use.
        if (now - e.fetchedAt > TTL_MS) continue;
        // Normalize legacy case-sensitive v2 keys while loading. BMP resolves
        // class names case-insensitively; one canonical description must back
        // every spelling a caller uses.
        mem.set(key(e.serverId, e.className), e);
      }
    } catch {
      // chrome.storage failure → start with an empty cache, no toast.
      // The fetch path still works; we just pay one round-trip per type.
    }
  })();
  return loadPromise;
}

/** Persist the in-memory cache to chrome.storage.local. Coalesced via
 *  a microtask so a burst of writes during a parallel fetch becomes
 *  one storage update. */
let flushScheduled = false;
function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(() => {
    void (async () => {
      flushScheduled = false;
      try {
        const snapshot: Record<string, CacheEntry> = {};
        for (const [k, e] of mem) snapshot[k] = e;
        await chrome.storage.local.set({ [STORAGE_KEY]: snapshot });
      } catch {
        // Storage quota or transient failure — drop silently; the
        // in-memory cache is still authoritative for this session.
      }
    })();
  });
}

export function get(serverId: string, className: string): TypeSchemaProp[] | null {
  const e = mem.get(key(serverId, className));
  if (!e) return null;
  if (Date.now() - e.fetchedAt > TTL_MS) {
    // Expired — treat as miss so caller refetches. Don't drop yet;
    // load() will sweep on next boot.
    return null;
  }
  return e.props;
}

export function set(serverId: string, className: string, props: TypeSchemaProp[], canonicalClassName?: string): void {
  mem.set(key(serverId, className), {
    serverId, className, props, canonicalClassName, fetchedAt: Date.now(),
  });
  scheduleFlush();
}

/** Canonical PascalCase for a cached type, if known. Returns undefined on
 *  miss / expiry so the caller falls back to a fresh fetch. */
export function getCanonical(serverId: string, className: string): string | undefined {
  const e = mem.get(key(serverId, className));
  if (!e || Date.now() - e.fetchedAt > TTL_MS) return undefined;
  return e.canonicalClassName;
}

// ── Root-category → className mappings ──────────────────────────
//
// Same lazy cache shape for `root.<lcCategory>` patterns. Resolved via
// a single EC call per category, basically free after the first hit.

const ROOT_KEY = 'crev_root_category_cache_v1';
interface RootEntry { serverId: string; category: string; className: string | null; resolvedAt: number }
const rootMem = new Map<string, RootEntry>();
let rootLoadPromise: Promise<void> | null = null;

export function loadRootCache(): Promise<void> {
  if (rootLoadPromise) return rootLoadPromise;
  rootLoadPromise = (async () => {
    try {
      const raw = await chrome.storage.local.get(ROOT_KEY);
      const entries = raw[ROOT_KEY] as Record<string, RootEntry> | undefined;
      if (!entries) return;
      const now = Date.now();
      for (const e of Object.values(entries)) {
        if (typeof e.resolvedAt !== 'number' || now - e.resolvedAt > TTL_MS) continue;
        rootMem.set(rootKey(e.serverId, e.category), e);
      }
    } catch { /* see load() */ }
  })();
  return rootLoadPromise;
}

let rootFlushScheduled = false;
function scheduleRootFlush(): void {
  if (rootFlushScheduled) return;
  rootFlushScheduled = true;
  queueMicrotask(() => {
    void (async () => {
      rootFlushScheduled = false;
      try {
        const snap: Record<string, RootEntry> = {};
        for (const [k, e] of rootMem) snap[k] = e;
        await chrome.storage.local.set({ [ROOT_KEY]: snap });
      } catch { /* drop */ }
    })();
  });
}

function rootKey(serverId: string, category: string): string {
  return `${serverId}::${category}`;
}

export function getRoot(serverId: string, category: string): string | null | undefined {
  const cacheKey = rootKey(serverId, category);
  const e = rootMem.get(cacheKey);
  if (e && (typeof e.resolvedAt !== 'number' || Date.now() - e.resolvedAt > TTL_MS)) {
    rootMem.delete(cacheKey);
    scheduleRootFlush();
    return undefined;
  }
  // null means "we asked and BMP said empty" — DON'T re-ask every keystroke
  // for known-bad categories. undefined means "we've never asked".
  return e ? e.className : undefined;
}

export function setRoot(serverId: string, category: string, className: string | null): void {
  rootMem.set(rootKey(serverId, category), { serverId, category, className, resolvedAt: Date.now() });
  scheduleRootFlush();
}

/** Clear every persisted and in-memory type-knowledge facet. Await any initial
 * storage reads first so a late load cannot repopulate memory after reset. */
export async function clear(): Promise<void> {
  const loads: Promise<void>[] = [];
  if (loadPromise) loads.push(loadPromise);
  if (rootLoadPromise) loads.push(rootLoadPromise);
  await Promise.allSettled(loads);
  mem.clear();
  rootMem.clear();
  try { await chrome.storage.local.remove([STORAGE_KEY, ROOT_KEY]); }
  catch { /* Reset remains useful even when persistence is temporarily unavailable. */ }
}
