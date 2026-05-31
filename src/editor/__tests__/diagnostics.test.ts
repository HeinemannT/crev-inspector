/**
 * Tests for the pure helpers used by the EC linter — currently
 * `findBareIfAfterOp`. The CodeMirror `extendedLinter` itself is
 * dispatch + bookkeeping over these helpers and is tested by its
 * users in vivo.
 */
import { describe, it, expect } from 'vitest';
import { findBareIfAfterOp } from '../ec/diagnostics';

describe('findBareIfAfterOp', () => {
  it('flags bare IF after :=', () => {
    const hits = findBareIfAfterOp('_x := IF _a THEN _b ELSE _c ENDIF');
    expect(hits).toHaveLength(1);
    expect(hits[0].op).toBe(':=');
  });

  it('flags bare IF after +', () => {
    const hits = findBareIfAfterOp('_r := _r + IF _a THEN _b ELSE _c ENDIF');
    // _r := _r is fine (`:=` is followed by `_r`, not IF)
    // _r + IF triggers
    expect(hits).toHaveLength(1);
    expect(hits[0].op).toBe('+');
  });

  it('accepts parenthesised inline IF after :=', () => {
    expect(findBareIfAfterOp('_x := (IF _a THEN _b ELSE _c ENDIF)')).toHaveLength(0);
  });

  it('accepts parenthesised inline IF after +', () => {
    expect(findBareIfAfterOp('_r := _r + (IF _a THEN _b ELSE _c ENDIF)')).toHaveLength(0);
  });

  it('accepts top-level statement-form IF (no operator precedes)', () => {
    expect(findBareIfAfterOp('IF _t = MISSING THEN _t := _o.template ENDIF')).toHaveLength(0);
    expect(findBareIfAfterOp('     IF _hit THEN _r := _r + _rid ENDIF')).toHaveLength(0);
  });

  it('does not flag IF inside a string literal', () => {
    expect(findBareIfAfterOp('_msg := "_x := IF dont flag this"')).toHaveLength(0);
    expect(findBareIfAfterOp("_msg := '_r + IF this is just text'")).toHaveLength(0);
  });

  it('does not flag IF inside a // comment', () => {
    expect(findBareIfAfterOp('_x := 1  // example: := IF was wrong')).toHaveLength(0);
  });

  it('underlines the IF keyword, not the operator', () => {
    const line = '_x := IF cond THEN 1 ELSE 0 ENDIF';
    const hits = findBareIfAfterOp(line);
    expect(hits).toHaveLength(1);
    expect(line.slice(hits[0].ifStart, hits[0].ifEnd)).toBe('IF');
  });

  it('finds multiple bare IFs on one line', () => {
    // Defensive: rare but `_r := _r + IF ... ENDIF + IF ... ENDIF` is doubly wrong
    const line = '_r := _r + IF _a THEN 1 ENDIF + IF _b THEN 2 ENDIF';
    const hits = findBareIfAfterOp(line);
    expect(hits).toHaveLength(2);
  });

  it('handles `+ IF` with multiple spaces', () => {
    expect(findBareIfAfterOp('_r := _r  +    IF _a THEN _b ENDIF')).toHaveLength(1);
  });

  it('does not flag IF that appears mid-identifier', () => {
    // IFFY, MODIFY, etc. — \b word boundary in the regex
    expect(findBareIfAfterOp('_x := IFFY')).toHaveLength(0);
    expect(findBareIfAfterOp('_x := MODIFY')).toHaveLength(0);
  });
});
