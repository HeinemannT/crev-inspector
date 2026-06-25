/**
 * Context-aware completions for Extended Code (standalone editor version).
 *
 * - After `.` → suggest read / table / transactional methods
 * - After start of token → keywords, global functions, tracked variables, block scaffolds
 */
import { CompletionContext, CompletionResult, snippetCompletion } from '@codemirror/autocomplete'
import type { ViewUpdate } from '@codemirror/view'
import { EditorView } from '@codemirror/view'
import { ID_SPACE_PREFIXES } from '../../lib/ec-grammar'

interface CompletionDef {
  label: string
  detail: string
  info: string
  boost?: number
}

const READ_METHODS: CompletionDef[] = [
  { label: 'ancestor', detail: 'read method', info: 'Returns the ancestor node matching a given type or filter.' },
  { label: 'as', detail: 'read method', info: 'Casts or aliases: simple property extraction from list items.' },
  { label: 'avg', detail: 'read method', info: 'Returns the average of a numeric property across a list.' },
  { label: 'calculate', detail: 'read method', info: 'Evaluates a complex expression in the context of each list item.' },
  { label: 'canAdd', detail: 'read method', info: 'Returns TRUE if a child of the given type can be added.' },
  { label: 'canChange', detail: 'read method', info: 'Returns TRUE if the property can be modified.' },
  { label: 'canDelete', detail: 'read method', info: 'Returns TRUE if the object can be deleted.' },
  { label: 'children', detail: 'read method', info: 'Returns the direct children of the current node.' },
  { label: 'count', detail: 'read method', info: 'Returns the number of items in a list.' },
  { label: 'descendants', detail: 'read method', info: 'Returns all descendants of the current node (recursive).' },
  { label: 'distinct', detail: 'read method', info: 'Removes duplicates from a list.' },
  { label: 'fields', detail: 'read method', info: 'Returns the available field names for an object.' },
  { label: 'filter', detail: 'read method', info: 'Filters a list by a condition expression.' },
  { label: 'first', detail: 'read method', info: 'Returns the first item in a list.' },
  { label: 'forEach', detail: 'read method', info: 'Iterates over a list. Use colon: list.forEach(_item: body)' },
  { label: 'get', detail: 'read method', info: 'Gets a value from a MAP by key, or a property by name.' },
  { label: 'groupBy', detail: 'read method', info: 'Groups list items by a property value.' },
  { label: 'indexOf', detail: 'read method', info: 'Returns the index of an item in a list.' },
  { label: 'isMissing', detail: 'read method', info: 'Returns TRUE if the value is MISSING or NULL.' },
  { label: 'item', detail: 'read method', info: 'Returns the item at a given index (1-based).' },
  { label: 'join', detail: 'read method', info: 'Joins a list of strings with a separator.' },
  { label: 'last', detail: 'read method', info: 'Returns the last item in a list.' },
  { label: 'map', detail: 'read method', info: 'Converts a list to a MAP using key (and optional value) properties.' },
  { label: 'max', detail: 'read method', info: 'Returns the maximum value in a list.' },
  { label: 'merge', detail: 'read method', info: 'Merges two lists into one.' },
  { label: 'min', detail: 'read method', info: 'Returns the minimum value in a list.' },
  { label: 'remove', detail: 'read method', info: 'Removes items matching a condition from a list.' },
  { label: 'reverse', detail: 'read method', info: 'Reverses the order of a list.' },
  { label: 'rref', detail: 'read method', info: 'Resolves a relative reference to another node.' },
  { label: 'size', detail: 'read method', info: 'Returns the number of items in a list.' },
  { label: 'sort', detail: 'read method', info: 'Sorts a list in ascending order.' },
  { label: 'sortReverse', detail: 'read method', info: 'Sorts a list in descending order.' },
  { label: 'strip', detail: 'read method', info: 'Removes leading/trailing whitespace from a string.' },
  { label: 'substring', detail: 'read method', info: 'Extracts a substring by start and end index.' },
  { label: 'sum', detail: 'read method', info: 'Sums a numeric property across a list.' },
  { label: 'tree', detail: 'read method', info: 'Returns the full subtree rooted at the current node.' },
  { label: 'union', detail: 'read method', info: 'Returns the union of two lists (no duplicates).' },
  { label: 'url', detail: 'read method', info: 'Returns the URL of the current node.' },
  { label: 'whenMissing', detail: 'read method', info: 'Returns a fallback value if the primary is MISSING.' },
]

