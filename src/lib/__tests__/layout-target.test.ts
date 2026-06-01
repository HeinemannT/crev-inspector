import { describe, it, expect } from 'vitest';
import { resolveLayoutShortcut, LAYOUT_BEARING_TYPES } from '../layout-target';

describe('resolveLayoutShortcut', () => {
  it('routes to self when the object is layout-bearing (no highlight)', () => {
    expect(resolveLayoutShortcut({ rid: 'r1', type: 'Tab' }, { rid: 'p1', type: 'TabSet' }))
      .toEqual({ target: 'r1', targetType: 'Tab', selfIsLayout: true });
  });

  it('treats a Scorecard as a valid self target', () => {
    const r = resolveLayoutShortcut({ rid: 'sc', type: 'Scorecard' }, null);
    expect(r).toEqual({ target: 'sc', targetType: 'Scorecard', selfIsLayout: true });
  });

  it('routes to the parent (highlighting self) when only the parent is layout-bearing', () => {
    expect(resolveLayoutShortcut({ rid: 'w1', type: 'ExtendedTable' }, { rid: 'c1', type: 'Container' }))
      .toEqual({ target: 'c1', targetType: 'Container', highlight: 'w1', selfIsLayout: false });
  });

  it('returns null when neither object nor parent is layout-bearing', () => {
    expect(resolveLayoutShortcut({ rid: 'w1', type: 'ExtendedTable' }, { rid: 'k1', type: 'Kpi' }))
      .toBeNull();
  });

  it('returns null when self is a plain widget with no parent', () => {
    expect(resolveLayoutShortcut({ rid: 'w1', type: 'BarLineChart' }, null)).toBeNull();
  });

  it('returns null when the type is missing', () => {
    expect(resolveLayoutShortcut({ rid: 'w1' }, undefined)).toBeNull();
  });

  it('exposes the canonical layout-bearing set', () => {
    expect([...LAYOUT_BEARING_TYPES].sort()).toEqual(['Container', 'Scorecard', 'Tab', 'TabSet']);
  });
});
