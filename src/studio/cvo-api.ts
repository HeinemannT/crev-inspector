/**
 * CVO-API autocomplete candidates for the javascript slot. A CVO's whole
 * contract is the `_data` global, so completing it (incl. the live expression /
 * table keys from the CVO's children) is the highest-leverage editor help.
 * Pure (no CodeMirror) → unit-tested; the CM completion source wraps it.
 */

/** `_data`'s top-level members (see cvo-internals `_data` shape). */
export const DATA_MEMBERS = ['element', 'context', 'expressions', 'tables', 'serverConnections', 'queryEndpoint']
/** `_data.context` fields. */
export const CONTEXT_FIELDS = ['orgid', 'period', 'start', 'end', 'yearToDate']

export interface CvoApiKeys {
  /** Keys from the CVO's CustomVisualizationExpression children. */
  expressions: string[]
  /** Keys from the CVO's CustomVisualizationTableReference children. */
  tables: string[]
}

export interface CvoApiCandidates {
  /** The partial word being completed (after the last dot). */
  word: string
  /** Candidate identifiers (unfiltered; the caller prefix-filters by `word`). */
  options: string[]
}

/** Given the text on the line up to the cursor, return the `_data.*` candidates
 *  to offer, or null when the cursor isn't in a `_data` member position. Most
 *  specific match wins (`_data.context.` before `_data.`). */
export function cvoApiCandidates(beforeCursor: string, keys: CvoApiKeys): CvoApiCandidates | null {
  let m: RegExpExecArray | null
  if ((m = /_data\.context\.(\w*)$/.exec(beforeCursor))) return { word: m[1], options: CONTEXT_FIELDS }
  if ((m = /_data\.expressions\.(\w*)$/.exec(beforeCursor))) return { word: m[1], options: keys.expressions }
  if ((m = /_data\.tables\.(\w*)$/.exec(beforeCursor))) return { word: m[1], options: keys.tables }
  if ((m = /_data\.(\w*)$/.exec(beforeCursor))) return { word: m[1], options: DATA_MEMBERS }
  return null
}
