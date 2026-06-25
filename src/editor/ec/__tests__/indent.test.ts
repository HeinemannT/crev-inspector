/**
 * EC editor auto-indent (the StreamLanguage `indent` service in language.ts).
 *
 * The editor should reproduce what `ec_format` (Config Studio's formatter)
 * produces: a HANGING indent of one 5-space unit per open `(` or IF/THEN block,
 * NOT alignment to the opening paren. A continuation line inside an unclosed
 * argument list gets one unit; the closing `)` / ENDIF / ELSE line backs up.
 *
 * @vitest-environment happy-dom
 */
import { describe, it, expect } from 'vitest';
import { EditorState } from '@codemirror/state';
import { getIndentation, indentUnit } from '@codemirror/language';
import { extendedLanguage } from '../language';

/** Computed indent (in columns) for a 1-based line of `doc`. */
function indentAt(doc: string, line: number): number | null {
  const state = EditorState.create({
    doc,
    extensions: [extendedLanguage, indentUnit.of('     ')], // 5 spaces, matching the editor
  });
  return getIndentation(state, state.doc.line(line).from);
}

describe('EC auto-indent', () => {
  it('hangs an argument-list continuation by one unit (the reported case)', () => {
    const doc = 'vTable.addRow(property1,\nproperty2,\nproperty3)';
    expect(indentAt(doc, 1)).toBe(0); // the call itself
    expect(indentAt(doc, 2)).toBe(5); // continuation arg -> one unit, NOT aligned to the paren
    expect(indentAt(doc, 3)).toBe(5); // still inside the open paren
  });

  it('backs the closing paren up to the call when it owns its line', () => {
    const doc = 'vTable.addRow(\nproperty1,\nproperty2\n)';
    expect(indentAt(doc, 2)).toBe(5);
    expect(indentAt(doc, 3)).toBe(5);
    expect(indentAt(doc, 4)).toBe(0); // line starts with ) -> dedent
  });

  it('treats a forEach callback body the same as an argument list', () => {
    const doc = 'list.forEach(item:\noutput(item.name)\n)';
    expect(indentAt(doc, 2)).toBe(5);
    expect(indentAt(doc, 3)).toBe(0);
  });

  it('indents IF/THEN bodies and dedents ENDIF / ELSE', () => {
    const doc = 'IF x > 0 THEN\noutput("yes")\nELSE\noutput("no")\nENDIF';
    expect(indentAt(doc, 2)).toBe(5);
    expect(indentAt(doc, 3)).toBe(0); // ELSE backs up
    expect(indentAt(doc, 4)).toBe(5);
    expect(indentAt(doc, 5)).toBe(0); // ENDIF backs up
  });

  it('stacks nested open parens (one unit each)', () => {
    const doc = 'foo(bar(a,\nb))';
    expect(indentAt(doc, 2)).toBe(10); // inside two open parens
  });

  it('does not count parens inside strings', () => {
    const doc = 'output("a ( b")\nx := 1';
    expect(indentAt(doc, 2)).toBe(0); // the ( in the string must not open a level
  });
});
