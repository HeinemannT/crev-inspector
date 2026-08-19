/**
 * Versioned, environment-isolated last-known-good cache for workspace colors.
 *
 * Colors are configuration metadata and change infrequently. Persisting them
 * in storage.local avoids repeating a multi-second EC query after every browser
 * restart. Expired data is retained only as an explicit stale fallback when a
 * refresh fails; errors and partial query results never replace a good entry.
 */
import type { ColorSetData } from './types';
import { log } from './logger';

const STORAGE_KEY = 'crev_color_sets_v2';
const CACHE_VERSION = 2;
export const COLOR_SET_TTL_MS = 24 * 60 * 60_000;

interface CacheEntry {
  version: typeof CACHE_VERSION;
  fetchedAt: number;
  sets: ColorSetData[];
}

type Store = Record<string, CacheEntry>;

export interface ColorSetCacheHit {
  sets: ColorSetData[];
  fetchedAt: number;
  stale: boolean;
}

export interface ColorSetLoadResult extends ColorSetCacheHit {
  source: 'cache' | 'network' | 'stale-fallback';
  error?: string;
}

const mem = new Map<string, CacheEntry>();
const pending = new Map<string, Promise<ColorSetLoadResult>>();
let loadPromise: Promise<void> | null = null;
let generation = 0;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function load(): Promise<void> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const raw = await chrome.storage.local.get(STORAGE_KEY);
      const store = raw[STORAGE_KEY] as Store | undefined;
      if (!store) return;
      for (const [environment, entry] of Object.entries(store)) {
        if (entry?.version !== CACHE_VERSION || !Array.isArray(entry.sets) || !Number.isFinite(entry.fetchedAt)) continue;
        mem.set(environment, entry);
      }
    } catch (error) {
      log.swallow('colorCache:load', error);
    }
  })();
  return loadPromise;
}

async function persist(): Promise<void> {
  const store: Store = {};
  for (const [environment, entry] of mem) store[environment] = entry;
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: store });
  } catch (error) {
    log.swallow('colorCache:persist', error);
  }
}

export async function getColorSets(environment: string, now = Date.now()): Promise<ColorSetCacheHit | null> {
  await load();
  const entry = mem.get(environment);
  if (!entry) return null;
  return {
    sets: entry.sets,
    fetchedAt: entry.fetchedAt,
    stale: now - entry.fetchedAt > COLOR_SET_TTL_MS,
  };
}

export async function setColorSets(
  environment: string,
  sets: ColorSetData[],
  fetchedAt = Date.now(),
): Promise<void> {
  await load();
  mem.set(environment, { version: CACHE_VERSION, fetchedAt, sets });
  await persist();
}

/**
 * Load fresh colors or refresh an expired/forced entry. Concurrent callers for
 * one environment share the same query. When a refresh fails, a previous good
 * entry is returned as explicitly stale; a first-load failure still rejects.
 */
export async function loadColorSets(
  environment: string,
  fetcher: () => Promise<ColorSetData[]>,
  force = false,
  now = Date.now(),
): Promise<ColorSetLoadResult> {
  const cached = await getColorSets(environment, now);
  if (!force && cached && !cached.stale) return { ...cached, source: 'cache' };

  const existing = pending.get(environment);
  if (existing) return existing;
  const requestGeneration = generation;
  const request = (async (): Promise<ColorSetLoadResult> => {
    try {
      const sets = await fetcher();
      if (generation !== requestGeneration) throw new Error('Color request invalidated during environment change');
      const fetchedAt = Date.now();
      await setColorSets(environment, sets, fetchedAt);
      return { sets, fetchedAt, stale: false, source: 'network' };
    } catch (error) {
      if (cached) {
        return {
          ...cached,
          stale: true,
          source: 'stale-fallback',
          error: errorMessage(error),
        };
      }
      throw error;
    }
  })();
  pending.set(environment, request);
  try {
    return await request;
  } finally {
    if (pending.get(environment) === request) pending.delete(environment);
  }
}

/** Drop one environment or all environments and invalidate late responses. */
export function invalidateColorSets(environment?: string): void {
  generation += 1;
  if (environment) mem.delete(environment); else mem.clear();
  // A cold MV3 worker may still be hydrating storage.local. Remove the entry
  // both before and after that load so an old persisted value cannot be
  // reintroduced between the synchronous invalidation and the write-back.
  void (async () => {
    await load();
    if (environment) mem.delete(environment); else mem.clear();
    await persist();
  })();
}
