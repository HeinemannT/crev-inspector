/**
 * Minimal-move reorder — the ONE pure helper both the layout diff (`diff.ts`) and the flow diff
 * (`flow.ts`) use so a single drag emits ONE move, not an N-step cascade.
 *
 * Given a container's CURRENT child order and the DESIRED order (same membership), it returns the
 * smallest set of moves that transforms one into the other: the items already in the correct RELATIVE
 * order — a longest strictly-increasing subsequence (LIS) of the desired order by current index — stay
 * put, and only the genuinely-displaced items move, one op each.
 *
 * Each move anchors to an ALREADY-PLACED neighbour, and the moves are emitted in desired order, so a
 * sequential apply is always valid (every anchor is in position by the time a later move references it):
 *   - a non-first desired item → `moveAfter(<its desired predecessor>)`;
 *   - the desired-FIRST item, when it moved → `moveBefore(<the current-first sibling>)` (drag-to-front is
 *     then a single moveBefore instead of a cascade).
 */

export interface ReorderMove {
  id: string;
  /** the already-placed neighbour this move anchors to. */
  anchorId: string;
  /** 'after' → moveAfter(anchor); 'before' → moveBefore(anchor) (drag-to-front). */
  dir: 'after' | 'before';
}

/** Indices (into `a`) of ONE longest strictly-increasing subsequence — patience sorting, O(n log n). */
function lisIndices(a: number[]): number[] {
  const n = a.length;
  if (!n) return [];
  const tails: number[] = [];              // tails[k] = index in `a` of the smallest tail of a length-(k+1) run
  const prev: number[] = new Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    let lo = 0, hi = tails.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (a[tails[mid]] < a[i]) lo = mid + 1; else hi = mid; }
    if (lo > 0) prev[i] = tails[lo - 1];
    tails[lo] = i;                          // extends the array when lo === length
  }
  const out: number[] = [];
  for (let k: number = tails[tails.length - 1]; k !== -1; k = prev[k]) out.push(k);
  return out.reverse();
}

/** The minimal moves to turn `current` order into `desired` (same membership). Empty when already equal
 *  or when membership differs (a caller should only reorder identical sets — a mismatch is a no-op here
 *  rather than a wrong guess). */
export function minimalReorder(current: string[], desired: string[]): ReorderMove[] {
  if (current.length !== desired.length) return [];
  const pos = new Map(current.map((id, i) => [id, i]));
  if (desired.some(id => !pos.has(id))) return [];        // different membership — not a pure reorder
  if (current.every((id, i) => id === desired[i])) return []; // already in order
  const seq = desired.map(id => pos.get(id)!);
  const keep = new Set(lisIndices(seq));                  // desired indices already in relative order
  const moves: ReorderMove[] = [];
  for (let i = 0; i < desired.length; i++) {
    if (keep.has(i)) continue;
    const id = desired[i];
    if (i > 0) {
      moves.push({ id, anchorId: desired[i - 1], dir: 'after' });
    } else {
      // desired-first item moved → put it before the current-first sibling that isn't itself.
      const anchor = current.find(c => c !== id);
      if (anchor) moves.push({ id, anchorId: anchor, dir: 'before' });
    }
  }
  return moves;
}
