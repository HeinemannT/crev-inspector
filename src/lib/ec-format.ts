/**
 * Lightweight single-line Extended Code tokeniser for inline previews.
 *
 * The full multi-line CodeMirror parser at `src/editor/ec/language.ts`
 * shares its grammar with this file via `src/lib/ec-grammar.ts` — every
 * keyword / method / operator / ID-space prefix is defined there once.
 *
 * Powers EC syntax colouring in:
 *   - ObjectView code preview cards (`objectview.ts`)
 *   - Reference View match-line list (`reference-view.ts`)
 *   - Code Search result match lines (`codesearch.ts` — composed with
 *     the query-substring background highlight)
 *
 * Multi-line state (block comments spanning lines, multi-line strings)
 * is INTENTIONALLY not tracked. Input contract: "one trimmed line at a
 * time". The editor's full parser handles those cases correctly.
 *
 * Architecture: `tokenizeEcLine` runs a small dispatch loop; each
 * branch is a `consume*` helper that mutates a tokenizer context and
 * returns true when it claimed input. Separating them keeps the
 * file readable (the legacy 150-line single function got flagged in
 * senior review). The `classContext` lifecycle is centralised in
 * `consumeIdentifier` — it reads + clears the flag — so punctuation
 * / whitespace / strings between a class-introducing token and the
 * type identifier don't disturb it. The SELECT keyword and the
 * class-arg dot members (`.add`, `.children`, `.descendants`,
 * `.ancestor`) set the flag back to true.
 */

import {
  CLASS_INTRO_METHODS,
  IDENT_FIRST_CHAR_RE,
  IDENT_CONT_CHAR_RE,
  DIGIT_RE,
  ID_SPACE_PREFIXES,
  PASCAL_RE,
  CAMEL_RE,
  DATE_DURATION_SUFFIX_RE,
  classifyIdent,
  classifyDotMember,
  type TokKind,
} from './ec-grammar'

/** A single classified slice of the source line. `start` / `end` are
 *  byte offsets into the original text — same character set as
 *  `text.slice(start, end)`. `kind === null` means "plain text, no
 *  highlight" (e.g. whitespace, punctuation we don't colour). */
export interface EcToken {
  kind: TokKind | null
  start: number
  end: number
}

/** Mutable tokeniser context — one instance per `tokenizeEcLine` call.
 *  Keeps the consume-helper signatures uniform so adding a new branch
 *  is a single function + one dispatch line. */
interface Ctx {
  text: string
  n: number
  /** Current scan position, in `text` bytes. */
  i: number
  /** Output token list, populated by `push`. */
  out: EcToken[]
  /** Single-token lookbehind: true when the previous emitted token
   *  introduces a class reference (SELECT keyword, or .add /
   *  .children / .descendants / .ancestor dot members). Only
   *  `consumeIdentifier` READS + CLEARS the flag — punctuation,
   *  operators, whitespace, comments all pass through without
   *  touching it, so `.children( /* x *​/ Initiative )` still
   *  tags Initiative as class across the intermediate noise. */
  classContext: boolean
}

function push(ctx: Ctx, kind: TokKind | null, start: number, end: number): void {
  if (start >= end) return
  ctx.out.push({ kind, start, end })
}

// ── Consumers ─────────────────────────────────────────────────────
// Each `consume*` runs at the current scan position. Returns true if
// it claimed at least one character (advancing `ctx.i`); false if the
// position doesn't match this token shape and the next consumer
// should be tried.

function consumeWhitespace(ctx: Ctx): boolean {
  const { text, n } = ctx
  let { i } = ctx
  const start = i
  while (i < n && (text[i] === ' ' || text[i] === '\t')) i++
  if (i === start) return false
  push(ctx, null, start, i)
  ctx.i = i
  // Whitespace preserves classContext — `SELECT  CeFoo` should still
  // tag CeFoo as className across the gap. The dispatch loop will
  // RE-set classContext to its current value (no-op) for the next
  // iteration; we just don't clear it here.
  return true
}

function consumeLineComment(ctx: Ctx): boolean {
  const { text, n, i } = ctx
  if (text[i] !== '/' || text[i + 1] !== '/') return false
  push(ctx, 'cmt', i, n)
  ctx.i = n
  return true
}

/** Block comment `/* … *​/` — single-line only. If the closing `*​/`
 *  isn't on this line, the rest of the line is tagged as comment
 *  (documented preview limit). */
function consumeBlockComment(ctx: Ctx): boolean {
  const { text, n, i } = ctx
  if (text[i] !== '/' || text[i + 1] !== '*') return false
  const end = text.indexOf('*/', i + 2)
  if (end < 0) {
    push(ctx, 'cmt', i, n)
    ctx.i = n
  } else {
    push(ctx, 'cmt', i, end + 2)
    ctx.i = end + 2
  }
  return true
}

