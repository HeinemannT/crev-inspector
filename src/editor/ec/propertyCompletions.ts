/**
 * Property-accessor autocomplete for Extended Code.
 *
 * Offers the properties of the applicable class wherever EC expects a property
 * ACCESSOR — not just WHERE. Two context families:
 *
 *   (A) Method arguments — `<var>.filter(<prop> …)`, `<var>.table(<prop>, …)`,
 *       `<var>.addRow(<prop>, …)`, `.sort/.groupBy/.distinct/.sum/…`. The class
 *       is the receiver variable's inferred element type (same resolution
 *       starExpansion uses for `*`).
 *   (B) `SELECT <Class> … WHERE <prop>` (and after AND/OR). The class is the
 *       SELECT target, read straight from the query text.
 *
 * It deliberately does NOT fire at a VALUE position (after `=`, `CONTAINS`, …) —
 * that slot wants list/tag option values (`t.<businessId>`), handled separately.
 *
 * Pure parsing + the shared typeInference cache → unit-tested. Mirrors
 * starExpansion's async "schema not loaded yet → wait on subscribe" pattern.
 */
import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import type { TypeSchemaProp, TypeOptionSet } from '../../lib/types';
import { getInference, getSchema, intersectionSchema, ensureSchemaNow, getOption, getOptions, ensureOptionsNow, getRefType, ensureRefType, subscribe, isElementContext } from './typeInference';
import { ID_SPACE_PREFIXES } from '../../lib/ec-grammar';

/** BMP class names are PascalCase, and the SW schema/options guard requires it,
 *  but EC accepts a camelCase SELECT target (`SELECT ceRiskAssessment`). Upper-
 *  case the first letter so the fetch isn't rejected. (Cache keys are lower-
 *  cased downstream, so this only affects the guard, not lookups.) */
function pascal(cls: string): string {
  return cls.charAt(0).toUpperCase() + cls.slice(1);
}

/** What argument positions of a method are property accessors.
 *   - 'all'        every comma-separated arg (table, addRow, map)
 *   - 'first'      only the first arg (sort, groupBy, aggregates, as)
 *   - 'rest'       every arg EXCEPT the first (addColumn — first arg is a label string)
 *   - 'first-pred' first arg, but only the property-name part before a comparator (filter) */
type ArgPolicy = 'all' | 'first' | 'rest' | 'first-pred';

const ACCESSOR_METHODS: Record<string, ArgPolicy> = {
  table: 'all',
  addRow: 'all',
  map: 'all',
  filter: 'first-pred',
  sort: 'first',
  sortReverse: 'first',
  groupBy: 'first',
  distinct: 'first',
  as: 'first',
  sum: 'first',
  avg: 'first',
  min: 'first',
  max: 'first',
  count: 'first',
  addColumn: 'rest',
  // .ref(prop) / .rref(prop) take a single reference-property accessor; the
  // offered props are filtered to the matching reference kind (see propFilter).
  ref: 'first',
  rref: 'first',
};

/** Reference-following methods restrict their property list to one kind. */
function propFilterFor(method: string): (configClass: string) => boolean {
  if (method === 'ref') {
    return cc => cc === 'ReferenceMethodConfig' || cc === 'HistoricalReferenceMethodConfig';
  }
  if (method === 'rref') {
    return cc => cc === 'ReverseReferenceMethodConfig';
  }
  return () => true;
}

/** Chain methods that collapse a list to ONE element at a dot-member position,
 *  so `<list>.first().<prop>` offers the element's properties. Element type is
 *  the receiver list's element type (same as inferredTypes(root)). `ancestor` is
 *  handled separately — its type comes from the call argument, not the receiver.
 *  Matched case-insensitively (see `isPickOne`). */
const PICK_ONE_DOT = new Set(['first', 'last', 'item']);
const isPickOne = (method: string): boolean => PICK_ONE_DOT.has(method.toLowerCase());

/** Max accessor hops past the `prefix.bid` of a concrete reference path that the
 *  nested-hop resolver will navigate (`ceras.foo.parent` = 1, `…parent.owner` = 2).
 *  A guardrail: each hop is an O(1) single-object server nav, but bounding depth
 *  keeps the injected EC tiny and the blast radius small. */
const MAX_REF_HOPS = 2;

/** Comparators that mark a VALUE position (so a property-name source must not fire). */
const VALUE_POS_RE = /[=<>!]|\b(?:CONTAINS|IN)\b/i;

