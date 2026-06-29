/**
 * Property-accessor completion — context parsing (the riskiest logic).
 *
 * findAccessorCall: is the cursor at a property-name argument position of an
 * accessor-taking method? findWhereClass: is it a `SELECT … WHERE <prop>` slot?
 * Both must NOT fire at value positions (after a comparator) so the t.<id>
 * value source owns those.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { findAccessorCall, findWhereClass, parseComparison, chainRoot, resolveSelfType, resolveDotMember } from '../propertyCompletions';
import { scanDocForInferences, _resetForTests } from '../typeInference';

/** Build the minimal doc-like object scanDocForInferences expects from a string. */
function docOf(src: string) {
  const lines = src.split('\n');
  return { lines: lines.length, line: (n: number) => ({ text: lines[n - 1] }) };
}

// `at` = the offset where the partial word starts (cursor minus the word).
// Tests pass the offset right after the relevant `(` / comma / space.
describe('findAccessorCall', () => {
  it('fires at the start of a filter predicate (property name)', () => {
    const t = '_risks.filter(';
    expect(findAccessorCall(t, t.length)).toMatchObject({ receiver: '_risks', method: 'filter' });
  });

  it('does NOT fire after the comparator in a filter (value position)', () => {
    const t = '_risks.filter(subtype = ';
    expect(findAccessorCall(t, t.length)).toBeNull();
  });

  it('fires for every arg of table()', () => {
    const a = '_r.table(';
    expect(findAccessorCall(a, a.length)).toMatchObject({ receiver: '_r', method: 'table' });
    const b = '_r.table(id, name, ';
    expect(findAccessorCall(b, b.length)).toMatchObject({ receiver: '_r', method: 'table' });
  });

  it('fires for every arg of addRow()', () => {
    const t = '_vt.addRow(a, ';
    expect(findAccessorCall(t, t.length)).toMatchObject({ receiver: '_vt', method: 'addRow' });
  });

  it('addColumn: skips the first (label) arg, fires on the expression arg', () => {
    const first = "_vt.addColumn(";
    expect(findAccessorCall(first, first.length)).toBeNull();
    const second = "_vt.addColumn('Label', ";
    expect(findAccessorCall(second, second.length)).toMatchObject({ receiver: '_vt', method: 'addColumn' });
  });

  it('sort/groupBy: only the first arg', () => {
    const s = '_r.sort(';
    expect(findAccessorCall(s, s.length)).toMatchObject({ receiver: '_r', method: 'sort' });
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

describe('ref / rref + self context', () => {
  it('fires inside .ref( and .rref( (reference-property position)', () => {
    const r = '_risk.ref(';
    expect(findAccessorCall(r, r.length)).toMatchObject({ receiver: '_risk', method: 'ref' });
    const rr = '_risk.rref(';
    expect(findAccessorCall(rr, rr.length)).toMatchObject({ receiver: '_risk', method: 'rref' });
  });

  it('reports a self receiver with its position', () => {
    const t = '_l.table(self.ref(';
    const m = findAccessorCall(t, t.length);
    expect(m).toMatchObject({ receiver: 'self', method: 'ref' });
    expect(t.slice(m!.receiverStart, m!.receiverStart + 4)).toBe('self');
  });

  it('chainRoot walks past .table()/.addColumn() to the root var', () => {
    // index just left of the `.addColumn` dot in `list.table().addColumn`
    const t = 'list.table().addColumn';
    const dot = t.lastIndexOf('.addColumn');
    expect(chainRoot(t, dot - 1)).toBe('list');
  });

  it('chainRoot returns a bare receiver var', () => {
    const t = '_risks';
    expect(chainRoot(t, t.length - 1)).toBe('_risks');
  });

  it('chainRoot handles a single call segment', () => {
    const t = '_risks.filter(x)';
    // from just left of a hypothetical next `.method` after the close paren
    expect(chainRoot(t, t.length - 1)).toBe('_risks');
  });
});

describe('resolveSelfType', () => {
  beforeEach(() => _resetForTests());

  it('resolves self to the receiver list element type inside an element-context call', () => {
    scanDocForInferences(docOf('_l := SELECT Foo'));
    const line = '_l.table(self.';
    expect(resolveSelfType(line, line.indexOf('self'))).toEqual(['Foo']);
  });

  it('resolves through a chained receiver (list.table().addColumn(self.…))', () => {
    scanDocForInferences(docOf('_l := SELECT Bar'));
    const line = "_l.table().addColumn('t', self.";
    expect(resolveSelfType(line, line.indexOf('self'))).toEqual(['Bar']);
  });

  it('returns null when self is not inside an element-context call', () => {
    scanDocForInferences(docOf('_l := SELECT Foo'));
    expect(resolveSelfType('output(self.', 'output('.length)).toBeNull();
  });

  it('returns null when the receiver is not a tracked var', () => {
    expect(resolveSelfType('unknown.table(self.', 'unknown.table('.length)).toBeNull();
  });
});

describe('resolveDotMember', () => {
  beforeEach(() => _resetForTests());

  // `at` = the offset where the partial property word starts (right after the dot).
  const at = (line: string) => line.length;

  it('returns null when the cursor is not immediately after a dot', () => {
    expect(resolveDotMember('_obj', 4)).toBeNull();
    expect(resolveDotMember('_obj ', 5)).toBeNull();
  });

  it('offers props for a tracked SCALAR var (_obj.<prop>)', () => {
    scanDocForInferences(docOf('_l := SELECT CeRiskAssessment\n_o := _l.first()'));
    const line = '_o.';
    expect(resolveDotMember(line, at(line))).toEqual({ types: ['CeRiskAssessment'] });
  });

  it('stays silent for a LIST var at a bare dot (methods, not props)', () => {
    scanDocForInferences(docOf('_l := SELECT CeRiskAssessment'));
    const line = '_l.';
    expect(resolveDotMember(line, at(line))).toBeNull();
  });

  it('collapses an inline .first()/.last() chain to the element type', () => {
    scanDocForInferences(docOf('_l := SELECT CeRiskAssessment'));
    expect(resolveDotMember('_l.first().', '_l.first().'.length)).toEqual({ types: ['CeRiskAssessment'] });
    expect(resolveDotMember('_l.last().', '_l.last().'.length)).toEqual({ types: ['CeRiskAssessment'] });
  });

  it('collapses a multi-step chain (.filter(...).first()) to the element type', () => {
    scanDocForInferences(docOf('_l := SELECT CeRiskAssessment'));
    const line = '_l.filter(subtype = t.master).first().';
    expect(resolveDotMember(line, line.length)).toEqual({ types: ['CeRiskAssessment'] });
  });

  it('stays silent for a list-returning chain (.filter() with no pick-one)', () => {
    scanDocForInferences(docOf('_l := SELECT CeRiskAssessment'));
    const line = '_l.filter(subtype = t.master).';
    expect(resolveDotMember(line, line.length)).toBeNull();
  });

  it('types an .ancestor(T) chain from the call argument', () => {
    const line = '_o.ancestor(Organisation).';
    expect(resolveDotMember(line, line.length)).toEqual({ types: ['Organisation'] });
  });

  it('returns a ref for a ns.bid reference (ceras.foo.<prop>) — resolved async', () => {
    const line = 'ceras.stmt_supplier_failure.';
    expect(resolveDotMember(line, line.length)).toEqual({ ref: 'ceras.stmt_supplier_failure' });
  });

  it('returns a nav-path ref for a CONCRETE nested hop (ceras.foo.parent.<prop>)', () => {
    const line = 'ceras.stmt_supplier_failure.owning_org.';
    expect(resolveDotMember(line, line.length)).toEqual({ ref: 'ceras.stmt_supplier_failure.owning_org' });
  });

  it('resolves a nested hop up to MAX_REF_HOPS (2) but not beyond', () => {
    const ok = 'ceras.foo.parent.owner.'; // 2 hops past the bid
    expect(resolveDotMember(ok, ok.length)).toEqual({ ref: 'ceras.foo.parent.owner' });
    const tooDeep = 'ceras.foo.parent.owner.org.'; // 3 hops → refused
    expect(resolveDotMember(tooDeep, tooDeep.length)).toBeNull();
  });

  it('does NOT treat a non-namespace receiver as a ref', () => {
    // `notns` is not an ID-space prefix, so `notns.foo.` is a nested hop — unsupported.
    const line = 'notns.foo.';
    expect(resolveDotMember(line, line.length)).toBeNull();
  });

  it('refuses a nested hop off a NON-concrete base (_obj.someRef.<prop>) — would need a SELECT scan', () => {
    scanDocForInferences(docOf('_l := SELECT CeRiskAssessment\n_o := _l.first()'));
    const line = '_o.owner_reference.';
    expect(resolveDotMember(line, line.length)).toBeNull();
  });

  it('refuses a nested hop off a call-rooted base (_l.first().parent.)', () => {
    scanDocForInferences(docOf('_l := SELECT CeRiskAssessment'));
    const line = '_l.first().parent.';
    expect(resolveDotMember(line, line.length)).toBeNull();
  });

  it('does NOT treat a prefix after a dot as a ns.bid (obj.ceras.x)', () => {
    const line = 'obj.ceras.x.';
    expect(resolveDotMember(line, line.length)).toBeNull();
  });

  it('resolves self.<prop> to the enclosing element type', () => {
    scanDocForInferences(docOf('_l := SELECT Foo'));
    const line = '_l.table(self.';
    expect(resolveDotMember(line, line.length)).toEqual({ types: ['Foo'] });
  });

  it('stays silent for an unknown/untracked scalar var', () => {
    const line = '_mystery.';
    expect(resolveDotMember(line, line.length)).toBeNull();
  });
});
