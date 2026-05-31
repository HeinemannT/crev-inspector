/**
 * Runtime EC error markers. The static linter in `./diagnostics`
 * catches structural problems (IF balance, unclosed strings, …). This
 * one paints the line / column reported by BMP in its EC error message
 * onto the gutter so the user gets a squiggle exactly where execution
 * blew up — same affordance as a compiler error.
 *
 * Pattern: BMP's error text is shaped like
 *   "WARNING: ... at line 5, column 12"
 *   "Error in EC at line 3"
 *   "Missing value for .foo at line 1, column 11"
 * We grab whichever (line, column?) tuple matches.
 */
import { Diagnostic, linter, forceLinting } from '@codemirror/lint'
import { EditorView } from '@codemirror/view'

// Module-level mutable state. A single error at a time — re-running
// preview / execute either replaces it or clears it. Multiple errors
// in one EC blob are rare; we surface the first.
let runtimeErrors: Diagnostic[] = []

/** Linter source — returns whatever's in the module state. Combined
 *  additively with the static linter; both can paint on the same line
 *  without one clobbering the other. */
export const runtimeErrorLinter = linter(() => runtimeErrors)

/** Parse a BMP EC error message for line + column. Returns null when
 *  nothing matches — the caller falls back to a generic "no location"
 *  display in the output panel only. */
export function parseEcErrorLocation(message: string): { line: number; column?: number } | null {
  // "line 12, column 4" or "line 12"
  const m = /\bline\s+(\d+)(?:\s*,\s*column\s+(\d+))?/i.exec(message)
  if (!m) return null
  return { line: parseInt(m[1], 10), column: m[2] ? parseInt(m[2], 10) : undefined }
}

/** Set the runtime-error marker and re-trigger the linter so the
 *  squiggle appears immediately (no need to wait for a doc edit). */
export function setRuntimeError(view: EditorView, line: number, column: number | undefined, message: string): void {
  const doc = view.state.doc
  const safeLine = Math.max(1, Math.min(doc.lines, line))
  const lineObj = doc.line(safeLine)
  // 1-based column from BMP; bound to the actual line length to avoid
  // creating ranges that exceed the doc.
  const colSafe = column ? Math.max(0, Math.min(lineObj.length, column - 1)) : 0
  const from = lineObj.from + colSafe
  // Highlight to the end of the line if no column, else a single char
  // so the squiggle stays narrow.
  const to = column ? Math.min(lineObj.to, from + 1) : lineObj.to
  runtimeErrors = [{ from, to, severity: 'error', message }]
  forceLinting(view)
  // Scroll the error into view so the user sees it without hunting.
  view.dispatch({ selection: { anchor: from }, scrollIntoView: true })
}

/** Wipe runtime errors. Called after a successful run or when the
 *  user edits the doc (the parser line numbers would no longer match). */
export function clearRuntimeErrors(view: EditorView | null): void {
  if (runtimeErrors.length === 0) return
  runtimeErrors = []
  if (view) forceLinting(view)
}