/** True if `offset` sits inside a string literal on this single line. */
function insideString(text: string, offset: number): boolean {
  let inStr = false;
  let quote = '';
  for (let i = 0; i < offset; i++) {
    const c = text[i];
    if (inStr) {
      if (c === quote && text[i - 1] !== '\\') inStr = false;
    } else if (c === '"' || c === "'") {
      inStr = true;
      quote = c;
    }
  }
  return inStr;
}

/** The `<receiver>.<method>(` call that immediately encloses position `at`:
 *  walk left (paren-aware) to the owning `(`, read the `.method` before it, then
 *  the receiver identifier (the last chain component) before the dot. Shared by
 *  the accessor / filter / self resolvers so the walk lives in one place. */
interface EnclosingCall { openParen: number; dotIndex: number; method: string; receiver: string; receiverStart: number }
function enclosingCall(text: string, at: number): EnclosingCall | null {
  let depth = 0;
  let i = at - 1;
  for (; i >= 0; i--) {
    const c = text[i];
    if (c === ')') depth++;
    else if (c === '(') { if (depth === 0) break; depth--; }
  }
  if (i < 0) return null; // no enclosing call
  const openParen = i;

  let j = openParen - 1;
  while (j >= 0 && /\s/.test(text[j])) j--;
  const methodEnd = j;
  while (j >= 0 && /\w/.test(text[j])) j--;
  if (j < 0 || text[j] !== '.') return null;
  const dotIndex = j;
  const method = text.slice(j + 1, methodEnd + 1);

  let k = j - 1;
  while (k >= 0 && /\s/.test(text[k])) k--;
  const recvEnd = k;
  while (k >= 0 && /\w/.test(text[k])) k--;
  return { openParen, dotIndex, method, receiver: text.slice(k + 1, recvEnd + 1), receiverStart: k + 1 };
}

/** A tracked variable's inferred element type(s), or null if not a list/scalar. */
function inferredTypes(receiver: string): string[] | null {
  const inf = getInference(receiver);
  if (!inf || (inf.kind !== 'list' && inf.kind !== 'scalar')) return null;
  return inf.kind === 'list' ? inf.types : [inf.type];
}

/** Detect an enclosing accessor-method call around `at` (the start of the word
 *  being typed). Returns the receiver identifier when `at` is at a property-name
 *  argument position of an accessor method, else null. */
export function findAccessorCall(text: string, at: number): { receiver: string; method: string; receiverStart: number } | null {
  const call = enclosingCall(text, at);
  if (!call || !call.receiver) return null;
  const policy = ACCESSOR_METHODS[call.method];
  if (!policy) return null;

  // One forward walk for both the argument index and the current arg's start.
  let argIndex = 0;
  let argStart = call.openParen + 1;
  let d = 0;
  for (let k = call.openParen + 1; k < at; k++) {
    const c = text[k];
    if (c === '(') d++;
    else if (c === ')') d--;
    else if (c === ',' && d === 0) { argIndex++; argStart = k + 1; }
  }

  if (policy === 'first' && argIndex !== 0) return null;
  if (policy === 'rest' && argIndex === 0) return null;
  if (policy === 'first-pred') {
    if (argIndex !== 0) return null;
    // Value position inside the predicate (after a comparator) is not a prop name.
    if (VALUE_POS_RE.test(text.slice(argStart, at))) return null;
  }
  return { receiver: call.receiver, method: call.method, receiverStart: call.receiverStart };
}

/** Walk left from `from` over a method/property chain (`list.table().addColumn`)
 *  to the root identifier (`list`), skipping balanced `(...)` call args. Returns
 *  the root var name, or null. */
export function chainRoot(text: string, from: number): string | null {
  let i = from;
  for (;;) {
    while (i >= 0 && /\s/.test(text[i])) i--;
    if (i < 0) return null;
    if (text[i] === ')') {
      // Skip a balanced (...) so a call segment like `.table()` is stepped over.
      let d = 0;
      for (; i >= 0; i--) {
        if (text[i] === ')') d++;
        else if (text[i] === '(') { d--; if (d === 0) { i--; break; } }
      }
      continue;
    }
    if (!/\w/.test(text[i])) return null;
    const end = i;
    while (i >= 0 && /\w/.test(text[i])) i--;
    const ident = text.slice(i + 1, end + 1);
    // A `.` before this ident means it's a chain segment (method/prop) — keep
    // walking to the root. Otherwise this is the root variable.
    let k = i;
    while (k >= 0 && /\s/.test(text[k])) k--;
    if (k >= 0 && text[k] === '.') { i = k - 1; continue; }
    return ident || null;
  }
}