const TABLE_METHODS: CompletionDef[] = [
  { label: 'addColumn', detail: 'table method', info: "Adds a column: .addColumn('Name', expression)" },
  { label: 'addTimeColumns', detail: 'table method', info: 'Adds time-period columns.' },
  { label: 'addRow', detail: 'table method', info: 'Appends a row to the current table.' },
  { label: 'align', detail: 'table method', info: 'Sets horizontal alignment (LEFT, RIGHT, CENTER).' },
  { label: 'collapse', detail: 'table method', info: 'Marks a row as collapsible.' },
  { label: 'decimals', detail: 'table method', info: 'Sets decimal precision for a numeric column.' },
  { label: 'formattype', detail: 'table method', info: 'Sets the format type (percentage, thousands, etc.).' },
  { label: 'headerStyle', detail: 'table method', info: 'Sets the style for the column header.' },
  { label: 'hidden', detail: 'table method', info: 'Hides a column.' },
  { label: 'indent', detail: 'table method', info: 'Sets the indent level for hierarchy rendering.' },
  { label: 'postfix', detail: 'table method', info: 'Appends a string after the cell value.' },
  { label: 'prefix', detail: 'table method', info: 'Prepends a string before the cell value.' },
  { label: 'readonly', detail: 'table method', info: 'Makes a column non-editable.' },
  { label: 'style', detail: 'table method', info: 'Sets a style or indicator colour on a cell.' },
  { label: 'table', detail: 'table method', info: 'Converts a list to a table.' },
  { label: 'width', detail: 'table method', info: 'Sets the pixel width of a column.' },
]

const TRANSACTIONAL_METHODS: CompletionDef[] = [
  { label: 'add', detail: 'transactional', info: 'Adds a new child node.' },
  { label: 'change', detail: 'transactional', info: 'Modifies a property value on the current node.' },
  { label: 'delete', detail: 'transactional', info: 'Deletes the current node.' },
  { label: 'link', detail: 'transactional', info: 'Creates a link between two nodes.' },
  { label: 'move', detail: 'transactional', info: 'Moves the node to a new parent.' },
  { label: 'unlink', detail: 'transactional', info: 'Removes a link between two nodes.' },
  { label: 'copy', detail: 'transactional', info: 'Copies the current node.' },
  { label: 'generate', detail: 'transactional', info: 'Generates EC code for the object.' },
  { label: 'genEdit', detail: 'transactional', info: 'Generates editable EC code.' },
]

const KEYWORDS: CompletionDef[] = [
  { label: 'THEN', detail: 'keyword', info: 'Follows the IF condition.' },
  { label: 'ELSE', detail: 'keyword', info: 'Alternative branch. ELSE is mandatory.' },
  { label: 'ENDIF', detail: 'keyword', info: 'Closes an IF block.' },
  { label: 'FROM', detail: 'keyword', info: 'Source in SELECT.' },
  { label: 'WHERE', detail: 'keyword', info: 'Filters in SELECT.' },
  { label: 'RETURN', detail: 'keyword', info: 'Returns a value.' },
  { label: 'TRANSACTIONAL', detail: 'keyword', info: 'Marks a block as transactional.' },
  { label: 'AND', detail: 'keyword', info: 'Logical AND.' },
  { label: 'OR', detail: 'keyword', info: 'Logical OR.' },
  { label: 'NOT', detail: 'keyword', info: 'Logical NOT.' },
  { label: 'IN', detail: 'keyword', info: 'Tests membership.' },
  { label: 'CONTAINS', detail: 'keyword', info: 'Tests exact membership (not substring).' },
  { label: 'TRUE', detail: 'boolean', info: 'Boolean true.' },
  { label: 'FALSE', detail: 'boolean', info: 'Boolean false.' },
  { label: 'MISSING', detail: 'null value', info: 'Represents a missing value.' },
  { label: 'root', detail: 'context', info: 'Model root.' },
  { label: 'this', detail: 'context', info: 'Current context.' },
  { label: 'TODAY', detail: 'date', info: 'Current date.' },
  { label: 'BOP', detail: 'date', info: 'Beginning of period.' },
  { label: 'EOP', detail: 'date', info: 'End of period.' },
]

