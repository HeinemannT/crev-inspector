import { describe, it, expect } from 'vitest';
import { minimalReorder, type ReorderMove } from '../reorder';

/** Apply a move sequence to a starting order (sequential, each anchor already placed) — the executable
 *  contract the compiler relies on. Mirrors BMP's moveAfter/moveBefore semantics. */
function applyMoves(start: string[], moves: ReorderMove[]): string[] {
  const arr = [...start];
  for (const mv of moves) {
    const from = arr.indexOf(mv.id);
    if (from < 0) throw new Error(`move subject ${mv.id} absent`);
    arr.splice(from, 1);
    const at = arr.indexOf(mv.anchorId);
    if (at < 0) throw new Error(`anchor ${mv.anchorId} not placed yet — invalid sequential move`);
    arr.splice(mv.dir === 'after' ? at + 1 : at, 0, mv.id);
  }
  return arr;
}

describe('minimalReorder', () => {
  it('is empty when already in order, or on a membership mismatch', () => {
    expect(minimalReorder(['a', 'b', 'c'], ['a', 'b', 'c'])).toEqual([]);
    expect(minimalReorder(['a', 'b'], ['a', 'b', 'c'])).toEqual([]); // length differs
    expect(minimalReorder(['a', 'b'], ['a', 'x'])).toEqual([]);       // different member
  });

  it('a single drag emits exactly ONE move (to a middle position → moveAfter)', () => {
    // [A,B,C,D] drag A after C → [B,C,A,D]
    const moves = minimalReorder(['A', 'B', 'C', 'D'], ['B', 'C', 'A', 'D']);
    expect(moves).toHaveLength(1);
    expect(moves[0]).toEqual({ id: 'A', anchorId: 'C', dir: 'after' });
    expect(applyMoves(['A', 'B', 'C', 'D'], moves)).toEqual(['B', 'C', 'A', 'D']);
  });

  it('a drag-to-front emits exactly ONE moveBefore (not a cascade)', () => {
    // [A,B,C,D,E] drag E to front → [E,A,B,C,D]
    const moves = minimalReorder(['A', 'B', 'C', 'D', 'E'], ['E', 'A', 'B', 'C', 'D']);
    expect(moves).toHaveLength(1);
    expect(moves[0]).toEqual({ id: 'E', anchorId: 'A', dir: 'before' });
    expect(applyMoves(['A', 'B', 'C', 'D', 'E'], moves)).toEqual(['E', 'A', 'B', 'C', 'D']);
  });

  it('inserting an appended item mid-list is ONE move (the follower stays put)', () => {
    // create appends X → [A,B,C,X]; desired puts X after A → [A,X,B,C]
    const moves = minimalReorder(['A', 'B', 'C', 'X'], ['A', 'X', 'B', 'C']);
    expect(moves).toEqual([{ id: 'X', anchorId: 'A', dir: 'after' }]);
    expect(applyMoves(['A', 'B', 'C', 'X'], moves)).toEqual(['A', 'X', 'B', 'C']);
  });

  it('a genuine multi-item shuffle moves ONLY the displaced items (LIS-minimal), sequentially valid', () => {
    const start = ['A', 'B', 'C', 'D', 'E'];
    const desired = ['A', 'D', 'B', 'E', 'C']; // LIS A,B,C kept → D,E move
    const moves = minimalReorder(start, desired);
    expect(moves).toHaveLength(2); // n - LIS length = 5 - 3
    expect(applyMoves(start, moves)).toEqual(desired);
  });

  it('a full reverse is n-1 moves and still lands the exact order', () => {
    const start = ['A', 'B', 'C', 'D'];
    const desired = ['D', 'C', 'B', 'A'];
    const moves = minimalReorder(start, desired);
    expect(moves).toHaveLength(3); // LIS of a reverse is length 1
    expect(applyMoves(start, moves)).toEqual(desired);
  });

  it('property: for many random permutations, moves reproduce the order and never exceed n-1', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    let seed = 12345;
    const rnd = (): number => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    for (let t = 0; t < 200; t++) {
      const desired = [...ids];
      for (let i = desired.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [desired[i], desired[j]] = [desired[j], desired[i]]; }
      const moves = minimalReorder(ids, desired);
      expect(applyMoves(ids, moves)).toEqual(desired);
      expect(moves.length).toBeLessThanOrEqual(ids.length - 1);
    }
  });
});