/** Resolve `self` (the implicit element inside table/addColumn/map/… bodies) to
 *  the element type(s) of the enclosing element-context call's receiver list.
 *  `selfAt` is the position of the `self` token. Returns null (fail silently)
 *  when there's no element-context call or its receiver isn't a tracked var. */
export function resolveSelfType(text: string, selfAt: number): string[] | null {
  const call = enclosingCall(text, selfAt);
  if (!call || !isElementContext(call.method)) return null;
  const root = chainRoot(text, call.dotIndex - 1);
  return root ? inferredTypes(root) : null;
}

/** The colon-bound lambda parameter of a call: `coll.forEach(_p: …)` → `_p`. Null when the first token
 *  after `(` isn't an `<ident>:` (so a plain method-arg call like `.filter(x = 1)` returns null). */
function lambdaParam(text: string, openParen: number): string | null {
  let i = openParen + 1;
  while (i < text.length && /\s/.test(text[i])) i++;
  const start = i;
  while (i < text.length && /\w/.test(text[i])) i++;
  if (i === start) return null;
  const name = text.slice(start, i);
  while (i < text.length && /\s/.test(text[i])) i++;
  return text[i] === ':' ? name : null;
}

/** Resolve a NAMED loop/lambda variable (`_count.forEach(_risk: … _risk.<prop>)`) to its element type —
 *  the same element type `self` resolves to, just bound to a name. Walks OUTWARD through enclosing calls
 *  so a variable bound by an outer lambda (`…children().forEach(_cat: … forEach(_risk: … _cat …))`) still
 *  resolves. Fail-silent (returns null) when `ident` isn't a bound param or its receiver isn't tracked. */
export function resolveLambdaParamType(text: string, identAt: number, ident: string): string[] | null {
  let pos = identAt;
  for (let depth = 0; depth < 8; depth++) { // bound nesting depth
    const call = enclosingCall(text, pos);
    if (!call) return null;
    if (isElementContext(call.method) && lambdaParam(text, call.openParen) === ident) {
      const root = chainRoot(text, call.dotIndex - 1);
      return root ? inferredTypes(root) : null;
    }
    pos = call.openParen; // step out to the next enclosing call
  }
  return null;
}

/** Detect a `SELECT <Class> … WHERE <prop>` property-name position. `window` is
 *  the source text up to the start of the word being typed. Returns the SELECT
 *  class, or null if not in a WHERE property-name slot. */
export function findWhereClass(window: string): string | null {
  const sels = [...window.matchAll(/\bSELECT\s+([A-Za-z_]\w*)/gi)];
  if (!sels.length) return null;
  const last = sels[sels.length - 1];
  const afterSel = window.slice(last.index + last[0].length);
  if (!/\bWHERE\b/i.test(afterSel)) return null;
  // Value-position guard: in the current condition (after the last WHERE/AND/OR),
  // if a comparator already appeared we're typing the value, not a property.
  const conds = afterSel.split(/\b(?:WHERE|AND|OR)\b/i);
  if (VALUE_POS_RE.test(conds[conds.length - 1])) return null;
  return last[1];
}

/** (D) General `<object>.<prop>` dot-member position. The unifying "identify the
 *  object on the left of the dot" resolver: returns the SINGLE object's type(s)
 *  — or a `ref` string to resolve async — when the expression immediately left of
 *  the dot at `wordStart` denotes one object. Handles:
 *    - scalar var          `_obj.`              → its inferred type
 *    - pick-one chain      `_l.first().`        → the list's element type
 *    - ancestor cast       `_o.ancestor(T).`    → T
 *    - self                `self.`              → enclosing list element type
 *    - ns.bid reference    `ceras.foo.`         → resolved async via getRefType
 *    - CONCRETE nested hop `ceras.foo.parent.`  → resolved async (≤ MAX_REF_HOPS)
 *  Returns null for list receivers (those want methods — extendedCompletions owns
 *  that) and for nested hops off a NON-concrete base (`_obj.someRef.` /
 *  `_l.first().parent.`): resolving those would require a SELECT scan, which we
 *  refuse so a big workspace can't be hammered. Nested hops silently yield nothing
 *  when the reference is empty on the object — by design. `wordStart` is line-local
 *  (member access never wraps lines). */