const GLOBAL_FUNCS: CompletionDef[] = [
  { label: 'LIST', detail: 'global function', info: "Creates a list: LIST('a', 'b', 'c')" },
  { label: 'MAP', detail: 'global function', info: "Creates a key-value map: MAP('key1';value1, 'key2';value2)" },
  { label: 'JSON', detail: 'global function', info: "Parses a JSON string: JSON('{\"name\":\"test\"}')" },
  { label: 'AGG', detail: 'KPI aggregate', info: "Aggregates KPI across orgs." },
  { label: 'abs', detail: 'global function', info: 'Absolute value.' },
  { label: 'ceil', detail: 'global function', info: 'Rounds up.' },
  { label: 'floor', detail: 'global function', info: 'Rounds down.' },
  { label: 'round', detail: 'global function', info: 'Rounds to N decimals.' },
  { label: 'num', detail: 'global function', info: 'Converts to number.' },
  { label: 'str', detail: 'global function', info: 'Converts to string.' },
  { label: 'createTable', detail: 'global function', info: 'Creates a new table.' },
  { label: 'lookup', detail: 'global function', info: 'Fetches a BMP object by RID.' },
]

// --- Variable tracking ---
export interface TrackedVar { name: string; line: number; rhs: string }
let trackedVariables = new Set<string>()
let trackedVarDetails: TrackedVar[] = []

/** Get rich variable info for the variables panel. */
export function getTrackedVariables(): TrackedVar[] { return trackedVarDetails; }

/** Wipe the tracked-variables state. Called when the editor switches
 *  to a non-EC property (HTML / JS / CSS) — those don't carry EC vars,
 *  so the Vars panel should show empty rather than the previous EC
 *  property's leftovers. */
export function clearTrackedVariables(): void {
  trackedVariables = new Set();
  trackedVarDetails = [];
}

/** Reserved identifiers that look like assignments but aren't user variables.
 *  Keeps `if x := 1 THEN …` and BMP context references (`root`, `this`, …) out
 *  of the completions list. Lower-cased keys are matched case-insensitively. */
const RESERVED_VAR_NAMES = new Set([
  // EC keywords
  'if', 'then', 'else', 'elseif', 'endif', 'select', 'from', 'where', 'return',
  'transactional', 'and', 'or', 'not', 'in', 'contains', 'true', 'false', 'missing',
  // BMP context refs (you can't reassign these and shadowing them silently breaks scripts)
  'root', 'this', 'self', 'today', 'bop', 'eop',
])

/** Match any identifier (with or without leading underscore) followed by `:=`
 *  at the beginning of a line (optional indent). Lets the variables panel
 *  pick up plain names like `idx :=`, `riskAssessments := …` — not just the
 *  underscore-prefixed convention. Filtered against RESERVED_VAR_NAMES. */
const VAR_RE = /^\s*([A-Za-z_]\w*)\s*:=\s*(.*)/

/** Scan a CodeMirror doc for `name := …` declarations. Exported so the
 *  editor can run it once on initial mount — the updateListener only
 *  fires on `docChanged`, which isn't true for the doc Vite hands us at
 *  view-construction time, so the Vars panel was empty until the user
 *  typed a character. */
