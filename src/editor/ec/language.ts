/**
 * CodeMirror 6 StreamParser for Extended Code syntax highlighting.
 *
 * Token type strings returned by token() are mapped to highlight tags
 * via `tokenTable` (for custom types) or the built-in CM6 defaults
 * (for standard names like "keyword", "comment", "string", "number",
 * "operator"). The colour palette is defined in `./highlight.ts`.
 *
 * The grammar (keyword sets, ID-space prefixes, regex helpers,
 * classifier functions) lives in `src/lib/ec-grammar.ts` and is shared
 * with the lightweight inline tokeniser in `src/lib/ec-format.ts`.
 * Adding a new EC keyword is a one-file edit there, not a two-file
 * sync-up here.
 */
import { StreamLanguage, type IndentContext } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import {
  CONTROL_KEYWORDS,
  CONTEXT_KEYWORDS,
  BOOL_VALUES,
  NULL_VALUES,
  STYLE_CONSTANTS,
  DATE_CONSTANTS,
  GLOBAL_FUNCS,
  AGGREGATE_FUNCS,
  TRANSACTIONAL_METHODS,
  TABLE_METHODS,
  READ_METHODS,
  KNOWN_PROPERTIES,
  ID_SPACE_PREFIXES,
  CLASS_INTRO_METHODS,
  IDENT_RE_STREAM,
  PASCAL_RE,
  CAMEL_RE,
} from '../../lib/ec-grammar'

type State = {
  inString: '"' | "'" | null
  inBlockComment: boolean
  /** Track nesting depth for indentation: THEN increments, ENDIF decrements. */
  blockDepth: number
  /** forEach/callback colon depth: `:` increments, `)` when > 0 decrements. */
  callbackDepth: number
  /** Single-token lookbehind: when the previous emitted token introduces
   *  a class reference (SELECT keyword, or .add/.children/.descendants/
   *  .ancestor method), the NEXT identifier is highlighted as a class
   *  name. Cleared after the next identifier consumption.
   *
   *  Both PascalCase (`SELECT CeRiskAssessment`) and lowerCamel
   *  (`SELECT ceRiskAssessment`) are accepted — BMP's runtime normalises
   *  the case at dispatch and our inference layer canonicalises the
   *  same way, so the highlight should agree. */
  classContext: boolean
}

// IDENT_RE_STREAM (un-anchored, stream-friendly) + CLASS_INTRO_METHODS
// are both imported from `../../lib/ec-grammar` — the same data is
// shared with the lightweight tokeniser in `src/lib/ec-format.ts`.

