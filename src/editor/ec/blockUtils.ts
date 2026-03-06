/**
 * Shared block-scanning utilities for IF/ENDIF depth counting.
 * Used by foldRegions (folding) and blockMatching (highlighting).
 */
import type { Text } from '@codemirror/state'

interface BlockMatch {
  ifLine: number       // 1-based line number
  elseLine?: number    // 1-based, may be absent
  endifLine: number    // 1-based
}

/** Scan forward from a line containing IF to find matching ENDIF and optional ELSE. */
export function findBlockForward(doc: Text, fromLine: number): BlockMatch | null {
  let depth = 0
  let elseLine: number | undefined
  const total = doc.lines

  for (let i = fromLine; i <= total; i++) {
    const text = doc.line(i).text.trim()
    if (text.startsWith('//')) continue

    const ifCount = (text.match(/\bIF\b/gi) || []).length
    const endifCount = (text.match(/\bENDIF\b/gi) || []).length

    if (i === fromLine) {
      depth += ifCount - endifCount
      if (depth <= 0) return null
      continue
    }

    // Check for ELSE at our depth level (depth=1) before adjusting
    if (depth === 1 && /\bELSE\b/i.test(text) && !/\bIF\b/i.test(text)) {
      elseLine = i
    }

    depth += ifCount - endifCount
    if (depth <= 0) {
      return { ifLine: fromLine, elseLine, endifLine: i }
    }
  }
  return null
}

/** Scan backward from a line containing ENDIF to find matching IF. */
export function findBlockBackward(doc: Text, fromLine: number): BlockMatch | null {
  let depth = 0
  let elseLine: number | undefined

  for (let i = fromLine; i >= 1; i--) {
    const text = doc.line(i).text.trim()
    if (text.startsWith('//')) continue

    const ifCount = (text.match(/\bIF\b/gi) || []).length
    const endifCount = (text.match(/\bENDIF\b/gi) || []).length

    if (i === fromLine) {
      depth += endifCount - ifCount
      if (depth <= 0) return null
      continue
    }

    // Check for ELSE at our depth level before adjusting
    if (depth === 1 && /\bELSE\b/i.test(text) && !/\bIF\b/i.test(text)) {
      elseLine = i
    }

    depth += endifCount - ifCount
    if (depth <= 0) {
      return { ifLine: i, elseLine, endifLine: fromLine }
    }
  }
  return null
}

/** From an ELSE line, find the enclosing IF and ENDIF. */
export function findBlockFromElse(doc: Text, elseLine: number): BlockMatch | null {
  // Scan backward to find IF
  let depth = 1
  let ifLine: number | undefined

  for (let i = elseLine - 1; i >= 1; i--) {
    const text = doc.line(i).text.trim()
    if (text.startsWith('//')) continue
    const ifCount = (text.match(/\bIF\b/gi) || []).length
    const endifCount = (text.match(/\bENDIF\b/gi) || []).length
    depth += endifCount - ifCount
    if (depth <= 0) { ifLine = i; break }
  }
  if (!ifLine) return null

  // Forward from IF to get the full block (including ENDIF)
  const match = findBlockForward(doc, ifLine)
  if (!match) return null

  return { ifLine, elseLine, endifLine: match.endifLine }
}

/**
 * Find the end of a forEach block by counting parentheses.
 * Returns the line number containing the matching `)`, or null.
 */
export function findForEachEnd(doc: Text, fromLine: number): number | null {
  let depth = 0
  const total = doc.lines

  for (let i = fromLine; i <= total; i++) {
    const text = doc.line(i).text
    for (const ch of text) {
      if (ch === '(') depth++
      else if (ch === ')') {
        depth--
        if (depth <= 0) return i
      }
    }
  }
  return null
}