export function resolveDotMember(text: string, wordStart: number): { types?: string[]; ref?: string } | null {
  if (wordStart < 1 || text[wordStart - 1] !== '.') return null;
  let i = wordStart - 2; // char before the dot
  while (i >= 0 && /\s/.test(text[i])) i--;
  if (i < 0) return null;

  // ── Call-chain receiver: `… .first()` / `.last()` / `.item(n)` / `.ancestor(T)`.
  if (text[i] === ')') {
    let depth = 0;
    let j = i;
    for (; j >= 0; j--) {
      if (text[j] === ')') depth++;
      else if (text[j] === '(') { depth--; if (depth === 0) break; }
    }
    if (j < 0) return null;
    const argText = text.slice(j, i + 1); // `(...)` of the last call
    let m = j - 1;
    while (m >= 0 && /\s/.test(text[m])) m--;
    const methodEnd = m;
    while (m >= 0 && /\w/.test(text[m])) m--;
    const method = text.slice(m + 1, methodEnd + 1);
    if (m < 0 || text[m] !== '.') return null; // not a `.method()` call

    // `.ancestor(T)` → scalar of the argument type, independent of the receiver.
    if (method === 'ancestor') {
      const arg = /^\(\s*([A-Za-z][A-Za-z0-9_]*)\s*\)$/.exec(argText.trim());
      return arg ? { types: [pascal(arg[1])] } : null;
    }
    // Pick-one collapse: element type = the root list var's element type.
    if (isPickOne(method)) {
      const root = chainRoot(text, m - 1);
      const types = root ? inferredTypes(root) : null;
      return types ? { types } : null;
    }
    // filter/sort/children/descendants/… stay lists — offer methods, not props.
    return null;
  }

  // ── Dotted-identifier receiver: ns.bid[.accessor…] | self | scalar var.
  // Take the maximal trailing dotted identifier path left of the dot. A call
  // (`(`/`)`) or any non-[\w.] char terminates the match, so a list- or
  // call-rooted receiver (`_l.first().parent`) never lands here — it's handled
  // by the call-chain branch above or rejected.
  if (!/[\w.]/.test(text[i])) return null;
  const pathMatch = /[A-Za-z_][\w.]*$/.exec(text.slice(0, i + 1));
  if (!pathMatch) return null;
  const segs = pathMatch[0].split('.');
  if (segs.some(s => s.length === 0)) return null; // trailing/double dot — not a path

  // ns.bid[.accessor…] — a CONCRETE single-object navigation from a known ID
  // space. Resolve its class async (one O(1) server nav, cached). This is the
  // ONLY nested-hop shape we resolve: a literal namespace root means no SELECT /
  // mass scan is ever needed. Depth is capped so the injected EC stays tiny.
  if (segs.length >= 2 && ID_SPACE_PREFIXES.has(segs[0])) {
    const hops = segs.length - 2; // accessors after `prefix.bid`
    if (hops > MAX_REF_HOPS) return null; // guardrail: bound navigation depth
    return { ref: pathMatch[0] };
  }

  // Standalone single identifier: `self`, a named loop var, or a tracked var.
  if (segs.length === 1) {
    const ident = segs[0];
    const identAt = i - ident.length + 1;
    if (ident === 'self') {
      const types = resolveSelfType(text, identAt);
      return types ? { types } : null;
    }
    // A colon-bound lambda parameter (`coll.forEach(_p: … _p.<prop>)`) resolves like `self` — to the
    // iterated collection's element type. Checked BEFORE the var table so a same-named outer assignment
    // can't shadow the loop binding inside its body.
    const lam = resolveLambdaParamType(text, identAt, ident);
    if (lam) return { types: lam };
    const inf = getInference(ident);
    // Only a SCALAR var is one object whose props we offer. A list var at a bare
    // dot wants methods (.first/.filter/…), owned by extendedCompletions. A
    // variable assigned from a concrete object ref keeps that ref while its
    // class is unresolved, so it can use the same lazy two-stage resolver as
    // typing `t.foo.` directly.
    if (inf?.kind === 'scalar') return { types: [inf.type] };
    if (inf?.kind === 'unknown' && inf.ref) return { ref: inf.ref };
    return null;
  }

  // Multi-segment without a known namespace root (`_obj.someRef.`): a nested hop
  // off a non-concrete base. The base isn't a single resolvable object and the
  // target class is data-dependent — deliberately unsupported (no mass scan).
  return null;
}

