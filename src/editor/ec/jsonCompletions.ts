import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import { getInference } from './typeInference'
import { resolveJsonChain, type JsonLocator } from './json-source'
import { jsonShapeLabel } from '../../lib/json-shape'
import { jsonShapeStore } from './json-shape-store'

let executionContextRid: string | undefined

export function setJsonCompletionContext(objectRid: string | undefined): void {
  executionContextRid = objectRid
  jsonShapeStore.clear()
}

function memberContext(context: CompletionContext): { locator: JsonLocator; from: number } | null {
  const line = context.state.doc.lineAt(context.pos)
  const before = context.state.doc.sliceString(line.from, context.pos)
  const match = /([A-Za-z_]\w*(?:\s*\.\s*[A-Za-z_]\w*(?:\([^()]*(?:\([^()]*\)[^()]*)*\))?)*)\s*\.\s*([A-Za-z_]\w*)?$/.exec(before)
  if (!match) return null
  const expression = match[1]
  const partial = match[2] ?? ''
  const locator = resolveJsonChain(expression, name => {
    const inference = getInference(name)
    return inference?.kind === 'json' ? inference.locator : undefined
  })
  return locator ? { locator, from: context.pos - partial.length } : null
}

function result(locator: JsonLocator, from: number): CompletionResult | null {
  const state = jsonShapeStore.peek(locator, executionContextRid)
  if (state.status !== 'ready' || state.shape.kind !== 'object') return null
  return {
    from,
    options: state.shape.fields
      .filter(field => /^[A-Za-z_]\w*$/.test(field.key))
      .map(field => ({
        label: field.key,
        detail: `${jsonShapeLabel(field.shape)}${field.optional ? '?' : ''}`,
        type: field.shape.kind === 'object' ? 'property' : 'variable',
        boost: 2,
      })),
    validFor: /^[\w]*$/,
  }
}

export function jsonCompletions(context: CompletionContext): CompletionResult | Promise<CompletionResult | null> | null {
  const member = memberContext(context)
  if (!member) return null
  const ready = result(member.locator, member.from)
  if (ready) return ready

  return new Promise(resolve => {
    let settled = false
    const finish = (value: CompletionResult | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => finish(null), 2_000)
    void jsonShapeStore.load(member.locator, executionContextRid)
      .then(() => finish(context.aborted ? null : result(member.locator, member.from)))
      .catch(() => finish(null))
  })
}