function consumeString(ctx: Ctx): boolean {
  const { text, n, i } = ctx
  const ch = text[i]
  if (ch !== '"' && ch !== "'") return false
  let j = i + 1
  while (j < n) {
    if (text[j] === '\\' && j + 1 < n) { j += 2; continue }
    if (text[j] === ch) { j++; break }
    j++
  }
  push(ctx, 'str', i, j)
  ctx.i = j
  return true
}

/** Number, optionally with date-duration suffix (1D / 2W / 3M / 1Y / …).
 *  The suffix character lives in `[DWMYHTQ]`. */
function consumeNumber(ctx: Ctx): boolean {
  const { text, n, i } = ctx
  if (!DIGIT_RE.test(text[i])) return false
  let j = i
  while (j < n && (DIGIT_RE.test(text[j]) || text[j] === '.')) j++
  let kind: TokKind = 'num'
  if (j < n && DATE_DURATION_SUFFIX_RE.test(text.slice(j))) {
    kind = 'date'
    j++
  }
  push(ctx, kind, i, j)
  ctx.i = j
  return true
}

/** Dot-member access `.<name>`. Splits into a plain `op` for the dot
 *  and a category-tagged span for the member name. Class-arg methods
 *  (.add / .children / .descendants / .ancestor) extend classContext. */
function consumeDotMember(ctx: Ctx): boolean {
  const { text, n, i } = ctx
  if (text[i] !== '.') return false
  ctx.i = i + 1
  if (ctx.i < n && IDENT_FIRST_CHAR_RE.test(text[ctx.i])) {
    let j = ctx.i
    while (j < n && IDENT_CONT_CHAR_RE.test(text[j])) j++
    const name = text.slice(ctx.i, j)
    push(ctx, 'op', i, ctx.i)
    push(ctx, classifyDotMember(name), ctx.i, j)
    ctx.i = j
    if (CLASS_INTRO_METHODS.has(name)) ctx.classContext = true
    return true
  }
  // Bare dot (rare — `_x.` mid-typing). Plain op.
  push(ctx, 'op', i, ctx.i)
  return true
}

/** Multi-word operator `NOT IN` / `NOT CONTAINS`. Returns true ONLY
 *  when the second word is found; otherwise the regular identifier
 *  consumer handles `NOT` as a normal keyword. */
function tryConsumeNotIn(ctx: Ctx, word: string, j: number): boolean {
  const { text, n } = ctx
  if (word.toUpperCase() !== 'NOT') return false
  let k = j
  while (k < n && (text[k] === ' ' || text[k] === '\t')) k++
  let m = k
  while (m < n && IDENT_CONT_CHAR_RE.test(text[m])) m++
  const next = text.slice(k, m).toUpperCase()
  if (next !== 'IN' && next !== 'CONTAINS') return false
  push(ctx, 'kw', ctx.i, m)
  ctx.i = m
  return true
}

/** ID-space prefix `t.foo` / `o.100` / `d.bar` / etc. Emitted as a
 *  single token covering the prefix, dot, and following ident. Returns
 *  true only when the prefix matches AND a usable ident follows. */
function tryConsumeIdSpace(ctx: Ctx, word: string, j: number): boolean {
  const { text, n } = ctx
  if (!ID_SPACE_PREFIXES.has(word)) return false
  if (j >= n || text[j] !== '.') return false
  if (j + 1 >= n) return false
  const nextChar = text[j + 1]
  if (!IDENT_FIRST_CHAR_RE.test(nextChar) && !DIGIT_RE.test(nextChar)) return false
  let k = j + 1
  while (k < n && IDENT_CONT_CHAR_RE.test(text[k])) k++
  push(ctx, 'idspace', ctx.i, k)
  ctx.i = k
  return true
}

/** Identifier — keyword / context / bool / null / style / date /
 *  global / agg / id-space-prefix / class-after-context / plain.
 *  Reads + clears `classContext` once per ident: the SELECT keyword
 *  and the class-introducing dot members (`.add`, `.children`, etc.)
 *  set it; this consumer eats it on the next ident. Punctuation /
 *  whitespace / operators between the introducer and the type ident
 *  pass through without disturbing it (so `.children( Initiative )`
 *  still tags Initiative as class). */
function consumeIdentifier(ctx: Ctx): boolean {
  const { text, n, i } = ctx
  if (!IDENT_FIRST_CHAR_RE.test(text[i])) return false
  let j = i
  while (j < n && IDENT_CONT_CHAR_RE.test(text[j])) j++
  const word = text.slice(i, j)

  // ID-space prefix first — `t.foo` is one token, not three.
  // tryConsumeIdSpace doesn't disturb classContext on its own.
  if (tryConsumeIdSpace(ctx, word, j)) {
    ctx.classContext = false
    return true
  }

  // `NOT IN` / `NOT CONTAINS` — multi-word operator.
  if (tryConsumeNotIn(ctx, word, j)) {
    ctx.classContext = false
    return true
  }

  const wasClassContext = ctx.classContext
  ctx.classContext = false

  // Class name after SELECT or a class-introducing dot member. Both
  // PascalCase (`SELECT CeFoo`) and lowerCamel (`SELECT ceFoo`) are
  // accepted — BMP normalises case at dispatch and our inference
  // canonicalises identically.
  if (wasClassContext && (PASCAL_RE.test(word) || CAMEL_RE.test(word))) {
    push(ctx, 'class', i, j)
    ctx.i = j
    return true
  }

  const kind = classifyIdent(word)
  push(ctx, kind, i, j)
  ctx.i = j

  // SELECT (when classified as 'kw') extends the class context to the
  // next ident. Check the WORD, not the kind — `classifyIdent` returns
  // 'kw' for many keywords, only SELECT carries this semantic.
  if (word.toUpperCase() === 'SELECT') ctx.classContext = true
  return true
}

