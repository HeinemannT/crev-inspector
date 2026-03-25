/**
 * Hover tooltips for Extended Code identifiers (standalone editor version).
 */
import { hoverTooltip } from '@codemirror/view'

const DOCS: Record<string, string> = {
  IF: 'Begins a conditional block. Must have THEN, ELSE (mandatory), ENDIF.',
  THEN: 'Follows the condition in an IF statement.',
  ELSE: 'Alternative branch. ELSE is mandatory in EC — use ELSE "" ENDIF for no-op.',
  ENDIF: 'Closes an IF/ELSE block.',
  SELECT: 'Query syntax: SELECT Type FROM source WHERE condition',
  FROM: 'Specifies the source node for a SELECT query.',
  WHERE: 'Filters items in a SELECT query by condition.',
  RETURN: 'Returns a value from the current expression context.',
  TRANSACTIONAL: 'Marks a block as transactional — changes will be committed.',
  AND: 'Logical AND — both conditions must be true.',
  OR: 'Logical OR — at least one condition must be true.',
  NOT: 'Logical NOT — inverts a boolean condition.',
  IN: 'Tests membership: returns TRUE if the left value is in the right list.',
  CONTAINS: 'Tests exact membership — NOT substring search. Use indexOf() >= 0 for substring.',
  root: 'Model root — access sections: root.scorecard, root.organisation, etc.',
  this: 'Current context — this.object, this.user, this.organisation, this.bop',
  self: 'Current item in a SELECT WHERE or calculate() context.',
  TRUE: 'Boolean true literal.',
  FALSE: 'Boolean false literal.',
  MISSING: 'Represents a missing or undefined value.',
  TODAY: 'The current date.',
  BOP: 'Beginning of the current calculation period.',
  EOP: 'End of the current calculation period.',
  LIST: 'Creates a list: LIST("a", "b", "c").',
  MAP: 'Creates a key-value map: MAP("key1";value1, "key2";value2). Access via .get().',
  JSON: 'Parses a JSON string. Dot access for properties, list methods on arrays.',
  AGG: "Aggregates a KPI across organisations: AGG('kpi_expr', orgList).",
  abs: 'Absolute value of a number.',
  ceil: 'Rounds up to the nearest integer.',
  floor: 'Rounds down to the nearest integer.',
  round: 'Rounds to N decimal places.',
  num: 'Converts a value to a number.',
  str: 'Converts a value to a string.',
  createTable: 'Initialises a new table structure for rendering.',
  lookup: 'Fetches a BMP object by its internal RID.',
  children: 'Returns the direct children of the current node.',
  filter: 'Filters a list by condition. Example: list.filter(name = "foo")',
  forEach: 'Iterates over each item. Syntax: list.forEach(_item: body). Use colon, not arrow.',
  sort: 'Sorts a list in ascending order by a property.',
  table: 'Converts a list to a table: list.table(id, name, property...)',
  addColumn: "Adds a named column: .addColumn('Name', expression).",
  add: 'Adds a new child node. Use Execute — Preview will not commit.',
  change: 'Updates a single property. Example: node.change(property, value)',
  delete: 'Permanently deletes a node. Use Execute — not reversible.',
  generate: 'Generates EC code to recreate an object. generate(true) = with IDs.',
  genEdit: 'Generates editable EC change script for an object.',
}

const IDENT_RE = /[\w]+/

export const extendedHoverDocs = hoverTooltip((view, pos) => {
  const line = view.state.doc.lineAt(pos)
  const text = line.text
  const offset = pos - line.from

  let start = offset
  let end = offset
  while (start > 0 && IDENT_RE.test(text[start - 1])) start--
  while (end < text.length && IDENT_RE.test(text[end])) end++

  const word = text.slice(start, end)
  if (!word) return null

  const doc = DOCS[word] ?? DOCS[word.toUpperCase()]
  if (!doc) return null

  return {
    pos: line.from + start,
    end: line.from + end,
    above: true,
    create() {
      const el = document.createElement('div')
      el.className = 'hover-tooltip'
      el.textContent = doc
      return { dom: el }
    },
  }
})
