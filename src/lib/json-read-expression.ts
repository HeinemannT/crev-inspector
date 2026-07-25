import { ID_SPACE_PREFIXES } from './ec-grammar'

export interface SafeJsonRead {
  normalized: string
}

const isIdentStart = (c: string | undefined): boolean => Boolean(c && /[A-Za-z_]/.test(c))
const isIdent = (c: string | undefined): boolean => Boolean(c && /[A-Za-z0-9_]/.test(c))
const skipSpace = (text: string, start: number): number => {
  let i = start
  while (i < text.length && /\s/.test(text[i])) i++
  return i
}

function readIdentifier(text: string, start: number, allowLeadingDigit = false): { value: string; end: number } | null {
  let i = start
  if (allowLeadingDigit ? !isIdent(text[i]) : !isIdentStart(text[i])) return null
  i++
  while (isIdent(text[i])) i++
  return { value: text.slice(start, i), end: i }
}

function readStringLiteral(text: string, start: number): { raw: string; end: number } | null {
  const quote = text[start]
  if (quote !== '"' && quote !== "'") return null
  let escaped = false
  for (let i = start + 1; i < text.length; i++) {
    const c = text[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (c === '\\') {
      escaped = true
      continue
    }
    if (c === quote) return { raw: text.slice(start, i + 1), end: i + 1 }
  }
  return null
}

/** Parse the deliberately small, read-only EC expression accepted by automatic
 * JSON discovery. Returning a canonical expression lets the UI and service
 * worker share cache keys and, more importantly, the exact same security
 * boundary. */
export function parseSafeJsonReadExpression(source: string): SafeJsonRead | null {
  const text = source.trim()
  let i = 0
  const root = readIdentifier(text, i)
  if (!root) return null
  i = root.end

  const parts: string[] = [root.value]
  const contextual = root.value === 'this' || root.value === 'self'
  if (!contextual && (root.value === 'o' || !ID_SPACE_PREFIXES.has(root.value))) return null

  i = skipSpace(text, i)
  if (text[i] !== '.') return null

  if (!contextual) {
    i = skipSpace(text, i + 1)
    const bid = readIdentifier(text, i, true)
    if (!bid) return null
    parts.push(bid.value)
    i = skipSpace(text, bid.end)
  }

  let propertyCount = 0
  let wrapperSeen = false
  while (i < text.length) {
    if (text[i] !== '.') return null
    i = skipSpace(text, i + 1)
    const member = readIdentifier(text, i)
    if (!member) return null
    i = skipSpace(text, member.end)
    if (text[i] !== '(') {
      if (wrapperSeen) return null
      parts.push(member.value)
      propertyCount++
      continue
    }

    wrapperSeen = true
    i = skipSpace(text, i + 1)
    if (member.value === 'strip') {
      if (text[i] !== ')') return null
      parts.push('strip()')
      i = skipSpace(text, i + 1)
    } else if (member.value === 'whenMissing') {
      const literal = readStringLiteral(text, i)
      if (!literal) return null
      i = skipSpace(text, literal.end)
      if (text[i] !== ')') return null
      parts.push(`whenMissing(${literal.raw})`)
      i = skipSpace(text, i + 1)
    } else {
      return null
    }
  }
  if (propertyCount < 1) return null
  return { normalized: parts.join('.') }
}