/** Resolve the applicable class(es) + the word-start offset at the cursor, or
 *  null when the cursor is not at a property-accessor position. */
function resolveContext(state: CompletionContext['state'], pos: number): { types?: string[]; ref?: string; from: number; method?: string; member?: boolean } | null {
  const line = state.doc.lineAt(pos);
  const offset = pos - line.from;
  if (insideString(line.text, offset)) return null;

  const wordMatch = /[A-Za-z_]\w*$/.exec(line.text.slice(0, offset));
  const word = wordMatch ? wordMatch[0] : '';
  const wordStart = offset - word.length;
  const from = line.from + wordStart;

  // (A) method-argument accessor position (line-local — EC calls don't wrap).
  const call = findAccessorCall(line.text, wordStart);
  if (call) {
    // `self` resolves to the enclosing element-context call's element type;
    // any other receiver must be a tracked variable. resolveSelfType indexes
    // into the line-local text, so pass the line-local receiverStart (NOT a
    // doc offset — that broke self resolution on any line after the first).
    const types = call.receiver === 'self'
      ? resolveSelfType(line.text, call.receiverStart)
      : inferredTypes(call.receiver);
    if (!types) return null;
    return { types, from, method: call.method };
  }

  // (D) General `<object>.<prop>` dot-member — the unified resolver. Covers
  // `self.title`, a scalar var's `_obj.title`, a pick-one chain
  // `_list.first().title`, a named loop var `_risk.title` inside a multi-line
  // `forEach`, and a `ns.bid` reference `ceras.foo.title` (async). The dot-parse
  // itself is line-bounded (a newline terminates the receiver path), but the
  // self/lambda resolver walks LEFT to the enclosing call — which can be lines
  // above — so it's fed a window back from the cursor (bounded for perf; a
  // forEach more than ~4k chars back falls back to no completion). Composes with
  // extendedCompletions, which adds the method list after the dot.
  const dotWin = Math.max(0, from - 4000);
  const member = resolveDotMember(state.doc.sliceString(dotWin, pos), from - dotWin);
  if (member) return { ...member, from, member: true };

  // (B) WHERE property-name position. Scan a bounded window back from the word
  // so a SELECT on a previous line is still found, without walking the whole doc.
  const winStart = Math.max(0, from - 400);
  const cls = findWhereClass(state.doc.sliceString(winStart, from));
  if (cls) return { types: [pascal(cls)], from };

  return null;
}

function lookup(types: string[]): TypeSchemaProp[] | undefined {
  return types.length > 1 ? intersectionSchema(types) : getSchema(types[0]);
}

function build(props: TypeSchemaProp[], from: number, method?: string, member?: boolean): CompletionResult | null {
  const filtered = method ? props.filter(p => propFilterFor(method)(p.configClass)) : props;
  if (!filtered.length) return null;
  return {
    from,
    options: filtered.map(p => ({
      label: p.accessor,
      detail: p.label || (p.systemobject ? 'system' : 'property'),
      type: 'property',
      // Custom props always rank above system ones (id/name/parent/…). In a
      // `obj.` DOT-MEMBER position the user explicitly referenced an object and
      // wants its fields, so the WHOLE property set outranks the generic method
      // list that extendedCompletions adds at boost 0 (custom +2, system +1) —
      // otherwise an object with only system props (e.g. Organisation) buries
      // `name`/`id`/`location` below ~30 methods. In a WHERE / method-arg slot
      // there are no competing methods, so the original ±1 split is kept.
      boost: member ? (p.systemobject ? 1 : 2) : (p.systemobject ? -1 : 1),
    })),
    validFor: /^[\w]*$/,
  };
}

/** Shared async shell for the cache-backed sources: return `tryBuild()` if the
 *  data is already cached; else kick `ensure()` and resolve once a typeInference
 *  `notify()` makes it available. `giveUp()` (optional) short-circuits to null
 *  when we can prove the data will never match (e.g. options loaded but the prop
 *  isn't a list). 2s timeout + abort handling so nothing leaks or dangles.
 *
 *  `ensure()` is idempotent (every cache-fill it calls guards on has/inflight)
 *  and is re-run on each `notify()` so MULTI-STAGE sources make progress: the
 *  dot-member ref path first resolves `ns.bid` → class, and only the next
 *  `ensure()` pass — now that the class is known — fetches that class's schema. */
