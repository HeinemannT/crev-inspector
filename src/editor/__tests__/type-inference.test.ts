/**
 * Tests for the RHS parser in typeInference.ts.
 *
 * The async parts (ensureSchema → SW round-trip, root-category
 * resolver) are smoke-stubbed via globalThis.chrome; only the
 * synchronous pattern-matching is exercised here.
 *
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { scanDocForInferences, getInference, clearInferences } from '../ec/typeInference';

// Mock chrome.runtime.sendMessage so ensureSchema doesn't blow up
// (it fires off requests for every type it sees).
beforeEach(() => {
  (globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { sendMessage: vi.fn(() => Promise.resolve({ ok: false })) },
  };
  clearInferences();
});

// Lightweight doc shim that mirrors the {lines, line(n)} contract the
// real CodeMirror Doc exposes for our purposes.
function fakeDoc(text: string): { lines: number; line(n: number): { text: string } } {
  const lines = text.split('\n');
  return {
    lines: lines.length,
    line: (n: number) => ({ text: lines[n - 1] ?? '' }),
  };
}

function infer(src: string) {
  scanDocForInferences(fakeDoc(src));
}

describe('RHS parser — list shapes', () => {
  it('SELECT X → List<X>', () => {
    infer('_v := SELECT CeRiskAssessment');
    const inf = getInference('_v');
    expect(inf).toMatchObject({ kind: 'list', types: ['CeRiskAssessment'] });
  });

  it('SELECT X, Y, Z → List<X|Y|Z>', () => {
    infer('_v := SELECT CeRiskAssessment, CeIssue, CeTask');
    expect(getInference('_v')).toMatchObject({
      kind: 'list',
      types: ['CeRiskAssessment', 'CeIssue', 'CeTask'],
    });
  });

  it('SELECT X WHERE … FROM … ORDER BY … → still List<X>', () => {
    infer('_v := SELECT CeRiskAssessment FROM root WHERE id != "" ORDER BY name');
    expect(getInference('_v')).toMatchObject({ kind: 'list', types: ['CeRiskAssessment'] });
  });

  it('lowercased select keyword is accepted', () => {
    infer('_v := select CeIssue');
    expect(getInference('_v')).toMatchObject({ kind: 'list', types: ['CeIssue'] });
  });

  it('lowerCamelCase type name canonicalises to PascalCase (so schema fetch lands)', () => {
    // BMP's SELECT is case-insensitive at the QUERY level but the
    // BeanInfo / FETCH_TYPE_SCHEMA pathway needs PascalCase.
    // `ceRiskAssessment` is normalized to `CeRiskAssessment` so the
    // Vars panel can show the right schema.
    infer('_v := SELECT ceRiskAssessment');
    expect(getInference('_v')).toMatchObject({ kind: 'list', types: ['CeRiskAssessment'] });
  });

  it('SELECT canonicalises every comma-separated type', () => {
    infer('_v := SELECT ceRiskAssessment, ceIssue, scorecard');
    expect(getInference('_v')).toMatchObject({
      kind: 'list',
      types: ['CeRiskAssessment', 'CeIssue', 'Scorecard'],
    });
  });

  it('PascalCase SELECT type passes through unchanged', () => {
    infer('_v := SELECT CeRiskAssessment');
    expect(getInference('_v')).toMatchObject({ kind: 'list', types: ['CeRiskAssessment'] });
  });

  it('paren-wrapped SELECT unwraps cleanly', () => {
    infer('_v := (SELECT CeIssue)');
    expect(getInference('_v')).toMatchObject({ kind: 'list', types: ['CeIssue'] });
  });

  it('double-paren SELECT (live-verified EC accepts any depth)', () => {
    infer('_v := ((SELECT CeIssue))');
    expect(getInference('_v')).toMatchObject({ kind: 'list', types: ['CeIssue'] });
  });

  it('triple-paren SELECT', () => {
    infer('_v := (((SELECT CeIssue)))');
    expect(getInference('_v')).toMatchObject({ kind: 'list', types: ['CeIssue'] });
  });
});

describe('RHS parser — (IF cond THEN expr ELSE expr ENDIF)', () => {
  // EC live-test confirmed: IF as an RHS expression only works when
  // wrapped in parens; bare `IF ... ENDIF` errors at the parser. Inner
  // expression's type comes through verbatim.

  it('paren-IF returning a SELECT → list of select type', () => {
    infer('_v := (IF TRUE THEN SELECT CeRiskAssessment ELSE LIST() ENDIF)');
    expect(getInference('_v')).toMatchObject({ kind: 'list', types: ['CeRiskAssessment'] });
  });

  it('paren-IF returning a lowerCamel SELECT canonicalises through', () => {
    infer('_v := (IF cond THEN SELECT ceRiskAssessment ELSE LIST() ENDIF)');
    expect(getInference('_v')).toMatchObject({ kind: 'list', types: ['CeRiskAssessment'] });
  });

  it('paren-IF returning root.X.children() → list', () => {
    infer('_v := (IF cond THEN root.ceRiskAssessment.children() ELSE LIST() ENDIF)');
    const inf = getInference('_v');
    // Either resolved sync (rare) or unknown-with-resolving-reason
    // — both kinds are acceptable here because the root-category
    // resolver is async-stubbed in the test harness. What matters is
    // we DID dive into the THEN branch instead of staying at "unknown
    // assignment shape".
    expect(inf?.kind === 'list' || (inf?.kind === 'unknown' && /resolving/.test(inf.reason))).toBe(true);
  });

  it('paren-IF returning a string literal → string primitive', () => {
    infer('_v := (IF TRUE THEN "yes" ELSE "no" ENDIF)');
    expect(getInference('_v')).toMatchObject({ kind: 'primitive', primitive: 'string' });
  });

  it('paren-IF wrapping a paren-IF (nested)', () => {
    infer('_v := ((IF TRUE THEN SELECT CeIssue ELSE LIST() ENDIF))');
    expect(getInference('_v')).toMatchObject({ kind: 'list', types: ['CeIssue'] });
  });
});

describe('RHS parser — root navigation', () => {
  it('root.cat.children() → List<resolved>', () => {
    // Resolver is async-stubbed, so we just expect the synchronous fall-through
    // to be "unknown: resolving …" rather than "unrecognised assignment shape".
    infer('_v := root.ceControlMeasure.children()');
    const inf = getInference('_v');
    expect(inf?.kind).toBe('unknown');
    if (inf?.kind === 'unknown') expect(inf.reason).toMatch(/resolving/);
  });

  it('root.cat.children (no parens) is also accepted', () => {
    infer('_v := root.ceControlMeasure.children');
    const inf = getInference('_v');
    expect(inf?.kind).toBe('unknown');
    if (inf?.kind === 'unknown') expect(inf.reason).toMatch(/resolving/);
  });

  it('root.cat.descendants (no parens) is also accepted', () => {
    infer('_v := root.ceIssue.descendants');
    const inf = getInference('_v');
    expect(inf?.kind).toBe('unknown');
    if (inf?.kind === 'unknown') expect(inf.reason).toMatch(/resolving/);
  });
});

describe('RHS parser — typed-arg navigation', () => {
  it('foo.children(T) → List<T>', () => {
    infer('_v := _scope.children(ExtendedTable)');
    expect(getInference('_v')).toMatchObject({ kind: 'list', types: ['ExtendedTable'] });
  });

  it('foo.descendants(T) → List<T>', () => {
    infer('_v := _scope.descendants(ExtendedTable)');
    expect(getInference('_v')).toMatchObject({ kind: 'list', types: ['ExtendedTable'] });
  });

  it('foo.ancestor(T) → scalar T', () => {
    infer('_v := _x.ancestor(Scorecard)');
    expect(getInference('_v')).toMatchObject({ kind: 'scalar', type: 'Scorecard' });
  });

  it('chained typed-nav still resolves last segment', () => {
    infer('_v := _x.parent.children(ExtendedTable)');
    expect(getInference('_v')).toMatchObject({ kind: 'list', types: ['ExtendedTable'] });
  });

  it('typed-nav with lowerCamel arg → canonicalises (List)', () => {
    infer('_v := _scope.children(ceRiskAssessment)');
    expect(getInference('_v')).toMatchObject({ kind: 'list', types: ['CeRiskAssessment'] });
  });

  it('typed-nav with lowerCamel arg → canonicalises (Scalar via ancestor)', () => {
    infer('_v := _x.ancestor(scorecard)');
    expect(getInference('_v')).toMatchObject({ kind: 'scalar', type: 'Scorecard' });
  });
});

describe('RHS parser — chain inference from tracked vars', () => {
  it('.first() collapses List<T> to T', () => {
    infer([
      '_xs := SELECT CeRiskAssessment',
      '_x := _xs.first()',
    ].join('\n'));
    expect(getInference('_x')).toMatchObject({ kind: 'scalar', type: 'CeRiskAssessment' });
  });

  it('.last() collapses List<T> to T', () => {
    infer([
      '_xs := SELECT CeIssue',
      '_x := _xs.last()',
    ].join('\n'));
    expect(getInference('_x')).toMatchObject({ kind: 'scalar', type: 'CeIssue' });
  });

  it('.filter(...) preserves list type', () => {
    infer([
      '_xs := SELECT CeRiskAssessment',
      '_ys := _xs.filter(name != "")',
    ].join('\n'));
    expect(getInference('_ys')).toMatchObject({ kind: 'list', types: ['CeRiskAssessment'] });
  });

  it('.sort(prop) preserves list type', () => {
    infer([
      '_xs := SELECT CeIssue',
      '_ys := _xs.sort(name)',
    ].join('\n'));
    expect(getInference('_ys')).toMatchObject({ kind: 'list', types: ['CeIssue'] });
  });

  it('chain on unknown base returns unknown', () => {
    infer('_v := _unknownBase.first()');
    expect(getInference('_v')?.kind).toBe('unknown');
  });
});

describe('RHS parser — set ops', () => {
  it('.merge(SELECT Y) on List<X> → List<X|Y>', () => {
    infer([
      '_a := SELECT CeRiskAssessment',
      '_b := _a.merge(SELECT CeIssue)',
    ].join('\n'));
    expect(getInference('_b')).toMatchObject({
      kind: 'list',
      types: ['CeRiskAssessment', 'CeIssue'],
    });
  });

  it('.union(SELECT Y) on List<X> → List<X|Y>', () => {
    infer([
      '_a := SELECT CeRiskAssessment',
      '_b := _a.union(SELECT CeIssue)',
    ].join('\n'));
    expect(getInference('_b')).toMatchObject({
      kind: 'list',
      types: ['CeRiskAssessment', 'CeIssue'],
    });
  });

  it('merge result deduplicates type names', () => {
    infer([
      '_a := SELECT CeRiskAssessment',
      '_b := _a.merge(SELECT CeRiskAssessment)',
    ].join('\n'));
    expect(getInference('_b')).toMatchObject({
      kind: 'list',
      types: ['CeRiskAssessment'],
    });
  });

  it('merge with lowerCamel inner SELECT canonicalises', () => {
    infer([
      '_a := SELECT CeRiskAssessment',
      '_b := _a.merge(SELECT ceIssue)',
    ].join('\n'));
    expect(getInference('_b')).toMatchObject({
      kind: 'list',
      types: ['CeRiskAssessment', 'CeIssue'],
    });
  });
});

describe('RHS parser — defaulting + output + method primitives', () => {
  it('output(...) → string primitive', () => {
    infer('_v := output(t.foo.expression)');
    expect(getInference('_v')).toMatchObject({ kind: 'primitive', primitive: 'string' });
  });

  it('_y.whenMissing("") preserves list base type', () => {
    infer([
      '_xs := SELECT CeIssue',
      '_ys := _xs.whenMissing("")',
    ].join('\n'));
    expect(getInference('_ys')).toMatchObject({ kind: 'list', types: ['CeIssue'] });
  });

  it('output(...).whenMissing("") is still a string', () => {
    // Chain on output() — receiver is not a tracked var, so the fallback
    // string classification kicks in. Avoids "unknown" for the most
    // common defaulting pattern in EC.
    infer('_v := output(t.foo.expression).whenMissing("")');
    expect(getInference('_v')).toMatchObject({ kind: 'primitive', primitive: 'string' });
  });

  it('_y.size() → number', () => {
    infer([
      '_xs := SELECT CeIssue',
      '_n := _xs.size()',
    ].join('\n'));
    expect(getInference('_n')).toMatchObject({ kind: 'primitive', primitive: 'number' });
  });

  it('_y.indexOf("x") → number', () => {
    infer('_n := _s.indexOf("x")');
    expect(getInference('_n')).toMatchObject({ kind: 'primitive', primitive: 'number' });
  });

  it('_y.toString() → string', () => {
    infer('_s := _x.toString()');
    expect(getInference('_s')).toMatchObject({ kind: 'primitive', primitive: 'string' });
  });

  it('bare var copy passes through type', () => {
    infer([
      '_a := SELECT CeRiskAssessment',
      '_b := _a',
    ].join('\n'));
    expect(getInference('_b')).toMatchObject({ kind: 'list', types: ['CeRiskAssessment'] });
  });
});

describe('RHS parser — primitive literals', () => {
  it.each([
    ['_n := 42', 'number'],
    ['_n := -3.14', 'number'],
    ['_s := "hello"', 'string'],
    ["_s := 'world'", 'string'],
    ['_b := True', 'bool'],
    ['_b := false', 'bool'],
    ['_d := today', 'date'],
    ['_d := BOP', 'date'],
    ['_d := date("2026-01-01")', 'date'],
  ])('infers primitive for %s', (src, primitive) => {
    infer(src);
    const inf = getInference(src.split(' ')[0]);
    expect(inf?.kind).toBe('primitive');
    if (inf?.kind === 'primitive') expect(inf.primitive).toBe(primitive);
  });
});

describe('RHS parser — real-world coding shapes', () => {
  it('str(...) → string', () => {
    infer('_t := str(_x)');
    expect(getInference('_t')).toMatchObject({ kind: 'primitive', primitive: 'string' });
  });

  it('num(...) → number', () => {
    infer('_n := num(_raw)');
    expect(getInference('_n')).toMatchObject({ kind: 'primitive', primitive: 'number' });
  });

  it('foo.add(Type, …) → scalar Type', () => {
    infer('_folder := targetFolder.add(Category, id := "x", name := "X")');
    expect(getInference('_folder')).toMatchObject({ kind: 'scalar', type: 'Category' });
  });

  it('foo.add(lowerCase, …) → canonicalises to PascalCase', () => {
    infer('_x := target.add(ceIssue, id := "iss_1")');
    expect(getInference('_x')).toMatchObject({ kind: 'scalar', type: 'CeIssue' });
  });

  it('root.X.add(Type, …) → scalar Type', () => {
    infer('_prop := root.property.add(ReferenceMethodConfig)');
    expect(getInference('_prop')).toMatchObject({ kind: 'scalar', type: 'ReferenceMethodConfig' });
  });

  it('JSON(...) → unknown with descriptive reason', () => {
    infer('_arr := JSON(\'[{"id":1}]\')');
    const inf = getInference('_arr');
    expect(inf?.kind).toBe('unknown');
    if (inf?.kind === 'unknown') expect(inf.reason).toMatch(/JSON literal/);
  });

  it('MAP(...) → unknown with descriptive reason', () => {
    infer('_m := MAP("a";1, "b";2)');
    const inf = getInference('_m');
    expect(inf?.kind).toBe('unknown');
    if (inf?.kind === 'unknown') expect(inf.reason).toMatch(/MAP literal/);
  });

  it('when(...) → unknown with descriptive reason', () => {
    infer('_x := when(_value.isMissing(), "N/A", _value)');
    const inf = getInference('_x');
    expect(inf?.kind).toBe('unknown');
    if (inf?.kind === 'unknown') expect(inf.reason).toMatch(/when/);
  });

  it('t.<id> reference → unknown with template hint', () => {
    infer('_tmpl := t.xpl_tmpl_issue');
    const inf = getInference('_tmpl');
    expect(inf?.kind).toBe('unknown');
    if (inf?.kind === 'unknown') expect(inf.reason).toMatch(/template/);
  });

  it('o.<rid> reference → unknown with rid hint', () => {
    infer('_obj := o.100');
    const inf = getInference('_obj');
    expect(inf?.kind).toBe('unknown');
    if (inf?.kind === 'unknown') expect(inf.reason).toMatch(/RID/i);
  });

  it('this.object → unknown with context hint', () => {
    infer('_o := this.object');
    const inf = getInference('_o');
    expect(inf?.kind).toBe('unknown');
    if (inf?.kind === 'unknown') expect(inf.reason).toMatch(/this|context/i);
  });

  it('MISSING literal → unknown with explicit reason', () => {
    infer('_x := MISSING');
    const inf = getInference('_x');
    expect(inf?.kind).toBe('unknown');
    if (inf?.kind === 'unknown') expect(inf.reason).toMatch(/MISSING/);
  });

  it('counter increment `_n := _n + 1` → number', () => {
    infer('_count := _count + 1');
    expect(getInference('_count')).toMatchObject({ kind: 'primitive', primitive: 'number' });
  });

  it('division `_avg := _total / _count` → number', () => {
    infer('_avg := _total / _count');
    expect(getInference('_avg')).toMatchObject({ kind: 'primitive', primitive: 'number' });
  });

  it('string-concat with literal → string', () => {
    infer('_r := "Name: " + this.object.name + "\\n"');
    expect(getInference('_r')).toMatchObject({ kind: 'primitive', primitive: 'string' });
  });
});

describe('RHS parser — unknown / unsupported shapes', () => {
  it('rref() returns unknown (heterogeneous, no static type)', () => {
    infer('_v := _x.rref()');
    expect(getInference('_v')?.kind).toBe('unknown');
  });

  it('LIST(...) is unknown — element types not statically derivable', () => {
    infer('_v := LIST(t.foo, t.bar)');
    expect(getInference('_v')?.kind).toBe('unknown');
  });

  it('MAP(...) is unknown — wrong shape for the panel', () => {
    infer('_v := MAP("a"; 1)');
    expect(getInference('_v')?.kind).toBe('unknown');
  });
});

describe('Reserved names are ignored', () => {
  it('skips lines like `if x := …` because if/then/else are reserved', () => {
    infer('IF condition := SELECT CeIssue');
    expect(getInference('IF')).toBeUndefined();
    expect(getInference('if')).toBeUndefined();
  });

  it('skips root/this/self/today/bop/eop', () => {
    infer([
      'root := SELECT X',
      'this := SELECT X',
      'today := SELECT X',
    ].join('\n'));
    expect(getInference('root')).toBeUndefined();
    expect(getInference('this')).toBeUndefined();
    expect(getInference('today')).toBeUndefined();
  });
});

describe('Multiple-assignment scenarios', () => {
  it('first-assignment-wins when same name reassigned', () => {
    infer([
      '_v := SELECT CeRiskAssessment',
      '_v := SELECT CeIssue',
    ].join('\n'));
    // First wins — matches the existing Vars panel behaviour.
    expect(getInference('_v')).toMatchObject({ kind: 'list', types: ['CeRiskAssessment'] });
  });

  it('captures multiple distinct vars', () => {
    infer([
      '_a := SELECT CeRiskAssessment',
      '_b := SELECT CeIssue',
      '_c := _a.filter(id != "")',
    ].join('\n'));
    expect(getInference('_a')).toMatchObject({ kind: 'list', types: ['CeRiskAssessment'] });
    expect(getInference('_b')).toMatchObject({ kind: 'list', types: ['CeIssue'] });
    expect(getInference('_c')).toMatchObject({ kind: 'list', types: ['CeRiskAssessment'] });
  });
});

describe('clearInferences', () => {
  it('drops every tracked var', () => {
    infer('_v := SELECT CeRiskAssessment');
    expect(getInference('_v')).toBeDefined();
    clearInferences();
    expect(getInference('_v')).toBeUndefined();
  });
});
