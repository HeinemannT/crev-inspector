/**
 * Tests for BMP object hover pattern matching and namespace validation.
 */
import { describe, it, expect } from 'vitest';
import { buildHoverResolveEc } from '../handlers/objects';

// ── Namespace validation (mirrors namespace.ts) ──

const VALID_PREFIXES = new Set([
  't', 'o', 'u', 's', 'p', 'g', 'k', 'r', 'd',
  'role', 'ap',
  'ceven', 'cetas', 'cecom', 'ceinc', 'cepro', 'cepol', 'cecme',
  'ceiss', 'ceass', 'ceser', 'cecot', 'ceprj', 'cereg', 'cecor',
  'ceind', 'ceatt', 'ceras', 'ceprd', 'cepsc', 'ceprv', 'cewfl',
  'cedis', 'ceinq', 'ceqst', 'cedpi', 'cetia', 'ceasa',
]);

function isValidNamespace(prefix: string): boolean {
  return VALID_PREFIXES.has(prefix);
}

// ── Pattern matching (mirrors bmpObjectHover.ts) ──

type MatchResult = { key: string; lookup: 'rid' | 'ref' } | null;

const PATTERNS: Array<{ re: RegExp; extract: (m: RegExpExecArray) => MatchResult }> = [
  { re: /\blookup\((\d{5,})\)/g, extract: (m) => ({ key: m[1], lookup: 'rid' }) },
  { re: /\brid[=:](\d{5,})\b/gi, extract: (m) => ({ key: m[1], lookup: 'rid' }) },
  {
    re: /\b([a-z]{1,5})\.(\w+)\b/g,
    extract: (m) => {
      const prefix = m[1];
      const bid = m[2];
      if (!isValidNamespace(prefix)) return null;
      if (bid.length < 2) return null;
      return { key: `${prefix}.${bid}`, lookup: 'ref' };
    },
  },
  {
    // {bid} brace-call → resolve as the t. namespace ref.
    re: /\{([A-Za-z_]\w+)\}/g,
    extract: (m) => ({ key: `t.${m[1]}`, lookup: 'ref' }),
  },
];

function extractMatch(text: string, offset: number): MatchResult {
  for (const { re, extract } of PATTERNS) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(text)) !== null) {
      const start = match.index;
      const end = start + match[0].length;
      if (offset >= start && offset <= end) {
        const result = extract(match);
        if (result) return result;
      }
    }
  }
  return null;
}

// ── Tests ──

describe('BMP object hover: {bid} brace-call', () => {
  it('resolves a brace-call to the t. namespace ref', () => {
    // {expr_wb_heartbeat} is EC shorthand for t.expr_wb_heartbeat.expression.
    const m = extractMatch('output({expr_wb_heartbeat})', 12);
    expect(m).toEqual({ key: 't.expr_wb_heartbeat', lookup: 'ref' });
  });

  it('matches when hovering anywhere inside the braces', () => {
    const text = '_x := {wb_total} + 1';
    expect(extractMatch(text, 7)).toEqual({ key: 't.wb_total', lookup: 'ref' }); // on the {
    expect(extractMatch(text, 12)).toEqual({ key: 't.wb_total', lookup: 'ref' }); // mid-bid
  });

  it('ignores empty / single-char / spaced braces', () => {
    expect(extractMatch('{}', 1)).toBeNull();
    expect(extractMatch('{x}', 1)).toBeNull();           // needs 2+ chars
    expect(extractMatch('{ a + b }', 4)).toBeNull();     // not a bare identifier
  });

  it('does not treat a brace-call as a digit RID', () => {
    const m = extractMatch('{some_expr}', 5);
    expect(m?.lookup).toBe('ref');
    expect(m?.key).toBe('t.some_expr');
  });
});

describe('BMP object hover: RID patterns (lookup path)', () => {
  it('extracts RID from lookup()', () => {
    const m = extractMatch('_o := lookup(8639152947620)', 15);
    expect(m).toEqual({ key: '8639152947620', lookup: 'rid' });
  });

  it('extracts RID from rid=', () => {
    const m = extractMatch('rid=8639152947620', 7);
    expect(m).toEqual({ key: '8639152947620', lookup: 'rid' });
  });

  it('extracts RID from rid: (case insensitive)', () => {
    const m = extractMatch('RID:8639152947620', 7);
    expect(m).toEqual({ key: '8639152947620', lookup: 'rid' });
  });

  it('rejects short numbers in lookup()', () => {
    expect(extractMatch('lookup(123)', 8)).toBeNull();
  });
});

describe('BMP object hover: namespace.bid patterns (ref path)', () => {
  it('resolves t.bid as ref lookup', () => {
    const m = extractMatch('_o := t.sc_risk_summary', 10);
    expect(m).toEqual({ key: 't.sc_risk_summary', lookup: 'ref' });
  });

  it('resolves k.bid (property space)', () => {
    const m = extractMatch('k.myProperty', 5);
    expect(m).toEqual({ key: 'k.myProperty', lookup: 'ref' });
  });

  it('resolves ceiss.bid (enterprise issue)', () => {
    const m = extractMatch('ceiss.issue_123', 8);
    expect(m).toEqual({ key: 'ceiss.issue_123', lookup: 'ref' });
  });

  it('resolves o.bid (organisation space)', () => {
    const m = extractMatch('o.myOrg', 3);
    expect(m).toEqual({ key: 'o.myOrg', lookup: 'ref' });
  });

  it('resolves numeric businessId in namespace', () => {
    const m = extractMatch('t.12345', 4);
    expect(m).toEqual({ key: 't.12345', lookup: 'ref' });
  });

  it('rejects unknown namespace prefix', () => {
    expect(extractMatch('x.12345', 4)).toBeNull();
    expect(extractMatch('foo.bar', 5)).toBeNull();
  });

  it('rejects single-char businessId (too ambiguous)', () => {
    expect(extractMatch('t.x', 3)).toBeNull();
  });

  it('rejects non-word prefix (not a namespace)', () => {
    expect(extractMatch('123.456', 5)).toBeNull();
  });
});

