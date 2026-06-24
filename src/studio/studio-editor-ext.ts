/**
 * CodeMirror extensions specific to the CVO studio's editor: a dependency-free
 * syntax-error linter and the CVO-API autocomplete source. Kept out of
 * studio.ts so the (large) view file isn't also the home of editor config.
 */
import { type CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { linter, type Diagnostic } from '@codemirror/lint'
import { syntaxTree } from '@codemirror/language'
import { cvoApiCandidates } from './cvo-api'

/** Dep-free syntax linter: surfaces the language grammar's error nodes as inline
 *  diagnostics. A blank/broken CVO is usually a syntax slip, so flagging parse
 *  errors as you type beats discovering them via a silent blank widget. */
export const syntaxErrorLinter = linter(view => {
  const diagnostics: Diagnostic[] = []
  const len = view.state.doc.length
  syntaxTree(view.state).cursor().iterate(node => {
    if (!node.type.isError) return
    const from = Math.min(node.from, len)
    const to = node.to > node.from ? Math.min(node.to, len) : Math.min(node.from + 1, len)
    diagnostics.push({ from, to, severity: 'error', message: 'Syntax error' })
    if (diagnostics.length > 100) return false // cap on a badly-broken doc
  })
  return diagnostics
})

/** Build a CompletionSource offering the CVO API: `_data.*` members and, under
 *  `_data.expressions.`, the live child keys. Keys are read lazily via the
 *  getter so completions reflect the current children without rebuilding the
 *  editor. */
export function makeCvoApiSource(getExpressionKeys: () => string[]) {
  return function cvoApiSource(context: CompletionContext): CompletionResult | null {
    const line = context.state.doc.lineAt(context.pos)
    const before = line.text.slice(0, context.pos - line.from)
    const cand = cvoApiCandidates(before, { expressions: getExpressionKeys(), tables: [] })
    if (!cand) return null
    const options = cand.options
      .filter(o => o.startsWith(cand.word))
      .map(label => ({ label, type: 'property' }))
    if (options.length === 0) return null
    return { from: context.pos - cand.word.length, options, validFor: /\w*/ }
  }
}
