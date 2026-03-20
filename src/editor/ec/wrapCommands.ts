/**
 * Selection wrap helpers for Extended Code.
 * Ctrl+Shift+X → wrap in IF/THEN/ELSE/ENDIF
 * Ctrl+Shift+E → wrap in forEach
 */
import { EditorView } from '@codemirror/view'

/** Wrap selected text in an IF/THEN/ELSE/ENDIF block. Cursor placed at "condition". */
export function wrapInIf(view: EditorView): boolean {
  const { from, to } = view.state.selection.main
  if (from === to) return false

  const selected = view.state.doc.sliceString(from, to)
  const lines = selected.split('\n')
  const indented = lines.map(l => '  ' + l).join('\n')
  const wrapped = `IF condition THEN\n${indented}\nELSE\n  \nENDIF`

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

  const selected = view.state.doc.sliceString(from, to)
  const lines = selected.split('\n')
  const indented = lines.map(l => '  ' + l).join('\n')
  const wrapped = `list.forEach(_item:\n${indented}\n)`

  view.dispatch({
    changes: { from, to, insert: wrapped },
    // Select "list" so user can type the real list reference
    selection: { anchor: from, head: from + 4 },
  })
  return true
}