function awaitCompletion(
  context: CompletionContext,
  tryBuild: () => CompletionResult | null,
  ensure: () => void,
  giveUp?: () => boolean,
): CompletionResult | Promise<CompletionResult | null> | null {
  const ready = tryBuild();
  if (ready) return ready;
  if (giveUp && giveUp()) return null;
  ensure();
  return new Promise<CompletionResult | null>((resolve) => {
    const timeout = setTimeout(() => { cleanup(); resolve(null); }, 2000);
    const unsubscribe = subscribe(() => {
      if (context.aborted) { cleanup(); resolve(null); return; }
      const r = tryBuild();
      if (r) { cleanup(); resolve(r); return; }
      if (giveUp && giveUp()) { cleanup(); resolve(null); return; }
      ensure(); // advance to the next stage now that more data has landed
    });
    const cleanup = () => { clearTimeout(timeout); unsubscribe(); };
  });
}

/** Concrete type(s) for a resolveContext result: the synchronous `types`, or the
 *  class a `ns.bid` ref has resolved to (undefined until HOVER_RESOLVE lands). */
function ctxTypes(ctx: { types?: string[]; ref?: string }): string[] | undefined {
  if (ctx.types) return ctx.types;
  if (ctx.ref) { const t = getRefType(ctx.ref); if (t) return [t]; }
  return undefined;
}

export function propertyCompletions(context: CompletionContext): CompletionResult | Promise<CompletionResult | null> | null {
  const ctx = resolveContext(context.state, context.pos);
  if (!ctx) return null;
  return awaitCompletion(
    context,
    () => { const ts = ctxTypes(ctx); if (!ts) return null; const p = lookup(ts); return p ? build(p, ctx.from, ctx.method, ctx.member) : null; },
    () => {
      // Stage 1 (ref path only): resolve ns.bid → class. Stage 2: fetch schema
      // once the class is known. ensure() re-runs per notify, so both progress.
      if (ctx.ref) ensureRefType(ctx.ref);
      const ts = ctxTypes(ctx);
      if (ts) ts.forEach(ensureSchemaNow);
    },
  );
}

// ── Value autocomplete: list/tag option values (t.<businessId>) ──────────────

/** Operators that introduce a value to the right (so the token after them is a
 *  comparison value, not a property name). Word operators are matched separately. */
const COMPARATORS = new Set(['=', '!=', '<', '>', '<=', '>=']);

/** Parse a `<accessor> <op> <value-partial>` comparison ending at `offset`.
 *  Returns the accessor, where it starts, and where the value token starts (so a
 *  half-typed `t.ma` is replaced wholesale). null when the cursor isn't right of
 *  a comparator. */
export function parseComparison(text: string, offset: number): { accessor: string; accessorStart: number; valueStart: number } | null {
  // Value token: scan left over identifier/ref chars (covers `t.master`).
  let v = offset;
  while (v > 0 && /[\w.]/.test(text[v - 1])) v--;
  const valueStart = v;

  // Operator immediately left of the value (skipping spaces).
  let i = valueStart - 1;
  while (i >= 0 && /\s/.test(text[i])) i--;
  if (i < 0) return null;

  let afterOp: number; // index just left of the operator
  const two = text.slice(i - 1, i + 1);
  if (COMPARATORS.has(two)) afterOp = i - 2;
  else if (COMPARATORS.has(text[i])) afterOp = i - 1;
  else {
    // Word operator: CONTAINS / IN.
    let w = i;
    while (w >= 0 && /\w/.test(text[w])) w--;
    const word = text.slice(w + 1, i + 1).toUpperCase();
    if (word !== 'CONTAINS' && word !== 'IN') return null;
    afterOp = w;
  }

  // Accessor immediately left of the operator.
  let a = afterOp;
  while (a >= 0 && /\s/.test(text[a])) a--;
  const accEnd = a;
  while (a >= 0 && /\w/.test(text[a])) a--;
  const accessor = text.slice(a + 1, accEnd + 1);
  if (!accessor) return null;
  return { accessor, accessorStart: a + 1, valueStart };
}

