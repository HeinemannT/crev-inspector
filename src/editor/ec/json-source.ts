import type { JsonShapeStep } from '../../lib/json-shape'
import { parseSafeJsonReadExpression } from '../../lib/json-read-expression'

export type JsonRoot =
  | { kind: 'literal'; text: string }
  | { kind: 'runtime'; expression: string }

export interface JsonLocator {
  root: JsonRoot
  steps: JsonShapeStep[]
}

export type JsonSourceResult =
  | { ok: true; locator: JsonLocator }
  | { ok: false; reason: string }

const IDENT_RE = /^[A-Za-z_]\w*$/

/** Decode one EC string literal. Unknown escapes remain escaped so JSON.parse
 * can decide whether they are valid JSON rather than this helper corrupting
 * them. Both physical newlines and EC's \N newline spelling are supported. */
export function decodeEcStringLiteral(source: string): string | null {
  const text = source.trim()
  const quote = text[0]
  if ((quote !== '"' && quote !== "'") || text[text.length - 1] !== quote) return null
  let out = ''
  for (let i = 1; i < text.length - 1; i++) {
    const c = text[i]
    if (c !== '\\') {
      if (c === quote) return null
      out += c
      continue
    }
    if (i + 1 >= text.length - 1) return null
    const next = text[++i]
    switch (next) {
      case 'n':
      case 'N': out += '\n'; break
      case 'r': out += '\r'; break
      case 't': out += '\t'; break
      case '\\': out += '\\'; break
      case '"': out += '"'; break
      case "'": out += "'"; break
      default: out += `\\${next}`
    }
  }
  return out
}

/** Extract the sole argument from a JSON(...) call with balanced, quote-aware
 * scanning. This intentionally accepts physical line breaks. */
export function jsonCallArgument(expression: string): string | null {
  const text = expression.trim()
  const call = /^JSON\s*\(/.exec(text)
  if (!call) return null
  const open = text.indexOf('(', call.index)
  let depth = 1
  let quote: string | null = null
  let escaped = false
  for (let i = open + 1; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      continue
    }
    if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth === 0) {
        if (text.slice(i + 1).trim() !== '') return null
        return text.slice(open + 1, i).trim()
      }
    }
  }
  return null
}

function rootFromArgument(
  argument: string,
  rhsByVariable: ReadonlyMap<string, string>,
  seen = new Set<string>(),
): JsonRoot | null {
  const literal = decodeEcStringLiteral(argument)
  if (literal !== null) return { kind: 'literal', text: literal }

  const safe = parseSafeJsonReadExpression(argument)
  if (safe) return { kind: 'runtime', expression: safe.normalized }

  if (!IDENT_RE.test(argument) || seen.has(argument) || seen.size >= 12) return null
  const rhs = rhsByVariable.get(argument)
  if (!rhs) return null
  seen.add(argument)
  return rootFromArgument(rhs.trim(), rhsByVariable, seen)
}

export function resolveJsonCall(
  expression: string,
  rhsByVariable: ReadonlyMap<string, string>,
  locatorForVariable?: (name: string) => JsonLocator | undefined,
): JsonSourceResult {
  const argument = jsonCallArgument(expression)
  if (argument === null) return { ok: false, reason: 'JSON(): incomplete or unsupported argument' }
  const root = rootFromArgument(argument, rhsByVariable)
  if (!root && locatorForVariable) {
    const strCall = /^str\s*\(([\s\S]+)\)$/.exec(argument)
    const derived = strCall ? resolveJsonChain(strCall[1], locatorForVariable) : null
    if (derived) return { ok: true, locator: derived }
  }
  if (!root) return { ok: false, reason: 'JSON(): source is dynamic and will not be read automatically' }
  return { ok: true, locator: { root, steps: [] } }
}

interface ChainSegment {
  name: string
  call: boolean
}

function parseChain(expression: string): { root: string; segments: ChainSegment[] } | null {
  const text = expression.trim()
  const rootMatch = /^([A-Za-z_]\w*)/.exec(text)
  if (!rootMatch) return null
  let i = rootMatch[0].length
  const segments: ChainSegment[] = []
  while (i < text.length) {
    while (i < text.length && /\s/.test(text[i])) i++
    if (text[i] !== '.') return null
    i++
    while (i < text.length && /\s/.test(text[i])) i++
    const member = /^[A-Za-z_]\w*/.exec(text.slice(i))
    if (!member) return null
    i += member[0].length
    while (i < text.length && /\s/.test(text[i])) i++
    if (text[i] !== '(') {
      segments.push({ name: member[0], call: false })
      continue
    }
    let depth = 1
    let quote: string | null = null
    let escaped = false
    i++
    for (; i < text.length && depth > 0; i++) {
      const c = text[i]
      if (quote) {
        if (escaped) escaped = false
        else if (c === '\\') escaped = true
        else if (c === quote) quote = null
      } else if (c === '"' || c === "'") quote = c
      else if (c === '(') depth++
      else if (c === ')') depth--
    }
    if (depth !== 0) return null
    segments.push({ name: member[0], call: true })
  }
  return { root: rootMatch[1], segments }
}

const PRESERVE = new Set(['filter', 'sort', 'sortreverse', 'reverse', 'distinct'])
const ELEMENT = new Set(['first', 'last', 'item'])

/** Resolve property and collection chains rooted in an already-known JSON
 * variable. Calls outside the small shape-preserving vocabulary fail closed. */
export function resolveJsonChain(
  expression: string,
  locatorForVariable: (name: string) => JsonLocator | undefined,
): JsonLocator | null {
  const chain = parseChain(expression)
  if (!chain) return null
  const base = locatorForVariable(chain.root)
  if (!base) return null
  const steps = [...base.steps]
  for (const segment of chain.segments) {
    if (!segment.call) {
      steps.push({ kind: 'property', key: segment.name })
      continue
    }
    const method = segment.name.toLowerCase()
    if (PRESERVE.has(method)) continue
    if (ELEMENT.has(method)) {
      steps.push({ kind: 'element' })
      continue
    }
    return null
  }
  return { root: base.root, steps }
}

/** True when a multiline assignment RHS has closed every quote and paren. */
export function isCompleteExpression(expression: string): boolean {
  let depth = 0
  let quote: string | null = null
  let escaped = false
  for (const c of expression) {
    if (quote) {
      if (escaped) escaped = false
      else if (c === '\\') escaped = true
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c === '(') depth++
    else if (c === ')') depth--
  }
  return quote === null && depth <= 0
}