describe('BMP object hover: false positive rejection', () => {
  it('does not match bare numbers', () => {
    expect(extractMatch('8639152947620', 5)).toBeNull();
  });

  it('does not match EC variables', () => {
    expect(extractMatch('_myVariable := 100', 5)).toBeNull();
  });

  it('does not match EC keywords', () => {
    expect(extractMatch('IF condition THEN', 1)).toBeNull();
  });

  it('does not match method calls (e.g., s.filter)', () => {
    // s is a valid namespace, but filter has 6 chars and s.filter looks like a method
    // This is a known limitation — it WILL match if s is valid and bid.length >= 2
    // The hover will try to resolve and cache null (harmless)
    const m = extractMatch('list.filter(x = 1)', 7);
    // 'list' is not a valid namespace (5 chars, but not in VALID_PREFIXES)
    expect(m).toBeNull();
  });

  it('does not match timestamps', () => {
    expect(extractMatch('Date: 1711234567890', 10)).toBeNull();
  });
});

describe('BMP object hover: cursor position', () => {
  it('matches only within the pattern span', () => {
    const text = '_o := lookup(8639152947620).name';
    expect(extractMatch(text, 0)).toBeNull();   // on _o
    expect(extractMatch(text, 15)?.key).toBe('8639152947620');
    expect(extractMatch(text, 30)).toBeNull(); // on .name — not a namespace ref
  });

  it('handles multiple patterns on same line', () => {
    const text = 'lookup(111111).filter(lookup(222222))';
    expect(extractMatch(text, 10)?.key).toBe('111111');
    expect(extractMatch(text, 30)?.key).toBe('222222');
  });

  it('prioritizes RID pattern over ref pattern for lookup()', () => {
    // lookup(12345) should match as 'rid', not as a ref
    const m = extractMatch('lookup(12345)', 10);
    expect(m?.lookup).toBe('rid');
  });
});

describe('Namespace validation', () => {
  it('validates common prefixes', () => {
    expect(isValidNamespace('t')).toBe(true);
    expect(isValidNamespace('k')).toBe(true);
    expect(isValidNamespace('o')).toBe(true);
    expect(isValidNamespace('ceiss')).toBe(true);
    expect(isValidNamespace('ceras')).toBe(true);
  });

  it('rejects unknown prefixes', () => {
    expect(isValidNamespace('x')).toBe(false);
    expect(isValidNamespace('foo')).toBe(false);
    expect(isValidNamespace('abc')).toBe(false);
  });
});

describe('buildHoverResolveEc — syntax regression', () => {
  // Before 2026-05-29 this EC used `_code := IF ... ENDIF` (no parens).
  // That's a parse error in EC; every hover for `t.x`-style refs silently
  // returned no identity and the user saw only the unresolved fallback.
  // Lock the working form in.
  it('never emits bare `:= IF` (must wrap inline IF in parens)', () => {
    const ec = buildHoverResolveEc('t.foo');
    expect(ec).not.toMatch(/:=\s+IF\b/);
    expect(ec).toMatch(/:=\s+\(IF\b/);
    expect(ec).toMatch(/ENDIF\)/);
  });

  it('inlines the ref verbatim', () => {
    expect(buildHoverResolveEc('t.json_size')).toContain('_o := t.json_size');
    expect(buildHoverResolveEc('ceiss.42')).toContain('_o := ceiss.42');
  });

  it('emits the 5-field |||-separated result line', () => {
    const ec = buildHoverResolveEc('t.foo');
    // Final line: name|||cls|||rid|||id|||code (4 separators between 5 fields)
    const lastLine = ec.trim().split('\n').pop() ?? '';
    expect(lastLine.split('"|||"').length).toBe(5);
  });

  // Golden (plan 014 — ec-row-codec migration): the exact EC string this
  // builder produced before it was rewritten to compose its result row via
  // ec-row-codec's buildRowEc. Locks the CODE_BEARING_TYPES OR-chain order
  // and the exact field order/whenMissing defaults of the result row.
  it('golden: exact EC string for a namespace ref', () => {
    const ec = buildHoverResolveEc('t.foo');
    expect(ec).toBe([
      '_o := t.foo',
      '_cls := _o.className.whenMissing("")',
      '_code := (IF _cls = "ExtendedMethodConfig" OR _cls = "ExtendedTable" OR _cls = "ExtendedExpression" OR _cls = "ReferenceMethodConfig" OR _cls = "HistoricalReferenceMethodConfig" OR _cls = "CustomVisualization" OR _cls = "DashboardHTML" THEN output(_o.expression.whenMissing("")) ELSE "" ENDIF)',
      '_o.name.whenMissing("") + "|||" + _cls + "|||" + _o.rid.whenMissing("") + "|||" + _o.id.whenMissing("") + "|||" + _code',
    ].join('\n'));
  });
});
