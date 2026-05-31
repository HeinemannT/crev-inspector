/**
 * Selection wrap helpers for Extended Code.
 * Ctrl+Shift+X → wrap in IF/THEN/ELSE/ENDIF
 * Ctrl+Shift+E → wrap in forEach
 *
 * Both read the editor's configured indent unit (set to 5 spaces in
 * editor.ts to match BMP Config Studio convention) so wrapped lines
 * align with the surrounding auto-indent. Hardcoding `'  '` here used
 * to ship 2-space indents that mismatched the rest of the file.
 */
import { EditorView } from '@codemirror/view'
import { indentString, getIndentUnit } from '@codemirror/language'

/** One indent's worth of whitespace under the editor's current config. */
function oneIndent(view: EditorView): string {
  return indentString(view.state, getIndentUnit(view.state))
}

/** Wrap selected text in an IF/THEN/ELSE/ENDIF block. Cursor placed at "condition". */
export function wrapInIf(view: EditorView): boolean {
  const { from, to } = view.state.selection.main
  if (from === to) return false

  const indent = oneIndent(view)
  const selected = view.state.doc.sliceString(from, to)
  const lines = selected.split('\n')
  const indented = lines.map(l => indent + l).join('\n')
  const wrapped = `IF condition THEN\n${indented}\nELSE\n${indent}\nENDIF`

  view.dispatch({
    changes: { from, to, insert: wrapped },
    // Select "condition" so user can type the real condition
    selection: { anchor: from + 3, head: from + 12 },
  })
  return true
}

/** Wrap selected text in a forEach block. Cursor placed at "list". */
export function wrapInForEach(view: EditorView): boolean {
  const { from, to } = view.state.selection.main
  if (from === to) return false

  const indent = oneIndent(view)
  const selected = view.state.doc.sliceString(from, to)
  const lines = selected.split('\n')
  const indented = lines.map(l => indent + l).join('\n')
  const wrapped = `list.forEach(_item:\n${indented}\n)`

  view.dispatch({
    changes: { from, to, insert: wrapped },
    // Select "list" so user can type the real list reference
    selection: { anchor: from, head: from + 4 },
  })
  return true
}
