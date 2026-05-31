/**
 * Extended Code grammar — single source of truth.
 *
 * Both syntax highlighters (the CodeMirror StreamLanguage in
 * `src/editor/ec/language.ts` and the lightweight tokeniser in
 * `src/lib/ec-format.ts`) import their keyword / method / operator sets
 * from this file. Adding a new keyword used to require editing TWO files
 * with subtly different conventions; now it's a one-file edit.
 *
 * ## Case-sensitivity rules per category
 *
 * EC's grammar mixes case-INsensitive control words (`IF`/`if`/`If`)
 * with case-SENSITIVE method names (`forEach`, NOT `FOREACH`). The
 * sets below adopt the canonical case used in real EC scripts:
 *
 *   - CONTROL_KEYWORDS / NAMED_OPERATORS / CONTEXT_KEYWORDS /
 *     BOOL_VALUES / NULL_VALUES / STYLE_CONSTANTS / DATE_CONSTANTS
 *     → uppercase canonical. `classifyIdent` normalises via toUpperCase()
 *     before lookup, so any case matches.
 *
 *   - GLOBAL_FUNCS / TRANSACTIONAL_METHODS / TABLE_METHODS /
 *     READ_METHODS / AGGREGATE_FUNCS / KNOWN_PROPERTIES /
 *     ID_SPACE_PREFIXES
 *     → mixed canonical (e.g. `forEach`, `addColumn`, `whenMissing`).
 *     `classifyIdent` does an exact match against the canonical form;
 *     `FOREACH` won't be classified as a read-method. This matches the
 *     EC runtime's actual case-sensitivity for method dispatch.
 *
 * ## Adding a new entry
 *
 * 1. Drop the canonical form into the right Set.
 * 2. If a new tag-kind is needed, extend `TokKind` AND add palette
 *    entries in `src/editor/ec/highlight.ts` and the `.ec-tok-*` CSS
 *    blocks in `sidepanel.css` / `objectview.css` / `codesearch.css`.
 * 3. Add a row to `src/lib/__tests__/ec-grammar.test.ts`.
 */

// ── Case-INsensitive keyword categories ────────────────────────────

export const CONTROL_KEYWORDS: ReadonlySet<string> = new Set([
  'IF', 'THEN', 'ELSE', 'ELSEIF', 'ENDIF',
  'SELECT', 'FROM', 'WHERE', 'RETURN', 'ORDER',
  'AND', 'OR', 'NOT', 'IN', 'CONTAINS', 'LIKE',
  'TRANSACTIONAL',
])

/** Multi-word operators recognised by lookahead. The first word is in
 *  CONTROL_KEYWORDS already; this set drives the "is this a compound
 *  operator?" check. */
export const NAMED_OPERATORS: ReadonlySet<string> = new Set([
  'CONTAINS', 'IN', 'NOT IN', 'NOT CONTAINS',
])

export const CONTEXT_KEYWORDS: ReadonlySet<string> = new Set([
  'ROOT', 'THIS', 'SELF', 'PARENT',
])

export const BOOL_VALUES: ReadonlySet<string> = new Set([
  'TRUE', 'FALSE',
])

/** EC's "null-ish" literals. MISSING is the canonical one; the others
 *  are documented aliases. */
export const NULL_VALUES: ReadonlySet<string> = new Set([
  'MISSING', 'NULL', 'NA', 'NAN',
])

export const STYLE_CONSTANTS: ReadonlySet<string> = new Set([
  'LEFT', 'RIGHT', 'CENTER',
  'RED', 'AMBER', 'GREEN', 'BLUE', 'GREY',
  'VISIBLE', 'NOVISIBLE', 'ADMINVISIBLEONLY', 'VISIBLEASPARENTONLY',
  'WRAPPED', 'FULL', 'TRUNCATED', 'SEPARATOR', 'PERCENTAGE', 'THOUSANDS',
  'DURATION', 'BOLD',
])

/** Date / period anchor constants. `today` reads as today's date;
 *  `BOP`/`EOP` are begin/end-of-period; the longer-prefix forms anchor
 *  to year (`BOY`), quarter (`BOQ`), month (`BOM`), week (`BOW`),
 *  halfyear (`BOH`), tertial (`BOT`). */
