/**
 * IF/ELSE/ENDIF block matching — highlights paired keywords
 * when the cursor rests on any block keyword.
 */
import {
  ViewPlugin,
  Decoration,
  type DecorationSet,
  type EditorView,
  type ViewUpdate,
} from '@codemirror/view'
import { RangeSetBuilder } from '@codemirror/state'
import { findBlockForward, findBlockBackward, findBlockFromElse } from './blockUtils'

const matchMark = Decoration.mark({ class: 'cm-ec-block-match' })

function addKeywordRange(
  doc: ReturnType<typeof import('@codemirror/state').Text.prototype.line>,
  keyword: string,
  ranges: Array<{ from: number; to: number }>,
) {
  const idx = doc.text.search(new RegExp(`\\b${keyword}\\b`, 'i'))
  if (idx >= 0) ranges.push({ from: doc.from + idx, to: doc.from + idx + keyword.length })
}

function getBlockDecorations(view: EditorView): DecorationSet {
  const { state } = view
  const pos = state.selection.main.head
  const line = state.doc.lineAt(pos)
  const text = line.text

  // Find word at cursor position
  const offset = pos - line.from
  let start = offset, end = offset
  while (start > 0 && /\w/.test(text[start - 1])) start--
  while (end < text.length && /\w/.test(text[end])) end++
  const word = text.slice(start, end).toUpperCase()

  if (word !== 'IF' && word !== 'ELSE' && word !== 'ENDIF') {
    return Decoration.none
  }

  const ranges: Array<{ from: number; to: number }> = []

  if (word === 'IF') {
    const match = findBlockForward(state.doc, line.number)
    if (match) {
      ranges.push({ from: line.from + start, to: line.from + end })
      if (match.elseLine) addKeywordRange(state.doc.line(match.elseLine), 'ELSE', ranges)
      addKeywordRange(state.doc.line(match.endifLine), 'ENDIF', ranges)
    }
  } else if (word === 'ENDIF') {
    const match = findBlockBackward(state.doc, line.number)
    if (match) {
      addKeywordRange(state.doc.line(match.ifLine), 'IF', ranges)
      if (match.elseLine) addKeywordRange(state.doc.line(match.elseLine), 'ELSE', ranges)
      ranges.push({ from: line.from + start, to: line.from + end })
    }
  } else if (word === 'ELSE') {
    const match = findBlockFromElse(state.doc, line.number)
    if (match) {
      addKeywordRange(state.doc.line(match.ifLine), 'IF', ranges)
      ranges.push({ from: line.from + start, to: line.from + end })
      addKeywordRange(state.doc.line(match.endifLine), 'ENDIF', ranges)
    }
  }

  // Build decoration set (must be in document order)
  ranges.sort((a, b) => a.from - b.from)
  const builder = new RangeSetBuilder<Decoration>()
  for (const r of ranges) builder.add(r.from, r.to, matchMark)
  return builder.finish()
}

export const ecBlockMatching = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = getBlockDecorations(view)
    }
    update(update: ViewUpdate) {
      if (update.selectionSet || update.docChanged) {
        this.decorations = getBlockDecorations(update.view)
      }
    }
  },
  { decorations: (v) => v.decorations },
)
