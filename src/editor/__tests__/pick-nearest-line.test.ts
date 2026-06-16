/**
 * Tests for pickNearestLine — the Code-Search jump locator. It lands a jump on
 * the real matched line by TEXT (nearest to the reported line number), so a
 * few-line drift between the search-side and editor-side body, or duplicate
 * lines, don't send the user to the wrong place.
 */
import { describe, it, expect } from 'vitest';
import { pickNearestLine } from '../editor-types';

const lines = [
  '{',            // 1
  '  "id": 1,',   // 2
  '  "name": "a",', // 3
  '  "id": 2,',   // 4
  '}',            // 5
];
const lt = (i: number) => lines[i - 1] ?? '';

describe('pickNearestLine', () => {
  it('finds the only occurrence', () => {
    expect(pickNearestLine(lt, lines.length, '"name"')).toBe(3);
  });

  it('resolves duplicate lines to the occurrence nearest the hint', () => {
    expect(pickNearestLine(lt, lines.length, '"id"', 2)).toBe(2);
    expect(pickNearestLine(lt, lines.length, '"id"', 4)).toBe(4);
    expect(pickNearestLine(lt, lines.length, '"id"', 5)).toBe(4); // 4 is closer than 2
  });

  it('still finds a match when the hint line is past the end (the drift case)', () => {
    // search reported line 160, but the editor body only has 5 lines
    expect(pickNearestLine(lt, lines.length, '}', 160)).toBe(5);
  });

  it('returns 0 when nothing matches (caller falls back to the line number)', () => {
    expect(pickNearestLine(lt, lines.length, 'NOPE')).toBe(0);
    expect(pickNearestLine(lt, lines.length, '')).toBe(0);
  });

  it('without a hint, prefers the earliest match', () => {
    expect(pickNearestLine(lt, lines.length, '"id"')).toBe(2);
  });
});
