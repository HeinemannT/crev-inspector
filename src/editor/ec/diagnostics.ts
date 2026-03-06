/**
 * Extended Code lint diagnostics:
 * 1. IF/ENDIF balance
 * 2. forEach colon missing
 * 3. Unclosed string literal
 * 4. Transactional hint (use Execute not Preview)
 */
import { linter, Diagnostic } from '@codemirror/lint'
import { EditorView } from '@codemirror/view'

const FOREACH_RE = /\.forEach\s*\(/
const TRANSACTIONAL_RE = /\.(delete|add|update|change|move|copy|unlink|link)\s*\(/

export const extendedLinter = linter((view: EditorView): Diagnostic[] => {
  const text = view.state.doc.toString()
  const lines = text.split('\n')
  const diags: Diagnostic[] = []

  let ifDepth = 0
  let lineFrom = 0

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const trimmed = raw.trim()
    const lineTo = lineFrom + raw.length

    // Skip full-line comments
    if (!trimmed.startsWith('//')) {
      // IF/ENDIF balance
      const ifCount = (raw.match(/\bIF\b/g) || []).length
      const endifCount = (raw.match(/\bENDIF\b/g) || []).length
      // Subtract ENDIF from count of IF on same line to handle same-line IF ENDIF
      ifDepth += ifCount - endifCount
      if (ifDepth < 0) {
        // Extra ENDIF
        const col = raw.indexOf('ENDIF')
        diags.push({
          from: lineFrom + (col >= 0 ? col : 0),
          to: lineFrom + (col >= 0 ? col + 5 : raw.length),
          severity: 'error',
          message: 'ENDIF without matching IF',
        })
        ifDepth = 0
      }

      // forEach colon check — detect .forEach( and verify colon after iterator variable
      const foreachMatch = raw.match(FOREACH_RE)
      if (foreachMatch) {
        const afterParen = raw.slice(raw.indexOf('(', foreachMatch.index!) + 1)
        // If line has the opening ( but argument part has no colon, warn
        if (!afterParen.includes(':') && !afterParen.trimEnd().endsWith(')')) {
          diags.push({
            from: lineFrom,
            to: lineTo,
            severity: 'warning',
            message: 'forEach body requires ":" after iterator variable',
          })
        }
      }

      // Unclosed string (simple heuristic — uneven count of non-escaped quotes)
      const stripped = raw.replace(/\/\/.*$/, '') // strip inline comments
      const singleCount = (stripped.match(/(?<!\\)'/g) || []).length
      const doubleCount = (stripped.match(/(?<!\\)"/g) || []).length
      if (singleCount % 2 !== 0 || doubleCount % 2 !== 0) {
        diags.push({
          from: lineFrom,
          to: lineTo,
          severity: 'error',
          message: 'Unclosed string literal',
        })
      }
    }

    lineFrom = lineTo + 1 // +1 for newline
  }

  // IF without ENDIF (end of document)
  if (ifDepth > 0) {
    const lastLine = view.state.doc.line(view.state.doc.lines)
    diags.push({
      from: lastLine.from,
      to: lastLine.to,
      severity: 'error',
      message: `${ifDepth} IF block${ifDepth > 1 ? 's' : ''} not closed with ENDIF`,
    })
  }

  // Transactional hint — info only
  const transMatch = TRANSACTIONAL_RE.exec(text)
  if (transMatch) {
    diags.push({
      from: text.indexOf(transMatch[0]),
      to: text.indexOf(transMatch[0]) + transMatch[0].length,
      severity: 'info',
      message: 'Script contains transactional operations — use Execute (not Preview) to commit changes.',
    })
  }

  return diags
})

