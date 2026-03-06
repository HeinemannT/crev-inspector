/**
 * CodeMirror 6 StreamParser for Extended Code syntax highlighting.
 *
 * Token type strings returned by token() are mapped to highlight tags via tokenTable
 * (for custom types) or the built-in CM6 defaults (for standard names like
 * "keyword", "comment", "string", "number", "operator").
 */
import { StreamLanguage, type IndentContext } from '@codemirror/language'
import { tags } from '@lezer/highlight'

type State = {
  inString: '"' | "'" | null
  inBlockComment: boolean
  /** Track nesting depth for indentation: THEN increments, ENDIF decrements. */
  blockDepth: number
  /** forEach/callback colon depth: `:` increments, `)` when > 0 decrements. */
  callbackDepth: number
}

// EC keywords are case-insensitive — store uppercase, match via toUpperCase()
const CONTROL_KEYWORDS = new Set([
  'IF', 'THEN', 'ELSE', 'ENDIF', 'SELECT', 'FROM', 'WHERE', 'RETURN',
  'AND', 'OR', 'NOT', 'IN', 'CONTAINS', 'LIKE', 'TRANSACTIONAL',
  'TODAY', 'BOP', 'EOP', 'BOY', 'EOY', 'BOQ', 'EOQ', 'BOM', 'EOM',
  'BOW', 'EOW', 'BOH', 'EOH', 'BOT', 'EOT',
])

const CONTEXT_KEYWORDS = new Set(['ROOT', 'THIS', 'SELF'])

const BOOL_VALUES = new Set(['TRUE', 'FALSE'])
const NULL_VALUES = new Set(['MISSING', 'NULL', 'NA', 'NAN'])

const STYLE_CONSTANTS = new Set([
  'LEFT', 'RIGHT', 'CENTER',
  'RED', 'AMBER', 'GREEN', 'BLUE', 'GREY',
  'VISIBLE', 'NOVISIBLE', 'ADMINVISIBLEONLY', 'VISIBLEASPARENTONLY',
  'WRAPPED', 'FULL', 'TRUNCATED', 'SEPARATOR', 'PERCENTAGE', 'THOUSANDS',
  'DURATION', 'BOLD',
])

const GLOBAL_FUNCS = new Set([
  'LIST', 'MAP', 'HMAP', 'JSON', 'AGG',
  'abs', 'cbrt', 'ceil', 'floor', 'pow', 'round', 'sqrt',
  'md', 'num', 'str', 'priority', 'help',
  'createtable', 'createTable', 'date', 'output',
])

const TRANSACTIONAL_METHODS = new Set([
  'add', 'affixLink', 'change', 'clear', 'copy', 'delete', 'error',
  'generate', 'genEdit', 'genedit', 'link', 'move', 'moveAfter', 'moveBefore',
  'notify', 'reset', 'sendmail', 'unlink', 'update', 'start', 'stop',
  'expression', 'hClear', 'hclear',
])

const TABLE_METHODS = new Set([
  'addColumn', 'addTimeColumns', 'addRow', 'align', 'collapse', 'decimals',
  'formattype', 'headerStyle', 'hidden', 'indent', 'postfix', 'prefix',
  'readonly', 'style', 'table', 'width',
])

const READ_METHODS = new Set([
  'ancestor', 'as', 'avg', 'calculate', 'canAdd', 'canChange', 'canDelete',
  'children', 'count', 'descendants', 'distinct', 'fields',
  'filter', 'first', 'forEach', 'get', 'groupBy', 'indexOf',
  'isMissing', 'item', 'join', 'last', 'map', 'max', 'merge', 'min',
  'rref', 'remove', 'reverse', 'size', 'sort', 'sortReverse', 'strip',
  'substring', 'sum', 'tree', 'union', 'url', 'whenMissing',
])

const IDENT_RE = /[a-zA-Z_][a-zA-Z0-9_]*/

export const extendedLanguage = StreamLanguage.define<State>({
  startState: () => ({ inString: null, inBlockComment: false, blockDepth: 0, callbackDepth: 0 }),

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

    // Whitespace
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

    // Numbers
    if (stream.match(/\d+(\.\d+)?/)) return 'number'

    // Assignment operator :=
    if (stream.match(':=')) return 'operator'

    // Dot methods: .addColumn, .forEach, .delete, etc.
    if (stream.peek() === '.') {
      stream.next() // consume dot
      if (stream.match(IDENT_RE)) {
        const name = stream.current().slice(1) // strip leading dot
        if (TRANSACTIONAL_METHODS.has(name)) return 'transactional'
        if (TABLE_METHODS.has(name)) return 'tableMethod'
        if (READ_METHODS.has(name)) return 'readMethod'
        // Unknown dot-access — no highlight, but consumed
      }
      return null
    }

    // Keywords, identifiers, constants
    if (stream.match(IDENT_RE)) {
      const word = stream.current()
      const upper = word.toUpperCase()
      if (CONTROL_KEYWORDS.has(upper)) {
        // Track block depth for indentation
        if (upper === 'THEN') state.blockDepth++
        else if (upper === 'ENDIF') state.blockDepth = Math.max(0, state.blockDepth - 1)
        return 'keyword'
      }
      if (CONTEXT_KEYWORDS.has(upper)) return 'contextKeyword'
      if (BOOL_VALUES.has(upper)) return 'bool'
      if (NULL_VALUES.has(upper)) return 'null'
      if (STYLE_CONSTANTS.has(upper)) return 'styleConst'
      // Global funcs: check exact (case-sensitive for lowercase ones like abs, str)
      if (GLOBAL_FUNCS.has(word) || GLOBAL_FUNCS.has(upper)) return 'globalFunc'
      return null
    }

    // Callback colon (forEach, filter, etc.) — bare `:` (`:=` already matched above)
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
    globalFunc: tags.function(tags.variableName),
    contextKeyword: tags.special(tags.variableName),
  },
})
