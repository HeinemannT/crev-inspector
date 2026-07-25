/**
 * Per-profile cache of the workspace colour sets (CorpoColor links).
 *
 * `fetchColorSets()` costs a full BMP round-trip (EC query + deserialise);
 * colour sets change rarely, so we cache the parsed result. Two tiers:
 *   - in-memory Map (instant within a live service worker)
 *   - chrome.storage.session (survives side-panel reloads AND MV3 service-worker
 *     idle-resets within a browser session)
 *
 * Keyed by serverId (activeProfileId) so two BMP profiles never share colours.
 * A full browser restart clears session storage → exactly one fresh fetch per
 * browser session. A manual refresh (FETCH_COLOR_SETS `force`) busts it when a
 * colour was added/changed mid-session.
 *
 * Mirrors the two-tier approach in type-schema-cache.ts (that one uses
 * storage.local + a 7-day TTL because type schemas are larger and even more
 * static; colours we keep session-scoped so new colours surface on the next
 * browser launch without a TTL to reason about).
 */
import type { ColorSetData } from './types';
import { log } from './logger';

const STORAGE_KEY = 'crev_color_sets_v1';

type Store = Record<string, ColorSetData[]>;

const mem = new Map<string, ColorSetData[]>();
const pending = new Map<string, Promise<ColorSetData[]>>();
let loadPromise: Promise<void> | null = null;

/** Hydrate the in-memory map from session storage. Idempotent + concurrency
 *  safe — parallel callers share one in-flight read. */
function load(): Promise<void> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const raw = await chrome.storage.session.get(STORAGE_KEY);
      const store = raw[STORAGE_KEY] as Store | undefined;
      if (store) for (const [k, v] of Object.entries(store)) mem.set(k, v);
    } catch (e) {
      log.swallow('colorCache:load', e);
    }
  })();
  return loadPromise;
}

async function persist(): Promise<void> {
  const store: Store = {};
  for (const [k, v] of mem) store[k] = v;
  try {
    await chrome.storage.session.set({ [STORAGE_KEY]: store });
  } catch (e) {
    log.swallow('colorCache:persist', e);
  }
}

/** Cached colour sets for a profile, or null on a miss. */
export async function getColorSets(serverId: string): Promise<ColorSetData[] | null> {
  await load();
  return mem.get(serverId) ?? null;
}

export async function setColorSets(serverId: string, sets: ColorSetData[]): Promise<void> {
  await load();
  mem.set(serverId, sets);
  await persist();
}

/** Cache-through loader shared by every colour consumer. Concurrent panel and
 * Blueprint requests for one profile join the same BMP round-trip. `force`
 * bypasses stored data but still joins an already-running refresh. Empty
 * arrays are valid cache entries; rejected fetches are never cached. */
export async function loadColorSets(
  serverId: string,
  fetcher: () => Promise<ColorSetData[]>,
  force = false,
): Promise<ColorSetData[]> {
  if (!force) {
    const cached = await getColorSets(serverId);
    if (cached !== null) return cached;
  }
  const existing = pending.get(serverId);
  if (existing) return existing;
  const request = (async () => {
    const sets = await fetcher();
    await setColorSets(serverId, sets);
    return sets;
  })();
  pending.set(serverId, request);
  try {
    return await request;
  } finally {
    if (pending.get(serverId) === request) pending.delete(serverId);
  }
}

/** Drop one profile's colours (or all). Used by the manual refresh. */
export function invalidateColorSets(serverId?: string): void {
  if (serverId) mem.delete(serverId); else mem.clear();
  persist().catch(() => { /* best-effort */ });
}