/** The receiver of an enclosing `.filter(` around `at`, or null. */
function enclosingFilterReceiver(text: string, at: number): string | null {
  const call = enclosingCall(text, at);
  return call && call.method === 'filter' && call.receiver ? call.receiver : null;
}

/** Resolve the option set + replace-range when the cursor is at a list/tag
 *  comparison value position (filter, dot-member, or WHERE), or null. Mirrors the
 *  property-NAME resolver's branches: `types` is synchronous, `ref` (a ns.bid
 *  receiver) resolves async via getRefType — same two-stage shape as resolveContext. */
function resolveValueContext(state: CompletionContext['state'], pos: number): { types?: string[]; ref?: string; accessor: string; from: number } | null {
  const line = state.doc.lineAt(pos);
  const offset = pos - line.from;
  // List/tag values are `t.<id>` refs, never string literals — skip inside quotes.
  if (insideString(line.text, offset)) return null;

  const cmp = parseComparison(line.text, offset);
  if (!cmp) return null;
  const from = line.from + cmp.valueStart;
  const accAbs = line.from + cmp.accessorStart;

  // (A) inside a .filter(...) predicate — class from the receiver var.
  // accessorStart is line-local (parseComparison ran on line.text), so pass it
  // straight to the line-local walker — NOT a doc offset.
  const recv = enclosingFilterReceiver(line.text, cmp.accessorStart);
  if (recv) {
    const types = inferredTypes(recv);
    return types ? { types, accessor: cmp.accessor, from } : null;
  }

  // (C) dot-member accessor — `_risk.first().riskclass = `, `self.x = `, `_obj.x = `,
  // `ceras.foo.x = `. The SAME resolver the property-NAME path uses identifies the
  // receiver's class (loop vars, pick-one chains, self, ns.bid refs). The receiver
  // parse is line-bounded, but self/lambda resolution walks LEFT to the enclosing
  // call — often lines above — so feed it a bounded window ending at the accessor.
  if (cmp.accessorStart > 0 && line.text[cmp.accessorStart - 1] === '.') {
    const dotWin = Math.max(0, accAbs - 4000);
    const member = resolveDotMember(state.doc.sliceString(dotWin, accAbs), accAbs - dotWin);
    if (member) return { ...member, accessor: cmp.accessor, from };
  }

  // (B) SELECT … WHERE — the accessor position is a property-name slot, so
  // findWhereClass resolves the SELECT class when fed the window up to it.
  const winStart = Math.max(0, accAbs - 400);
  const cls = findWhereClass(state.doc.sliceString(winStart, accAbs));
  if (cls) return { types: [pascal(cls)], accessor: cmp.accessor, from };

  return null;
}

function lookupOption(types: string[], accessor: string): TypeOptionSet | undefined {
  for (const t of types) {
    const o = getOption(t, accessor);
    if (o) return o;
  }
  return undefined;
}

function buildValueResult(opt: TypeOptionSet, from: number): CompletionResult | null {
  if (!opt.items.length) return null;
  return {
    from,
    options: opt.items.map(it => ({
      label: it.ref,            // e.g. `t.master`
      displayLabel: it.ref,
      detail: it.name,          // e.g. "Master"
      apply: it.ref,
      type: 'enum',
      boost: 1,
    })),
    validFor: /^[\w.]*$/,
  };
}

export function valueCompletions(context: CompletionContext): CompletionResult | Promise<CompletionResult | null> | null {
  const ctx = resolveValueContext(context.state, context.pos);
  if (!ctx) return null;
  return awaitCompletion(
    context,
    () => { const ts = ctxTypes(ctx); if (!ts) return null; const o = lookupOption(ts, ctx.accessor); return o ? buildValueResult(o, ctx.from) : null; },
    () => {
      // Stage 1 (ref receiver only): resolve ns.bid → class. Stage 2: fetch that
      // class's option sets once known. ensure() re-runs per notify, so both progress.
      if (ctx.ref) ensureRefType(ctx.ref);
      const ts = ctxTypes(ctx);
      if (ts) ts.forEach(ensureOptionsNow);
    },
    // Give up early when options are loaded for every type and none carries a
    // set for this accessor (→ not a list/tag property; don't wait out the
    // timeout). Empty ref lookups are not terminal: they may have raced startup.
    () => {
      const ts = ctxTypes(ctx);
      return !!ts && ts.every(t => getOptions(t) !== undefined);
    },
  );
}
