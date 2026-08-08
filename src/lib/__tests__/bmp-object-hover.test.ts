/** Tests for EC emitted by the BMP object-hover resolver. */
import { describe, it, expect } from 'vitest';
import { buildHoverResolveEc } from '../handlers/objects';

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