export function scanVariables(doc: { lines: number; line(n: number): { text: string } }): void {
  const newVars = new Set<string>()
  const details: TrackedVar[] = []
  for (let i = 1; i <= doc.lines; i++) {
    const lineText = doc.line(i).text
    const m = VAR_RE.exec(lineText)
    if (m) {
      const name = m[1]
      if (RESERVED_VAR_NAMES.has(name.toLowerCase())) continue
      if (!newVars.has(name)) { // first assignment wins
        newVars.add(name)
        details.push({ name, line: i, rhs: m[2].trim().slice(0, 60) })
      }
    }
  }
  trackedVariables = newVars
  trackedVarDetails = details
}

export const variableTracker = EditorView.updateListener.of((update: ViewUpdate) => {
  if (!update.docChanged) return
  scanVariables(update.state.doc)
})

// --- Block scaffolding snippets ---
// Indent uses 5 spaces to match the editor's `indentUnit.of('     ')`
// configured in editor.ts. snippetCompletion templates are evaluated
// at module load (before any EditorState exists), so we can't read
// the configured indent here — hardcoded with the comment in lieu of
// a single-source-of-truth import.
const I = '     ' // 5-space indent
const BLOCK_SCAFFOLDS = [
  snippetCompletion(`IF \${1:condition} THEN\n${I}\${2}\nELSE\n${I}\${3}\nENDIF`, {
    label: 'if', detail: 'scaffold', info: 'IF/THEN/ELSE/ENDIF block', type: 'keyword', boost: 1,
  }),
  snippetCompletion(`\${1:list}.forEach(\${2:_item}:\n${I}\${3}\n)`, {
    label: 'foreach', detail: 'scaffold', info: 'forEach iteration block', type: 'keyword', boost: 1,
  }),
  snippetCompletion('SELECT ${1:Type} FROM ${2:source} WHERE ${3:condition}', {
    label: 'select', detail: 'scaffold', info: 'SELECT query', type: 'keyword', boost: 1,
  }),
  snippetCompletion(`createTable()\n${I}.addColumn('\${1:Name}', \${2:expression})\n${I}.addRow()`, {
    label: 'table', detail: 'scaffold', info: 'Table structure', type: 'function', boost: 1,
  }),
]

// --- Completion source ---
export function extendedCompletions(context: CompletionContext): CompletionResult | null {
  const { state, pos } = context
  const lastChar = pos > 0 ? state.doc.sliceString(pos - 1, pos) : ''

  if (lastChar === '.') {
    // Suppress object-method completions after a namespace prefix: `t.master`,
    // `r.<file>`, `cetas.<id>` etc. are business-id references, not objects —
    // offering .add / .ancestor / .children there is noise. The receiver is the
    // bare word right before the dot, and only counts as a namespace if it's
    // standalone (start of expr or after a non-word/non-dot char) so a method
    // chain like `obj.t.` still gets methods. (We don't offer business-id
    // completions here — scoped to suppression only.)
    const before = state.doc.sliceString(Math.max(0, pos - 12), pos - 1)
    const receiver = /(?:^|[^\w.])([A-Za-z]\w*)$/.exec(before)?.[1]
    if (receiver && ID_SPACE_PREFIXES.has(receiver)) return null

    return {
      from: pos,
      options: [
        ...READ_METHODS.map(m => ({ label: m.label, detail: m.detail, info: m.info, type: 'method' })),
        ...TABLE_METHODS.map(m => ({ label: m.label, detail: m.detail, info: m.info, type: 'method' })),
        ...TRANSACTIONAL_METHODS.map(m => ({ label: m.label, detail: m.detail, info: m.info, type: 'method' })),
      ],
    }
  }

  const word = context.matchBefore(/[\w]+/)
  if (!word || (word.from === word.to && !context.explicit)) return null

  return {
    from: word.from,
    options: [
      ...[...trackedVariables].map(name => ({ label: name, detail: 'variable', type: 'variable' as const, boost: 2 })),
      ...BLOCK_SCAFFOLDS,
      ...KEYWORDS.map(k => ({ label: k.label, detail: k.detail, info: k.info, type: 'keyword' })),
      ...GLOBAL_FUNCS.map(f => ({ label: f.label, detail: f.detail, info: f.info, type: 'function' })),
    ],
  }
}