export const DATE_CONSTANTS: ReadonlySet<string> = new Set([
  'TODAY',
  'BOP', 'EOP', 'BOY', 'EOY', 'BOQ', 'EOQ', 'BOM', 'EOM',
  'BOW', 'EOW', 'BOH', 'EOH', 'BOT', 'EOT',
])

// ── Case-SENSITIVE function / method categories ────────────────────

/** Global / top-level callables that don't dispatch through a receiver.
 *  Mixed case in the canonical form (e.g. `date`, `output`, `LIST`,
 *  `JSON`). Matched case-sensitively. */
export const GLOBAL_FUNCS: ReadonlySet<string> = new Set([
  'LIST', 'MAP', 'HMAP', 'JSON',
  'abs', 'cbrt', 'ceil', 'floor', 'pow', 'round', 'sqrt',
  'md', 'num', 'str', 'priority', 'help',
  'createtable', 'createTable',
  'date', 'output', 'lookup',
  'type', 'var', 'space',
  'when',
  'sendmail', 'notify', 'error', 'export',
])

/** Aggregate / KPI-engine functions. They look like global funcs but
 *  deserve their own colour because they're SLOW and side-effect-heavy
 *  (engine queries). Surface separately from `output` / `LIST`. */
export const AGGREGATE_FUNCS: ReadonlySet<string> = new Set([
  'AGG', 'AGGAVG',
  'GRP', 'IND', 'INDEX',
  'NOSO', 'NOSOA',
  'PCmSUM', 'PCySUM', 'PCqSUM', 'PCwSUM', 'PCdSUM',
  'PCmAVG', 'PCyAVG', 'PCqAVG', 'PCwAVG', 'PCdAVG',
  'PCmCOUNT', 'PCyCOUNT', 'PCqCOUNT', 'PCwCOUNT', 'PCdCOUNT',
  'PCmMAX', 'PCyMAX', 'PCqMAX', 'PCwMAX', 'PCdMAX',
  'PCmMIN', 'PCyMIN', 'PCqMIN', 'PCwMIN', 'PCdMIN',
  'NOm', 'NOy', 'NOq', 'NOw', 'NOd',
  'RGSm', 'RGSy', 'RGSq',
  'TQH', 'TQL', 'TDH', 'TDL', 'TQAH', 'TQAL',
  'T25H', 'T25L', 'T10H', 'T10L',
])

/** Methods that COMMIT changes when ec_execute runs. Highlighted in a
 *  cautionary colour ("you're about to mutate state"). */
export const TRANSACTIONAL_METHODS: ReadonlySet<string> = new Set([
  'add', 'affixLink', 'change', 'clear', 'copy', 'delete',
  'generate', 'genEdit', 'genedit',
  'link', 'move', 'moveAfter', 'moveBefore',
  'reset', 'unlink', 'update',
  'start', 'stop',
  'hClear', 'hclear',
])

/** Table-builder methods chained on `createTable(...)`. */
export const TABLE_METHODS: ReadonlySet<string> = new Set([
  'addColumn', 'addTimeColumns', 'addRow',
  'align', 'collapse', 'decimals',
  'formattype', 'formatType',
  'headerStyle', 'hidden', 'indent',
  'postfix', 'prefix',
  'readonly', 'style', 'table',
  'urlperiod', 'width',
])

/** Methods that READ state — chained on lists, scalars, JSON nodes,
 *  date values, etc. The biggest category by count; this is where
 *  most EC reads spend their time. */
export const READ_METHODS: ReadonlySet<string> = new Set([
  // navigation
  'ancestor', 'children', 'descendants',
  // list ops
  'as', 'avg', 'calculate', 'count', 'distinct', 'fields',
  'filter', 'find', 'first', 'forEach', 'get', 'groupBy',
  'hmap', 'indexOf', 'item', 'join', 'last',
  'map', 'max', 'merge', 'min',
  'remove', 'reverse', 'size', 'sort', 'sortReverse',
  'sum', 'tree', 'union',
  // permissions
  'canAdd', 'canChange', 'canDelete',
  // refs
  'rref',
  // strings
  'strip', 'substring',
  // formatting / url
  'format', 'replace', 'toLowerCase', 'toUpperCase', 'toString', 'trim', 'url',
  // null-coalesce
  'isMissing', 'whenMissing',
])

