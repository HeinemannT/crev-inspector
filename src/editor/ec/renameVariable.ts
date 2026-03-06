/**
 * Variable rename (F2) and select-next-occurrence (Ctrl+D) commands.
 */
import { EditorView } from '@codemirror/view'
import { EditorSelection } from '@codemirror/state'
import type { EditorState } from '@codemirror/state'

function wordAt(state: EditorState, pos: number): { from: number; to: number; text: string } | null {
  const line = state.doc.lineAt(pos)
  const text = line.text
  const offset = pos - line.from

  let start = offset, end = offset
  while (start > 0 && /\w/.test(text[start - 1])) start--
  while (end < text.length && /\w/.test(text[end])) end++

  if (start === end) return null
  return { from: line.from + start, to: line.from + end, text: text.slice(start, end) }
}

function findAllWholeWord(doc: string, word: string): Array<{ from: number; to: number }> {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`\\b${escaped}\\b`, 'g')
  const matches: Array<{ from: number; to: number }> = []
  let m
  while ((m = re.exec(doc)) !== null) {
    matches.push({ from: m.index, to: m.index + m[0].length })
  }
  return matches
}

/**
 * F2 — Select all occurrences of the variable at cursor for multi-cursor rename.
 * Only activates on underscore-prefixed variables (_varName convention).
 */
export function renameAllOccurrences(view: EditorView): boolean {
  const word = wordAt(view.state, view.state.selection.main.head)
  if (!word || !/^_\w+$/.test(word.text)) return false

  const matches = findAllWholeWord(view.state.doc.toString(), word.text)
  if (matches.length === 0) return false

  const ranges = matches.map(m => EditorSelection.range(m.from, m.to))
  view.dispatch({
    selection: EditorSelection.create(ranges, ranges.findIndex(r => r.from === word.from)),
  })
  return true
}

/**
 * Ctrl+D — VS Code-style select-next-occurrence.
 * If no selection, select the word at cursor.
 * If selection exists, find next match and add to multi-selection.
 */
export function selectNextOccurrence(view: EditorView): boolean {
  const { state } = view
  const { main } = state.selection

  // No selection → select word at cursor
  if (main.empty) {
    const word = wordAt(state, main.head)
    if (!word) return false
    view.dispatch({ selection: EditorSelection.single(word.from, word.to) })
    return true
  }

  // Find next occurrence of current selection text
  const text = state.sliceDoc(main.from, main.to)
  const doc = state.doc.toString()
  const escaped = text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`\\b${escaped}\\b`, 'g')

  const existing = state.selection.ranges
  const allMatches: Array<{ from: number; to: number }> = []
  let m
  while ((m = re.exec(doc)) !== null) {
    allMatches.push({ from: m.index, to: m.index + m[0].length })
  }

  // Find first match after current main selection that isn't already selected
  const isSelected = (from: number, to: number) =>
    existing.some(r => r.from === from && r.to === to)

  // Search forward from main.to
  let next = allMatches.find(m => m.from >= main.to && !isSelected(m.from, m.to))
  // Wrap around
  if (!next) next = allMatches.find(m => !isSelected(m.from, m.to))
  if (!next) return false

  const newRange = EditorSelection.range(next.from, next.to)
  view.dispatch({
    selection: EditorSelection.create([...existing, newRange], existing.length),
  })
  return true
}
