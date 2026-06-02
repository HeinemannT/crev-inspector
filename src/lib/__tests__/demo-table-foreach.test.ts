/**
 * Regression test for the `demo_table` hierarchical-table build.
 *
 * demo_table (live BMP) uses lowercase `_mit.foreach(...)`. BMP's runtime
 * dispatches methods case-insensitively, so the script builds a correct
 * 90-row hierarchical table on the server. The extension's tokeniser used
 * to match dot-members case-SENSITIVELY (`forEach` only), so `.foreach`
 * fell through unhighlighted and the lint colon-check never fired.
 *
 * This pins the fix: the shipped lightweight highlighter classifies the
 * real demo_table source correctly, regardless of method casing.
 */
import { describe, it, expect } from 'vitest';
import { tokenizeEcLine } from '../ec-format';
import type { TokKind } from '../ec-grammar';

/** Find the kind assigned to `member` where it appears after a dot. */
function memberKind(line: string, member: string): TokKind | null {
  const idx = line.indexOf('.' + member) + 1;
  const tok = tokenizeEcLine(line).find((t) => t.start === idx && t.end === idx + member.length);
  return tok ? tok.kind : null;
}

describe('demo_table foreach build — case-insensitive dispatch', () => {
  const FOREACH_LINE = '_mit.foreach(m:';
  const ROW_LINE = '     _table.addRow(m.mitigated_risk, "","", name, id).indent(1)';

  it('lowercase .foreach classifies as a read-method', () => {
    expect(memberKind(FOREACH_LINE, 'foreach')).toBe('read');
  });

  it('canonical .forEach still classifies as a read-method', () => {
    expect(memberKind('_mit.forEach(m:', 'forEach')).toBe('read');
  });

  it('table-builder members keep their tbl kind', () => {
    expect(memberKind(ROW_LINE, 'addRow')).toBe('tbl');
    expect(memberKind(ROW_LINE, 'indent')).toBe('tbl');
  });

  it('upper / mixed casings all dispatch the same', () => {
    expect(memberKind('_l.FOREACH(x:', 'FOREACH')).toBe('read');
    expect(memberKind('_l.ForEach(x:', 'ForEach')).toBe('read');
    expect(memberKind('_t.ADDROW(x)', 'ADDROW')).toBe('tbl');
  });
});
