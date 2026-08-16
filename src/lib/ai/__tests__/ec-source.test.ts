import { describe, expect, it } from 'vitest';
import { extractDeferredExpressionSource, hasDeferredExpressionAssignment, hasStateChangingEc } from '../ec-source';

describe('hasStateChangingEc', () => {
  it('recognises change methods and direct dotted-property assignment', () => {
    expect(hasStateChangingEc('t.qa_table.change(name := "Open")')).toBe(true);
    expect(hasStateChangingEc('t.qa_table.card := t.compact_card')).toBe(true);
  });

  it('ignores mutation-looking comments and strings', () => {
    expect(hasStateChangingEc('-- t.qa_table.change(name := "Open")\noutput("done")')).toBe(false);
    expect(hasStateChangingEc('output("t.qa_table.change(name := value)")')).toBe(false);
  });

  it('does not classify table expressions as state changes', () => {
    expect(hasStateChangingEc('t.Risk.table(name, code)')).toBe(false);
  });
});

describe('extractDeferredExpressionSource', () => {
  it('detects the assignment from executable ticket code rather than request wording', () => {
    expect(hasDeferredExpressionAssignment(`t.table.change(expression := 't.Risk.table(name)')`)).toBe(true);
    expect(hasDeferredExpressionAssignment(`-- expression := 'fake'\nt.dashboard.change(name := 'Summary')`)).toBe(false);
  });

  it('extracts one literal and concatenated newline literals', () => {
    expect(extractDeferredExpressionSource(
      `t.table.change(expression := 'root.CeRisk.children.table(id, name)')`,
    )).toBe('root.CeRisk.children.table(id, name)');
    expect(extractDeferredExpressionSource([
      `_table := _page.add(ExtendedTable,`,
      `  expression := 'x := createtable("ID", "Name")' + "\\n" +`,
      `       '_rows.forEach(_r: x.addRow(_r.id, _r.name))' + "\\n" + 'x',`,
      `  name := 'Summary')`,
    ].join('\n'))).toBe([
      'x := createtable("ID", "Name")',
      '_rows.forEach(_r: x.addRow(_r.id, _r.name))',
      'x',
    ].join('\n'));
  });

  it('rejects dynamic, commented, and malformed expression assignments', () => {
    expect(extractDeferredExpressionSource(`t.table.change(expression := _source)`)).toBeNull();
    expect(extractDeferredExpressionSource(`// expression := 'fake'\nt.table.change(name := 'x')`)).toBeNull();
    expect(extractDeferredExpressionSource(`t.table.change(expression := 'unterminated)`)).toBeNull();
  });
});
