/**
 * Update check against the GitHub releases of this repo.
 *
 * The Connect tab calls `getUpdateStatus()` on render. The function returns
 * cached state immediately and triggers a background refetch when the cache
 * is older than CHECK_INTERVAL — the panel re-renders via FAVORITES_DATA-
 * style callback when fresh data lands.
 *
 * Latest release info lives at:
 *   https://api.github.com/repos/HeinemannT/configuration-companion/releases/latest
 *
 * The user can also click the status to open the releases page directly.
 */

const REPO = 'HeinemannT/configuration-companion';
const RELEASES_URL = `https://github.com/${REPO}/releases`;
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const CACHE_KEY = 'crev_update_check';
const CHECK_INTERVAL = 24 * 60 * 60 * 1000; // 24h — GitHub API is unauthenticated → 60 req/hr/IP

export interface UpdateStatus {
  current: string;
  latest: string | null;
  releasesUrl: string;
  isUpdate: boolean;
  checkedAt: number;
  error?: string;
}

interface CachedCheck {
  latest: string | null;
  checkedAt: number;
  error?: string;
}

let inFlight: Promise<UpdateStatus> | null = null;

/** Compare semver-ish version strings (e.g. "0.17.5"). Returns true if `a >
 *  b`. Ignores pre-release suffixes — we don't ship them. Exported for tests. */
export function isNewer(a: string, b: string): boolean {
  const pa = a.split('.').map(n => parseInt(n, 10) || 0);
  const pb = b.split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const ai = pa[i] ?? 0;
    const bi = pb[i] ?? 0;
    if (ai !== bi) return ai > bi;
  }
  return false;
}


function currentVersion(): string {
  return chrome.runtime.getManifest().version;
}

/** Returns cached status synchronously (or a default skeleton). Side-effect:
 *  kicks off a refetch if the cache is stale. */
export async function getUpdateStatus(): Promise<UpdateStatus> {
  const current = currentVersion();
  const cached = await readCache();
  const stale = !cached || Date.now() - cached.checkedAt > CHECK_INTERVAL;

  if (stale) {
    // Fire-and-forget — caller can re-check later. The catch is here (not at
    // the call site) because most callers don't have an error surface to
    // route to; the surfaced object's `error` field carries it instead.
    void refresh().catch(() => {});
  }

  return {
    current,
    latest: cached?.latest ?? null,
    releasesUrl: RELEASES_URL,
    isUpdate: !!(cached?.latest && isNewer(cached.latest, current)),
    checkedAt: cached?.checkedAt ?? 0,
    error: cached?.error,
  };
}

/** Force a check now, bypassing the 24h cache. Resolves to the same shape
 *  `getUpdateStatus` returns. */
export async function refresh(): Promise<UpdateStatus> {
  if (inFlight) return inFlight;
  const current = currentVersion();
  inFlight = (async () => {
    try {
      const r = await fetch(LATEST_API, { headers: { 'Accept': 'application/vnd.github+json' } });
      if (!r.ok) throw new Error(`GitHub API ${r.status}`);
      const data = await r.json() as { tag_name?: string; name?: string };
      // GitHub release tags are "v0.17.5" — strip the leading "v" so we can
      // compare against manifest.version which is bare "0.17.5".
      const latest = (data.tag_name ?? '').replace(/^v/, '') || null;
      const cached: CachedCheck = { latest, checkedAt: Date.now() };
      await writeCache(cached);
      return {
        current,
        latest,
        releasesUrl: RELEASES_URL,
        isUpdate: !!(latest && isNewer(latest, current)),
        checkedAt: cached.checkedAt,
      };
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      // Preserve the last successful release result. With no prior result, cache
      // the failure on the normal interval so a rendered panel cannot hammer the
      // GitHub API while offline or before a release exists.
      const prev = await readCache();
      const cached: CachedCheck = { latest: prev?.latest ?? null, checkedAt: prev?.checkedAt ?? Date.now(), error };
      await writeCache(cached);
      return {
        current,
        latest: cached.latest,
        releasesUrl: RELEASES_URL,
        isUpdate: !!(cached.latest && isNewer(cached.latest, current)),
        checkedAt: cached.checkedAt,
        error,
      };
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

async function readCache(): Promise<CachedCheck | null> {
  try {
    const r = await chrome.storage.local.get(CACHE_KEY);
    return (r[CACHE_KEY] as CachedCheck | undefined) ?? null;
  } catch {
    return null;
  }
}

async function writeCache(v: CachedCheck): Promise<void> {
  try { await chrome.storage.local.set({ [CACHE_KEY]: v }); } catch { /* storage unavailable */ }
}
