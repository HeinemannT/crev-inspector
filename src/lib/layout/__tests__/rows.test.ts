/**
 * Row engine — the pure computeRows/trackSpan module every renderer + drop resolver consumes.
 * The expectations mirror the LIVE probe measurements (2026-07-02, Steadfast, 1440px):
 * fits-in-remainder wrap, continuous flow across the container→widget band boundary, and the
 * class-dependent 0-width rule (widget 0 → full width, container 0 → ~1 auto track).
 */
import { describe, it, expect } from 'vitest';
import { computeRows, trackSpan, TRACKS } from '../rows';
import type { LNode } from '../types';

const widget = (id: string, L: number): LNode =>
  ({ id, kind: 'widget', className: 'TextElement', name: id, cols: { L }, children: [] });
const container = (id: string, L: number, children: LNode[] = []): LNode =>
  ({ id, kind: 'container', className: 'Container', name: id, cols: { L }, children });

const ids = (rows: ReturnType<typeof computeRows>) => rows.map(r => r.items.map(i => i.id));

describe('trackSpan', () => {
  it('maps L columns to 2× CSS tracks, clamped to 1..6', () => {
    expect(trackSpan(widget('w', 3))).toBe(6);
    expect(trackSpan(widget('w', 6))).toBe(12);
    expect(trackSpan(widget('w', 9))).toBe(12);
  });
  it('0 is class-dependent: widget → full width, container → one auto track', () => {
    expect(trackSpan(widget('w', 0))).toBe(TRACKS);
    expect(trackSpan(container('c', 0))).toBe(1);
  });
});

describe('computeRows', () => {
  it('wraps by fits-in-remainder: 3+2 share a row, the next 3 wraps (the probe layout)', () => {
    const rows = computeRows([container('ca', 3), container('cb', 2), container('cc', 3)]);
    expect(ids(rows)).toEqual([['ca', 'cb'], ['cc']]);
    expect(rows[0].free).toBe(2); // 12 − (6+4)
  });

  it('flows CONTINUOUSLY across the container→widget boundary (probe: WT1 joined the container row)', () => {
    // containers use 4+~1+2 = 7 tracks → 5 free; the first widget (span 4) fits and joins the row.
    const rows = computeRows([container('cb', 2), container('cz', 0), container('cn', 1), widget('wt1', 2), widget('wt2', 2)]);
    expect(ids(rows)).toEqual([['cb', 'cz', 'cn', 'wt1'], ['wt2']]);
  });

  it('orders bands itself: a widget listed first still flows after all containers', () => {
    const rows = computeRows([widget('w1', 6), container('c1', 6)]);
    expect(ids(rows)).toEqual([['c1'], ['w1']]);
  });

  it('a widget with cols 0 takes a full row (12 tracks)', () => {
    const rows = computeRows([widget('a', 2), widget('z', 0), widget('b', 2)]);
    expect(ids(rows)).toEqual([['a'], ['z'], ['b']]);
    expect(rows[0].free).toBe(8);
  });

  it('an exactly-full row closes and the next item starts fresh', () => {
    const rows = computeRows([widget('a', 3), widget('b', 3), widget('c', 1)]);
    expect(ids(rows)).toEqual([['a', 'b'], ['c']]);
    expect(rows[0].free).toBe(0);
  });

  it('empty children → no rows', () => {
    expect(computeRows([])).toEqual([]);
  });
});