/** Operator pairs — `:=`, `:+`, `!=`, `<=`, `>=`, `<>`. Must run
 *  before the single-char operator consumer or `:` / `<` / `>` / `!`
 *  would peel off alone. */
function consumeOperatorPair(ctx: Ctx): boolean {
  const { text, i } = ctx
  const a = text[i]
  const b = text[i + 1]
  const pair = (
    (a === ':' && b === '=') ||
    (a === ':' && b === '+') ||
    (a === '!' && b === '=') ||
    (a === '<' && b === '=') ||
    (a === '<' && b === '>') ||
    (a === '>' && b === '=')
  )
  if (!pair) return false
  push(ctx, 'op', i, i + 2)
  ctx.i = i + 2
  return true
}

/** Single-char punctuation we want to colour as `op`. Parens /
 *  brackets stay plain so the eye can still see scope without an
 *  operator wash. */
function consumeSingleOperator(ctx: Ctx): boolean {
  const { text, i } = ctx
  if (!'=+-*/%<>!,;:'.includes(text[i])) return false
  push(ctx, 'op', i, i + 1)
  ctx.i = i + 1
  return true
}

/** Catch-all — punctuation + non-ASCII glyphs. Always claims one char
 *  so the loop can advance. Returns true unconditionally. */
function consumeOther(ctx: Ctx): boolean {
  const { i } = ctx
  push(ctx, null, i, i + 1)
  ctx.i = i + 1
  return true
}

// ── Public tokeniser ──────────────────────────────────────────────

/** Pure tokeniser. Walks `text`, returns one token per slice; the
 *  union of slices covers every character exactly once
 *  (`tokens.map(t => text.slice(t.start, t.end)).join('') === text`).
 *
 *  This shape — pure function over a string — lets Code Search compose
 *  the query-match background with the EC colour by intersecting
 *  ranges; see `renderTokens` + `codesearch.ts:highlightMatch`. */
export function tokenizeEcLine(text: string): EcToken[] {
  const ctx: Ctx = { text, n: text.length, i: 0, out: [], classContext: false }

  while (ctx.i < ctx.n) {
    // classContext lifecycle: only `consumeIdentifier` reads + clears
    // the flag. Everything else (whitespace, operators, punctuation,
    // strings, comments) passes through so `.children( /* x */
    // Initiative )` still tags Initiative as className across the
    // intermediate noise. The `consumeDotMember` and SELECT branches
    // SET it true; nobody else needs to think about it.
    if (consumeWhitespace(ctx)) continue
    if (consumeLineComment(ctx)) continue
    if (consumeBlockComment(ctx)) continue
    if (consumeString(ctx)) continue
    if (consumeNumber(ctx)) continue
    if (consumeDotMember(ctx)) continue
    if (consumeIdentifier(ctx)) continue
    if (consumeOperatorPair(ctx)) continue
    if (consumeSingleOperator(ctx)) continue
    consumeOther(ctx)
  }

  return ctx.out
}

/** Render a tokenised line into `parent` — one `<span class="ec-tok-<kind>">`
 *  per coloured token, bare text nodes for `kind === null`. Lets callers
 *  preserve event handlers on `parent` (the spans aren't reused). */
export function renderTokens(parent: HTMLElement, text: string, tokens: EcToken[]): void {
  for (const tok of tokens) {
    const slice = text.slice(tok.start, tok.end)
    if (tok.kind === null) {
      parent.appendChild(document.createTextNode(slice))
      continue
    }
    const span = document.createElement('span')
    span.className = `ec-tok-${tok.kind}`
    span.textContent = slice
    parent.appendChild(span)
  }
}

/** Tokenise `text` and append coloured spans to `parent`.
 *  Public API kept stable — old call sites (ObjectView code cards) and
 *  new ones (Reference View) both go through this. */
export function appendEcPreview(parent: HTMLElement, text: string): void {
  renderTokens(parent, text, tokenizeEcLine(text))
}

/** Convenience: build a `<div class="ec-preview">` containing the
 *  highlighted preview. Used by Reference View + (via
 *  `appendEcPreview`) any caller that wants a wrapping block. */
export function ecPreviewSpan(text: string, extraClass = ''): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = `ec-preview ${extraClass}`.trim()
  appendEcPreview(wrap, text)
  return wrap
}
