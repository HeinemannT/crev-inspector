/**
 * Browse blend — merge the instant SW object cache with live GraphQL
 * quickSearch hits into one ranked, filtered, deduped result list.
 *
 * Pure functions only (no DOM, no messaging) so the merge/dedup/filter/sort
 * logic is unit-tested directly — see browse-blend.test.ts.
 */
import type { BmpObject } from './types';

export type BrowseSource = 'all' | 'touched' | 'workspace';
export type BrowseSort = 'relevance' | 'name' | 'type';

export interface BrowseFilters {
  /** Selected Ce* enterprise types (empty = no Ce constraint). */
  ceTypes: Set<string>;
  /** Selected non-Ce web/model types (empty = no web constraint). */
  webTypes: Set<string>;
  /** all = both sources, touched = cache only, workspace = live only. */
  source: BrowseSource;
  sort: BrowseSort;
}

/** A blended result carries provenance: was it in the cache (touched), live
 *  (from the workspace search), or both. */
export interface BrowseResult extends BmpObject {
  inCache: boolean;
  inLive: boolean;
}

/**
 * Merge live + cache by rid. Live order is preserved (quickSearch relevance);
 * cache-only matches are appended. When an object is in both, we keep the live
 * entry's position but mark it touched and backfill identity fields the live
 * hit lacks (quickSearch omits businessId/template that the cache has).
 */
export function blendResults(cache: BmpObject[], live: BmpObject[], filters: BrowseFilters): BrowseResult[] {
  const byRid = new Map<string, BrowseResult>();

  for (const o of live) {
    if (!o.rid) continue;
    byRid.set(o.rid, { ...o, inCache: false, inLive: true });
  }
  for (const o of cache) {
    if (!o.rid) continue;
    const existing = byRid.get(o.rid);
    if (existing) {
      existing.inCache = true;
      // Backfill identity the live hit didn't carry.
      if (!existing.businessId && o.businessId) existing.businessId = o.businessId;
      if (!existing.templateBusinessId && o.templateBusinessId) existing.templateBusinessId = o.templateBusinessId;
      if (!existing.name && o.name) existing.name = o.name;
    } else {
      byRid.set(o.rid, { ...o, inCache: true, inLive: false });
    }
  }

  let list = [...byRid.values()];

  // Type filter — the two dropdowns union into one allow-set; empty = no filter.
  const selectedTypes = new Set<string>([...filters.ceTypes, ...filters.webTypes]);
  if (selectedTypes.size > 0) {
    list = list.filter(r => r.type != null && selectedTypes.has(r.type));
  }

  // Source filter.
  if (filters.source === 'touched') list = list.filter(r => r.inCache);
  else if (filters.source === 'workspace') list = list.filter(r => r.inLive);

  // Sort. Relevance = the live-first insertion order above (stable).
  if (filters.sort === 'name') {
    list = [...list].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));
  } else if (filters.sort === 'type') {
    list = [...list].sort((a, b) =>
      (a.type ?? '').localeCompare(b.type ?? '') || (a.name ?? '').localeCompare(b.name ?? ''));
  }

  return list;
}

/** Provenance dot kind: a touched (cached) object reads as "you have this",
 *  a live-only one as "from the workspace". */
export function provenance(r: BrowseResult): 'touched' | 'live' {
  return r.inCache ? 'touched' : 'live';
}

/** Filter a type list by a typed substring (case-insensitive) for the dropdown. */
export function filterTypeOptions(types: readonly string[], typed: string): string[] {
  const q = typed.trim().toLowerCase();
  if (!q) return [...types];
  return types.filter(t => t.toLowerCase().includes(q));
}