export const extendedLanguage = StreamLanguage.define<State>({
  startState: () => ({
    inString: null,
    inBlockComment: false,
    blockDepth: 0,
    callbackDepth: 0,
    classContext: false,
  }),

  copyState: (state) => ({ ...state }),

  token(stream, state) {
    // Block comment continuation across lines
    if (state.inBlockComment) {
      if (stream.match(/.*?\*\//)) {
        state.inBlockComment = false
      } else {
        stream.skipToEnd()
      }
      return 'comment'
    }

    // String continuation across lines (rare in EC, but safe)
    if (state.inString) {
      const q = state.inString
      while (!stream.eol()) {
        const ch = stream.next()
        if (ch === '\\') {
          stream.next()
        } else if (ch === q) {
          state.inString = null
          break
        }
      }
      return 'string'
    }

    // Whitespace, operators, parens — all pass through without
    // disturbing classContext (`SELECT  CeFoo`, `.children( CeFoo )`
    // both still tag CeFoo as className). Only the identifier branch
    // reads + clears the flag. SELECT (keyword branch) and the
    // class-introducing dot members (.add / .children / .descendants
    // / .ancestor) SET it back to true on their way out.
    if (stream.eatSpace()) return null

    // Single-line comment
    if (stream.match('//')) {
      stream.skipToEnd()
      return 'comment'
    }

    // Block comment
    if (stream.match('/*')) {
      if (!stream.match(/.*?\*\//)) {
        state.inBlockComment = true
        stream.skipToEnd()
      }
      return 'comment'
    }

    // String literals (single or double quoted)
    const qm = stream.peek()
    if (qm === '"' || qm === "'") {
      state.inString = qm
      stream.next()
      while (!stream.eol()) {
        const ch = stream.next()
        if (ch === '\\') {
          stream.next()
        } else if (ch === qm) {
          state.inString = null
          break
        }
      }
      return 'string'
    }

    // Numbers — optional date/duration suffix (1D / 2W / 3M / 1Y / EQ / EH).
    // The suffix is part of the numeric token; CodeMirror has no separate
    // "duration literal" tag, and the lavender number colour reads fine
    // for both forms.
    if (stream.match(/\d+(\.\d+)?[DWMYHTQ]?\b/)) {
      return 'number'
    }

    // Assignment operators — order matters: `:+` and `:=` must precede
    // the single-char branch (otherwise `:` would match alone).
    if (stream.match(':=') || stream.match(':+')) {
      return 'operator'
    }

    // Comparison operators of width 2 — likewise before single-char.
    if (stream.match('!=') || stream.match('<=') || stream.match('>=') || stream.match('<>')) {
      return 'operator'
    }

    // Dot members: `.addColumn`, `.forEach`, `.delete`, `.expression`,
    // `.name` etc. We don't delegate to ec-grammar's
    // `classifyDotMember` here because the editor parser carries
    // extra State (blockDepth, callbackDepth, classContext) that the
    // pure tokeniser doesn't — `.add(T)` extending classContext for
    // the next ident is editor-only state. Folding the dispatch into
    // the classifier would couple ec-grammar to StreamLanguage's
    // State type, breaking the "grammar exports stay pure" guarantee.
    if (stream.peek() === '.') {
      stream.next() // consume the dot
      if (stream.match(IDENT_RE_STREAM)) {
        const name = stream.current().slice(1) // strip leading dot

        // `.expression` is the eval-vs-text gotcha. Tag distinctly so
        // CSS can italicise it as a reminder.
        if (name === 'expression') return 'expr'

        // `.add(T, …)` / `.children(T)` / `.descendants(T)` / `.ancestor(T)`
        // all introduce a class reference as the first argument. Flag
        // it for the next ident regardless of which method category the
        // name belongs to.
        const introducesClass = CLASS_INTRO_METHODS.has(name)
        if (introducesClass) state.classContext = true

        if (TRANSACTIONAL_METHODS.has(name)) return 'transactional'
        if (TABLE_METHODS.has(name)) return 'tableMethod'
        if (READ_METHODS.has(name)) return 'readMethod'
        if (KNOWN_PROPERTIES.has(name)) return 'prop'
        // Unknown dot-access — no highlight, but consumed
      }
      return null
    }

    // Keywords, identifiers, constants
    if (stream.match(IDENT_RE_STREAM)) {
      const word = stream.current()
      const upper = word.toUpperCase()

      // ID-space prefix? Check BEFORE the keyword sets so `t.foo` (where
      // `t` is a single-char prefix) gets `idSpace` instead of falling
      // through unhighlighted. Require `.<ident-or-digit>` to follow,
      // otherwise a bare `t` in `t := SELECT X` would mis-fire.
      if (ID_SPACE_PREFIXES.has(word) && stream.peek() === '.') {
        // Consume the dot + following identifier as one token.
        const startPos = stream.pos
        stream.next() // consume the dot
        if (stream.match(IDENT_RE_STREAM) || stream.match(/\d+/)) {
          return 'idSpace'
        }
        // Couldn't consume an identifier after the dot — restore by
        // backtracking to just-after `t`. StreamLanguage doesn't expose
        // a `pos` setter; this should be rare (mid-typing). Fall
        // through to plain by ignoring the dot.
        stream.pos = startPos
        return null
      }

      if (CONTROL_KEYWORDS.has(upper)) {
        // Track block depth for indentation
        if (upper === 'THEN') state.blockDepth++
        else if (upper === 'ENDIF') state.blockDepth = Math.max(0, state.blockDepth - 1)
        // SELECT introduces a class context for the next ident.
        if (upper === 'SELECT') state.classContext = true
        return 'keyword'
      }
      if (CONTEXT_KEYWORDS.has(upper)) return 'contextKeyword'
      if (BOOL_VALUES.has(upper)) return 'bool'
      if (NULL_VALUES.has(upper)) return 'null'
      if (STYLE_CONSTANTS.has(upper)) return 'styleConst'
      if (DATE_CONSTANTS.has(upper)) return 'dateConst'
      // Aggregate funcs — checked BEFORE GLOBAL_FUNCS so PCmSUM / NOSO
      // get their distinctive colour. Both sets are case-sensitive;
      // `upper` is only used for the keyword/constant categories above.
      if (AGGREGATE_FUNCS.has(word)) return 'aggregate'
      // Global funcs: check exact (case-sensitive for lowercase ones like abs, str)
      if (GLOBAL_FUNCS.has(word) || GLOBAL_FUNCS.has(upper)) return 'globalFunc'

      // Class name after a class-introducing token. Read the flag
      // here, then clear it — only an actual identifier consumes the
      // classContext extension. Punctuation / whitespace / operators
      // between the introducer and the type ident don't disturb it.
      const wasClassContext = state.classContext
      state.classContext = false
      if (wasClassContext && (PASCAL_RE.test(word) || CAMEL_RE.test(word))) {
        return 'className'
      }

      return null
    }

    // Callback colon (forEach, filter, etc.) — bare `:` (`:=` / `:+` already matched above)
    if (stream.peek() === ':') {
      stream.next()
      state.callbackDepth++
      return null
    }

    // Closing paren — may close a callback block
    if (stream.peek() === ')') {
      stream.next()
      if (state.callbackDepth > 0) state.callbackDepth--
      return null
    }

    // Comparison and arithmetic operators
    if (stream.match(/[=!<>+\-*/%]/)) return 'operator'

    // Advance past any unrecognised character
    stream.next()
    return null
  },

  indent(state: State, textAfter: string, context: IndentContext): number | null {
    // State carries blockDepth (IF/THEN/ENDIF) and callbackDepth (forEach colons)
    // at the START of this line. Combined depth = total nesting.
    let depth = state.blockDepth + state.callbackDepth

    // Dedent for lines that close a block
    const trimmed = textAfter.trimStart()
    if (/^(ENDIF|ELSE)\b/i.test(trimmed)) depth--
    if (/^\)/.test(trimmed)) depth--

    return Math.max(0, depth * context.unit)
  },

  languageData: {
    indentOnInput: /^\s*(ENDIF|ELSE|\))\s*$/,
  },

  tokenTable: {
    transactional: tags.special(tags.name),
    tableMethod: tags.propertyName,
    readMethod: tags.function(tags.name),
    styleConst: tags.constant(tags.name),
    // Date constants (TODAY / BOP / EOP / BOY …) — `tags.atom` is the
    // Lezer tag for a "literal that isn't a keyword". TODAY/BOP/EOP are
    // reserved words AND self-evaluating constants — somewhere between
    // a keyword and a literal. `atom` fits because each evaluates to a
    // single fixed period/date with no arguments, the same way `nil` /
    // `()` map to `atom` in other languages. A separate tag (vs reusing
    // `constant(name)` like styleConst) lets the highlight palette
    // give temporal anchors their own cool-tone colour, distinct from
    // the warm-tone format constants.
    dateConst: tags.atom,
    globalFunc: tags.function(tags.variableName),
    contextKeyword: tags.special(tags.variableName),
    idSpace: tags.namespace,
    className: tags.className,
    aggregate: tags.macroName,
    // `expr` (bare `.expression`) sits next to `prop` — same family
    // but the eval-vs-text gotcha gets an underline cue in
    // highlight.ts to disambiguate from italic `null` / `comment`.
    expr: tags.special(tags.propertyName),
    prop: tags.attributeName,
  },
})
