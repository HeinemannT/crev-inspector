/**
 * Property-accessor completion — context parsing (the riskiest logic).
 *
 * findAccessorCall: is the cursor at a property-name argument position of an
 * accessor-taking method? findWhereClass: is it a `SELECT … WHERE <prop>` slot?
 * Both must NOT fire at value positions (after a comparator) so the t.<id>
 * value source owns those.
 */
import { describe, it, expect } from 'vitest';
import { findAccessorCall, findWhereClass, parseComparison } from '../propertyCompletions';

// `at` = the offset where the partial word starts (cursor minus the word).
// Tests pass the offset right after the relevant `(` / comma / space.
describe('findAccessorCall', () => {
  it('fires at the start of a filter predicate (property name)', () => {
    const t = '_risks.filter(';
    expect(findAccessorCall(t, t.length)).toEqual({ receiver: '_risks', method: 'filter' });
  });

  it('does NOT fire after the comparator in a filter (value position)', () => {
    const t = '_risks.filter(subtype = ';
    expect(findAccessorCall(t, t.length)).toBeNull();
  });

  it('fires for every arg of table()', () => {
    const a = '_r.table(';
    expect(findAccessorCall(a, a.length)).toEqual({ receiver: '_r', method: 'table' });
    const b = '_r.table(id, name, ';
    expect(findAccessorCall(b, b.length)).toEqual({ receiver: '_r', method: 'table' });
  });

  it('fires for every arg of addRow()', () => {
    const t = '_vt.addRow(a, ';
    expect(findAccessorCall(t, t.length)).toEqual({ receiver: '_vt', method: 'addRow' });
  });

  it('addColumn: skips the first (label) arg, fires on the expression arg', () => {
    const first = "_vt.addColumn(";
    expect(findAccessorCall(first, first.length)).toBeNull();
    const second = "_vt.addColumn('Label', ";
    expect(findAccessorCall(second, second.length)).toEqual({ receiver: '_vt', method: 'addColumn' });
  });

  it('sort/groupBy: only the first arg', () => {
    const s = '_r.sort(';
    expect(findAccessorCall(s, s.length)).toEqual({ receiver: '_r', method: 'sort' });
    const s2 = '_r.sort(amount, ';
    expect(findAccessorCall(s2, s2.length)).toBeNull();
  });

  it('ignores non-accessor methods (forEach/calculate)', () => {
    const t = '_r.forEach(';
    expect(findAccessorCall(t, t.length)).toBeNull();
  });

  it('returns null when not inside any call', () => {
    const t = '_risks ';
    expect(findAccessorCall(t, t.length)).toBeNull();
  });

  it('resolves the immediate receiver, paren-aware with nested calls', () => {
    const t = '_r.filter(amount > calc(x), '; // 2nd top-level arg of filter -> first-pred only fires arg 0
    expect(findAccessorCall(t, t.length)).toBeNull();
  });
});

describe('findWhereClass', () => {
  it('returns the SELECT class at a WHERE property-name slot', () => {
    expect(findWhereClass('_x := SELECT ceRiskAssessment WHERE ')).toBe('ceRiskAssessment');
  });

  it('fires after AND / OR too', () => {
    expect(findWhereClass('SELECT CeRiskAssessment WHERE id = "a" AND ')).toBe('CeRiskAssessment');
  });

  it('does NOT fire at a value position (after the comparator)', () => {
    expect(findWhereClass('SELECT CeRiskAssessment WHERE subtype = ')).toBeNull();
  });

  it('does NOT fire before WHERE appears', () => {
    expect(findWhereClass('SELECT CeRiskAssessment ')).toBeNull();
  });

  it('uses the LAST SELECT when several are present', () => {
    expect(findWhereClass('_a := SELECT Foo\n_b := SELECT Bar WHERE ')).toBe('Bar');
  });

  it('returns null with no SELECT', () => {
    expect(findWhereClass('output(_x) WHERE ')).toBeNull();
  });
});

describe('parseComparison', () => {
  it('extracts accessor at an empty value position after =', () => {
    const t = 'SELECT X WHERE subtype = ';
    expect(parseComparison(t, t.length)).toMatchObject({ accessor: 'subtype', valueStart: t.length });
  });

  it('captures a half-typed t.<id> value as the replace range', () => {
    const t = 'WHERE subtype = t.ma';
    const r = parseComparison(t, t.length);
    expect(r!.accessor).toBe('subtype');
    expect(t.slice(r!.valueStart)).toBe('t.ma'); // whole ref token replaced
  });

  it('handles != / <= / >= operators', () => {
    expect(parseComparison('WHERE a != ', 11)!.accessor).toBe('a');
    expect(parseComparison('WHERE score >= ', 15)!.accessor).toBe('score');
  });

  it('handles the CONTAINS word operator (tags)', () => {
    const t = 'WHERE domain_tags CONTAINS ';
    expect(parseComparison(t, t.length)!.accessor).toBe('domain_tags');
  });

  it('returns null when not right of a comparator', () => {
    expect(parseComparison('WHERE subtype', 13)).toBeNull(); // typing the accessor, no operator yet
    expect(parseComparison('output(x)', 9)).toBeNull();
  });
});