/** Property accessors (no parens). Tag with their own colour so a
 *  reader can tell at a glance "this is reading state" vs "this is
 *  calling a method that may run code". Members are the most-used
 *  properties from the live workspace; missing ones fall through to
 *  no highlight. */
export const KNOWN_PROPERTIES: ReadonlySet<string> = new Set([
  'name', 'id', 'rid', 'className', 'businessId',
  'webParent', 'linkedTo', 'template',
  'cardConfig', 'card', 'container',
  'iso', 'year', 'month', 'quarter', 'halfyear', 'tertial',
  'week', 'day',
  'visible', 'inScope', 'available',
  'inheritVisible', 'inheritScope', 'inheritAvailable',
  'responsible', 'ownership', 'statusType',
  'actionObject', 'actionType',
  // NOTE: `start` / `end` / `bop` / `eop` are accessed as `this.start`
  // (context binding), not `_obj.start`, so they're handled by the
  // CONTEXT_KEYWORDS branch — not duplicated here. `parent` / `children`
  // / `descendants` ARE properties too but they share names with read
  // methods; the classifier prefers the method tag (purple) for visual
  // consistency with the (X) form.
])

/** ID-space prefixes used as `<prefix>.<id>` to look up an object by
 *  business ID. Recognised by the tokeniser to highlight the prefix
 *  distinctly from a normal ident.
 *
 *  Includes the platform prefixes (t/o/d/k/r/c/n/u/g/p/nt/ap/ndi) plus
 *  the live GRC ID spaces from this BMP install (ceven, cetas, etc.). */
export const ID_SPACE_PREFIXES: ReadonlySet<string> = new Set([
  // platform
  't', 'o', 'd', 'k', 'r', 'c', 'n', 'u', 'g', 'p',
  'nt', 'ap', 'ndi',
  // enterprise / GRC modules
  'ceven', 'cetas', 'cecom', 'ceinc', 'cepro', 'cepol',
  'cecme', 'ceiss', 'ceass', 'ceser', 'cecot', 'ceprj',
  'cereg', 'cecor', 'ceind', 'ceatt', 'ceras', 'acpol',
  'role', 'ceprd', 'sa', 'cepsc', 'ceprv', 'cewfl',
  'cedis', 'ceinq', 'ceqst', 'cedpi', 'cetia', 'ceasa',
  'fas', 'ba',
])

// ── Class-introducing methods ─────────────────────────────────────

/** Methods whose FIRST positional argument is a class reference
 *  (PascalCase or lowerCamel). Both tokenisers use this to set the
 *  next-ident-is-a-class flag after consuming a member like `.add(`,
 *  `.children(`, `.descendants(`, `.ancestor(`. SELECT itself is
 *  handled inline (it's a keyword, not a member) but matches the
 *  same intent.
 *
 *  Was duplicated as `CLASS_INTRO_METHODS` in language.ts and
 *  `CLASS_ARG_METHODS` in ec-format.ts — same data, two names. Moved
 *  here so a future addition (e.g. `.tree`) is a one-file edit. */
export const CLASS_INTRO_METHODS: ReadonlySet<string> = new Set([
  'add', 'children', 'descendants', 'ancestor',
])

// ── Regex helpers (shared between tokenisers) ──────────────────────

/** Anchored full-identifier match. Use with `.test()` / `.exec()` on
 *  a `text.slice()` that starts at a candidate position. */
export const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*/

/** Same shape as `IDENT_RE` but UN-anchored — used by CodeMirror's
 *  `stream.match(regex)`, which is positional and doesn't want `^`. */
export const IDENT_RE_STREAM = /[A-Za-z_][A-Za-z0-9_]*/

/** Single-character regex for "can start an identifier" — `[A-Za-z_]`.
 *  Used by the lightweight tokeniser's per-character dispatch loop. */
export const IDENT_FIRST_CHAR_RE = /[A-Za-z_]/

/** Single-character regex for "can continue an identifier" —
 *  `[A-Za-z0-9_]`. Used to walk past the first character of an ident. */
