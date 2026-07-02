/**
 * Row engine — the ONE place that knows how BMP flows a parent's children into rows.
 *
 * Ground truth (live-verified on 5.6.10.0, 2026-07-02, probe page + pixel inspection):
 *  - The rendered CSS grid is 12 tracks; a node spans `columnsLargeScreen × 2`.
 *  - `columnsLargeScreen = 0` is class-dependent: a WIDGET renders full width (span 12); a
 *    CONTAINER gets NO span at all (`grid-column: auto` ≈ one content-stretched track).
 *  - Children flow left-to-right in canonical order (containers first, then tab-bound widgets —
 *    `orderChildren`) and wrap by FITS-IN-REMAINDER: a node wider than the row's free tracks
 *    starts a new row, leaving the trailing gap unfilled (never backfilled).
 *  - The container→widget band boundary does NOT break the row: the first widget joins the last
 *    container row when it fits.
 *
 * Both the result-canvas renderer and the drop/add placement logic consume this module, so the
 * wireframe and the drop targets can never disagree about where a row ends.
 */
import { orderChildren } from './model';
import type { LNode } from './types';

export const TRACKS = 12;

/** CSS-track span of a node in BMP's 12-track grid (see module header for the 0-width rule). */
export function trackSpan(n: LNode): number {
  if (n.cols.L === 0) return n.kind === 'container' ? 1 : TRACKS;
  return Math.max(1, Math.min(6, n.cols.L)) * 2;
}

export interface Row {
  items: LNode[];
  /** Tracks occupied (≤ 12). */
  used: number;
  /** Trailing free tracks (12 − used). */
  free: number;
}

/** Flow `children` into rows exactly as BMP renders them. Applies canonical band order itself, so
 *  callers may pass a raw children array. */
export function computeRows(children: LNode[]): Row[] {
  const rows: Row[] = [];
  let cur: Row | null = null;
  for (const c of orderChildren(children)) {
    const sp = trackSpan(c);
    if (!cur || cur.used + sp > TRACKS) { cur = { items: [], used: 0, free: TRACKS }; rows.push(cur); }
    cur.items.push(c);
    cur.used += sp;
    cur.free = TRACKS - cur.used;
    if (cur.used >= TRACKS) cur = null;
  }
  return rows;
}
