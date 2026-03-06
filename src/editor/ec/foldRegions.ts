/**
 * Code folding for Extended Code blocks.
 * Supports IF/THEN...ENDIF and forEach(...:...) blocks.
 */
import { foldService } from '@codemirror/language'
import { findBlockForward, findForEachEnd } from './blockUtils'

export const ecFoldService = foldService.of((state, lineStart) => {
  const line = state.doc.lineAt(lineStart)
  const text = line.text.trim()

  // Skip comments
  if (text.startsWith('//')) return null

  // IF ... THEN → fold to matching ENDIF
  if (/\bIF\b/i.test(text) && /\bTHEN\b/i.test(text)) {
    const match = findBlockForward(state.doc, line.number)
    if (match) {
      const endifLine = state.doc.line(match.endifLine)
      return { from: line.to, to: endifLine.from - 1 }
    }
  }

  // forEach( ... : → fold to matching )
  if (/\.forEach\s*\(/.test(text) && text.endsWith(':')) {
    const endLine = findForEachEnd(state.doc, line.number)
    if (endLine && endLine > line.number) {
      const closeLine = state.doc.line(endLine)
      return { from: line.to, to: closeLine.from - 1 }
    }
  }

  return null
})