export const IDENT_CONT_CHAR_RE = /[A-Za-z0-9_]/

/** Single-character regex for "is a digit". */
export const DIGIT_RE = /[0-9]/

/** PascalCase class name — used to upgrade an ident to `className`
 *  when it appears after a class-introducing keyword (SELECT, .add,
 *  .children, .descendants, .ancestor). */
export const PASCAL_RE = /^[A-Z][A-Za-z0-9]*$/

/** lowerCamelCase — matched as fallback for the `prevContextual`
 *  class-name lookup so `SELECT ceRiskAssessment` highlights the
 *  type identically to `SELECT CeRiskAssessment`. BMP's runtime
 *  accepts either case for SELECT and the inference now canonicalises
 *  to PascalCase; we keep the highlight in sync. */
export const CAMEL_RE = /^[a-z][A-Za-z0-9]*$/

/** Date / duration literal suffix on a number: `1D`, `2W`, `3M`,
 *  `1Y`, plus the period codes `EH` / `ET` / `EY` etc. The suffix
 *  characters live in `[DWMYHTQ]`. */
export const DATE_DURATION_SUFFIX_RE = /^[DWMYHTQ]\b/

// ── Token kind discriminator ───────────────────────────────────────

/** Every kind of token both highlighters can produce. The string is
 *  also the CSS class suffix the lightweight tokeniser emits — see
 *  `ec-tok-*` rules in `sidepanel.css` / `objectview.css` /
 *  `codesearch.css`. */
export type TokKind =
  | 'kw'        // control / named-op
  | 'ctx'       // root / this / self / parent
  | 'bool'
  | 'null'      // MISSING / NULL / NA / NAN
  | 'style'     // LEFT / RED / BOLD
  | 'date'      // TODAY / BOP / number with date-suffix
  | 'global'    // LIST / JSON / output / date / when / num / str
  | 'agg'       // AGG / PCmSUM / NOSO
  | 'tx'        // .add / .delete / .change
  | 'tbl'       // .addColumn / .addRow
  | 'read'      // .filter / .forEach / .children
  | 'class'     // PascalCase or lowerCamel after SELECT/.add(T)/.children(T)
  | 'idspace'   // t.foo / o.100 / d.bar / k.baz
  | 'prop'      // .name / .id / .rid / .className
  | 'expr'      // .expression — the eval-vs-text gotcha; italicised
  | 'op'        // operators
  | 'str'
  | 'num'
  | 'cmt'

// ── Classifier ─────────────────────────────────────────────────────

/** Map a bare identifier (NO leading `.`, no prefix) to its TokKind,
 *  or null if unrecognised. The category casing rules described at the
 *  top of the file are baked in here. */
export function classifyIdent(word: string): TokKind | null {
  if (!word) return null
  const upper = word.toUpperCase()

  // Case-INsensitive categories first.
  if (CONTROL_KEYWORDS.has(upper)) return 'kw'
  if (CONTEXT_KEYWORDS.has(upper)) return 'ctx'
  if (BOOL_VALUES.has(upper)) return 'bool'
  if (NULL_VALUES.has(upper)) return 'null'
  if (STYLE_CONSTANTS.has(upper)) return 'style'
  if (DATE_CONSTANTS.has(upper)) return 'date'

  // Case-SENSITIVE categories.
  if (AGGREGATE_FUNCS.has(word)) return 'agg'
  if (GLOBAL_FUNCS.has(word)) return 'global'

  return null
}

/** Map a `.method` name (the part AFTER the dot, no leading `.`) to
 *  its TokKind. Property vs method dispatch lives here — `.expression`
 *  always returns `expr` (italicised), known properties return `prop`,
 *  everything else falls through to whichever method-set claims it. */
export function classifyDotMember(name: string): TokKind | null {
  if (!name) return null
  if (name === 'expression') return 'expr'
  if (TRANSACTIONAL_METHODS.has(name)) return 'tx'
  if (TABLE_METHODS.has(name)) return 'tbl'
  if (READ_METHODS.has(name)) return 'read'
  if (KNOWN_PROPERTIES.has(name)) return 'prop'
  return null
}
