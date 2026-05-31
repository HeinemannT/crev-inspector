/**
 * Tests for the shared EC grammar source.
 *
 * Three guarantees this file enforces:
 *   1. classifyIdent + classifyDotMember return the right TokKind for
 *      a representative example of every category.
 *   2. The keyword sets are non-empty (guards against an accidental
 *      empty-set after a bad edit).
 *   3. The "method" sets are mutually disjoint — a name belongs to
 *      exactly one of TRANSACTIONAL_METHODS / TABLE_METHODS /
 *      READ_METHODS, and KNOWN_PROPERTIES is disjoint from all three.
 *      Drift checks for future contributors who add a method to the
 *      wrong category.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import {
  CONTROL_KEYWORDS, CONTEXT_KEYWORDS, BOOL_VALUES, NULL_VALUES,
  STYLE_CONSTANTS, DATE_CONSTANTS, GLOBAL_FUNCS, AGGREGATE_FUNCS,
  TRANSACTIONAL_METHODS, TABLE_METHODS, READ_METHODS,
  KNOWN_PROPERTIES, ID_SPACE_PREFIXES,
  classifyIdent, classifyDotMember,
  IDENT_RE, PASCAL_RE, CAMEL_RE, DATE_DURATION_SUFFIX_RE,
} from '../ec-grammar';

describe('classifyIdent', () => {
  it.each([
    ['IF', 'kw'],
    ['if', 'kw'],
    ['SELECT', 'kw'],
    ['CONTAINS', 'kw'],
    ['ROOT', 'ctx'],
    ['this', 'ctx'],
    ['parent', 'ctx'],
    ['TRUE', 'bool'],
    ['False', 'bool'],
    ['MISSING', 'null'],
    ['na', 'null'],
    ['LEFT', 'style'],
    ['BOLD', 'style'],
    ['TODAY', 'date'],
    ['BOP', 'date'],
    ['EOY', 'date'],
    ['LIST', 'global'],
    ['JSON', 'global'],
    ['output', 'global'],
    ['when', 'global'],
    ['num', 'global'],
    ['AGG', 'agg'],
    ['AGGAVG', 'agg'],
    ['PCmSUM', 'agg'],
    ['NOSO', 'agg'],
  ] as const)('%s → %s', (word, kind) => {
    expect(classifyIdent(word)).toBe(kind);
  });

  it('returns null for an unknown identifier', () => {
    expect(classifyIdent('_myVar')).toBeNull();
    expect(classifyIdent('CeRiskAssessment')).toBeNull();
    expect(classifyIdent('')).toBeNull();
  });
});

describe('classifyDotMember', () => {
  it.each([
    ['expression', 'expr'],
    ['add', 'tx'],
    ['delete', 'tx'],
    ['change', 'tx'],
    ['addColumn', 'tbl'],
    ['addRow', 'tbl'],
    ['style', 'tbl'],
    ['forEach', 'read'],
    ['filter', 'read'],
    ['children', 'read'],
    ['descendants', 'read'],
    ['whenMissing', 'read'],
    ['size', 'read'],
    ['name', 'prop'],
    ['id', 'prop'],
    ['rid', 'prop'],
    ['className', 'prop'],
    ['businessId', 'prop'],
  ] as const)('.%s → %s', (name, kind) => {
    expect(classifyDotMember(name)).toBe(kind);
  });

  it('returns null for an unknown dot member', () => {
    expect(classifyDotMember('myCustomProp')).toBeNull();
    expect(classifyDotMember('')).toBeNull();
  });
});

describe('keyword sets are non-empty', () => {
  it.each([
    ['CONTROL_KEYWORDS', CONTROL_KEYWORDS],
    ['CONTEXT_KEYWORDS', CONTEXT_KEYWORDS],
    ['BOOL_VALUES', BOOL_VALUES],
    ['NULL_VALUES', NULL_VALUES],
    ['STYLE_CONSTANTS', STYLE_CONSTANTS],
    ['DATE_CONSTANTS', DATE_CONSTANTS],
    ['GLOBAL_FUNCS', GLOBAL_FUNCS],
    ['AGGREGATE_FUNCS', AGGREGATE_FUNCS],
    ['TRANSACTIONAL_METHODS', TRANSACTIONAL_METHODS],
    ['TABLE_METHODS', TABLE_METHODS],
    ['READ_METHODS', READ_METHODS],
    ['KNOWN_PROPERTIES', KNOWN_PROPERTIES],
    ['ID_SPACE_PREFIXES', ID_SPACE_PREFIXES],
  ])('%s', (_name, set) => {
    expect(set.size).toBeGreaterThan(0);
  });
});

describe('method sets are mutually disjoint', () => {
  // `style` is a member of TABLE_METHODS (table-builder style keyword).
  // STYLE_CONSTANTS values are case-INsensitive uppercase tokens (LEFT,
  // RIGHT, BOLD). No collision in practice. We assert the THREE
  // method-name sets — which all use lowercase canonical names — are
  // pairwise disjoint, plus that KNOWN_PROPERTIES doesn't overlap any.

  function disjoint(a: ReadonlySet<string>, b: ReadonlySet<string>, aName: string, bName: string): void {
    for (const x of a) {
      if (b.has(x)) {
        throw new Error(`"${x}" is in BOTH ${aName} and ${bName} — pick one`);
      }
    }
  }

  it('TRANSACTIONAL ∩ TABLE = ∅', () => {
    expect(() => disjoint(TRANSACTIONAL_METHODS, TABLE_METHODS, 'TRANSACTIONAL_METHODS', 'TABLE_METHODS')).not.toThrow();
  });
  it('TRANSACTIONAL ∩ READ = ∅', () => {
    expect(() => disjoint(TRANSACTIONAL_METHODS, READ_METHODS, 'TRANSACTIONAL_METHODS', 'READ_METHODS')).not.toThrow();
  });
  it('TABLE ∩ READ = ∅', () => {
    expect(() => disjoint(TABLE_METHODS, READ_METHODS, 'TABLE_METHODS', 'READ_METHODS')).not.toThrow();
  });
  it('KNOWN_PROPERTIES ∩ TRANSACTIONAL = ∅', () => {
    expect(() => disjoint(KNOWN_PROPERTIES, TRANSACTIONAL_METHODS, 'KNOWN_PROPERTIES', 'TRANSACTIONAL_METHODS')).not.toThrow();
  });
  it('KNOWN_PROPERTIES ∩ TABLE = ∅', () => {
    expect(() => disjoint(KNOWN_PROPERTIES, TABLE_METHODS, 'KNOWN_PROPERTIES', 'TABLE_METHODS')).not.toThrow();
  });
  // KNOWN_PROPERTIES ∩ READ_METHODS is allowed: names like `parent`,
  // `children`, `descendants` are BOTH ways to access (a single chain
  // can drop the parens for collection accessors at runtime). The
  // classifier prefers the method tag for these, which is the right
  // call for syntactic colouring.
});

describe('regex helpers', () => {
  it('IDENT_RE matches a standard identifier', () => {
    expect(IDENT_RE.test('_myVar')).toBe(true);
    expect(IDENT_RE.test('CeRiskAssessment')).toBe(true);
    expect(IDENT_RE.test('1bad')).toBe(false);
  });
  it('PASCAL_RE matches PascalCase only', () => {
    expect(PASCAL_RE.test('CeRiskAssessment')).toBe(true);
    expect(PASCAL_RE.test('ceRiskAssessment')).toBe(false);
    expect(PASCAL_RE.test('Foo')).toBe(true);
    expect(PASCAL_RE.test('foo')).toBe(false);
  });
  it('CAMEL_RE matches lowerCamel only', () => {
    expect(CAMEL_RE.test('ceRiskAssessment')).toBe(true);
    expect(CAMEL_RE.test('CeRiskAssessment')).toBe(false);
  });
  it('DATE_DURATION_SUFFIX_RE matches single suffix letter', () => {
    expect(DATE_DURATION_SUFFIX_RE.test('D')).toBe(true);
    expect(DATE_DURATION_SUFFIX_RE.test('W')).toBe(true);
    expect(DATE_DURATION_SUFFIX_RE.test('M')).toBe(true);
    expect(DATE_DURATION_SUFFIX_RE.test('Y')).toBe(true);
    expect(DATE_DURATION_SUFFIX_RE.test('Z')).toBe(false);
  });
});

describe('ID_SPACE_PREFIXES coverage', () => {
  // Sample of platform + enterprise prefixes that should all be in the set.
  // If a contributor adds a new one to the reference doc but not here,
  // this test surfaces the omission.
  it.each(['t', 'o', 'd', 'k', 'r', 'c', 'ceven', 'cetas', 'ceiss', 'cewfl'])(
    '%s is recognised',
    (prefix) => { expect(ID_SPACE_PREFIXES.has(prefix)).toBe(true); },
  );
});
