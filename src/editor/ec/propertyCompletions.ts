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
import { getInference, getSchema, intersectionSchema, ensureSchemaNow, getOption, getOptions, ensureOptionsNow, subscribe } from './typeInference';

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
};

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

/** Detect an enclosing accessor-method call around `at` (the start of the word
 *  being typed). Returns the receiver identifier when `at` is at a property-name
 *  argument position of an accessor method, else null. */
export function findAccessorCall(text: string, at: number): { receiver: string; method: string } | null {
  // Walk left, paren-aware, to the open paren that encloses `at`.
  let depth = 0;
  let lastComma = -1;
  let i = at - 1;
  for (; i >= 0; i--) {
    const c = text[i];
    if (c === ')') depth++;
    else if (c === '(') {
      if (depth === 0) break;
      depth--;
    } else if (depth === 0 && c === ',' && lastComma < 0) {
      lastComma = i; // first comma walking left = boundary of the current arg
    }
  }
  if (i < 0) return null; // no enclosing call
  const openParen = i;

  // Read `.method` immediately left of the open paren.
  let j = openParen - 1;
  while (j >= 0 && /\s/.test(text[j])) j--;
  const methodEnd = j;
  while (j >= 0 && /\w/.test(text[j])) j--;
  if (j < 0 || text[j] !== '.') return null;
  const method = text.slice(j + 1, methodEnd + 1);
  const policy = ACCESSOR_METHODS[method];
  if (!policy) return null;

  // Argument index = number of top-level commas before the cursor.
  const argStart = lastComma >= 0 ? lastComma + 1 : openParen + 1;
  let commaCount = 0;
  {
    let d = 0;
    for (let k = openParen + 1; k < at; k++) {
      const c = text[k];
      if (c === '(') d++;
      else if (c === ')') d--;
      else if (c === ',' && d === 0) commaCount++;
    }
  }
  const argIndex = commaCount;

  if (policy === 'first' && argIndex !== 0) return null;
  if (policy === 'rest' && argIndex === 0) return null;
  if (policy === 'first-pred') {
    if (argIndex !== 0) return null;
    // Value position inside the predicate (after a comparator) is not a prop name.
    if (VALUE_POS_RE.test(text.slice(argStart, at))) return null;
  }

  // Receiver identifier immediately left of `.method` (last chain component).
  let k = j - 1;
  while (k >= 0 && /\s/.test(text[k])) k--;
  const recvEnd = k;
  while (k >= 0 && /\w/.test(text[k])) k--;
  const receiver = text.slice(k + 1, recvEnd + 1);
  if (!receiver) return null;
  return { receiver, method };
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

/** Resolve the applicable class(es) + the word-start offset at the cursor, or
 *  null when the cursor is not at a property-accessor position. */
function resolveContext(state: CompletionContext['state'], pos: number): { types: string[]; from: number } | null {
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
    const inf = getInference(call.receiver);
    if (!inf || (inf.kind !== 'list' && inf.kind !== 'scalar')) return null;
    const types = inf.kind === 'list' ? inf.types : [inf.type];
    return { types, from };
  }

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

function build(props: TypeSchemaProp[], from: number): CompletionResult | null {
  if (!props.length) return null;
  return {
    from,
    options: props.map(p => ({
      label: p.accessor,
      detail: p.label || (p.systemobject ? 'system' : 'property'),
      type: 'property',
      // Custom properties rank above system ones (id/name/parent/…).
      boost: p.systemobject ? -1 : 1,
    })),
    validFor: /^[\w]*$/,
  };
}

export function propertyCompletions(context: CompletionContext): CompletionResult | Promise<CompletionResult | null> | null {
  const { state, pos } = context;
  const ctx = resolveContext(state, pos);
  if (!ctx) return null;

  const ready = lookup(ctx.types);
  if (ready) return build(ready, ctx.from);

  // Schema not cached yet — fetch eagerly and resolve once it arrives (mirrors
  // starExpansion). CodeMirror waits briefly for an async source.
  for (const t of ctx.types) ensureSchemaNow(t);
  return new Promise<CompletionResult | null>((resolve) => {
    const timeout = setTimeout(() => { cleanup(); resolve(null); }, 2000);
    const unsubscribe = subscribe(() => {
      if (context.aborted) { cleanup(); resolve(null); return; }
      const p = lookup(ctx.types);
      if (!p) return;
      cleanup();
      resolve(build(p, ctx.from));
    });
    const cleanup = () => { clearTimeout(timeout); unsubscribe(); };
  });
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

/** The receiver of an enclosing `.filter(` around `at`, or null. Paren-aware. */
function enclosingFilterReceiver(text: string, at: number): string | null {
  let depth = 0;
  let i = at - 1;
  for (; i >= 0; i--) {
    const c = text[i];
    if (c === ')') depth++;
    else if (c === '(') { if (depth === 0) break; depth--; }
  }
  if (i < 0) return null;
  let j = i - 1;
  while (j >= 0 && /\s/.test(text[j])) j--;
  const methodEnd = j;
  while (j >= 0 && /\w/.test(text[j])) j--;
  if (j < 0 || text[j] !== '.') return null;
  if (text.slice(j + 1, methodEnd + 1) !== 'filter') return null;
  let k = j - 1;
  while (k >= 0 && /\s/.test(text[k])) k--;
  const recvEnd = k;
  while (k >= 0 && /\w/.test(text[k])) k--;
  const receiver = text.slice(k + 1, recvEnd + 1);
  return receiver || null;
}

/** Resolve the option set + replace-range when the cursor is at a list/tag
 *  comparison value position (WHERE or filter), or null. */
function resolveValueContext(state: CompletionContext['state'], pos: number): { types: string[]; accessor: string; from: number } | null {
  const line = state.doc.lineAt(pos);
  const offset = pos - line.from;
  // List/tag values are `t.<id>` refs, never string literals — skip inside quotes.
  if (insideString(line.text, offset)) return null;

  const cmp = parseComparison(line.text, offset);
  if (!cmp) return null;
  const from = line.from + cmp.valueStart;

  // (A) inside a .filter(...) predicate — class from the receiver var.
  const recv = enclosingFilterReceiver(line.text, line.from + cmp.accessorStart);
  if (recv) {
    const inf = getInference(recv);
    if (!inf || (inf.kind !== 'list' && inf.kind !== 'scalar')) return null;
    const types = inf.kind === 'list' ? inf.types : [inf.type];
    return { types, accessor: cmp.accessor, from };
  }

  // (B) SELECT … WHERE — the accessor position is a property-name slot, so
  // findWhereClass resolves the SELECT class when fed the window up to it.
  const accAbs = line.from + cmp.accessorStart;
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
  const { state, pos } = context;
  const ctx = resolveValueContext(state, pos);
  if (!ctx) return null;

  const ready = lookupOption(ctx.types, ctx.accessor);
  if (ready) return buildValueResult(ready, ctx.from);

  // Options already loaded for every type but no set for this accessor → it's
  // not a list/tag property; decline immediately rather than hang.
  const allLoaded = (): boolean => ctx.types.every(t => getOptions(t) !== undefined);
  if (allLoaded()) return null;

  // Not cached yet — fetch and resolve on arrival (graceful degradation).
  for (const t of ctx.types) ensureOptionsNow(t);
  return new Promise<CompletionResult | null>((resolve) => {
    const timeout = setTimeout(() => { cleanup(); resolve(null); }, 2000);
    const unsubscribe = subscribe(() => {
      if (context.aborted) { cleanup(); resolve(null); return; }
      const o = lookupOption(ctx.types, ctx.accessor);
      if (o) { cleanup(); resolve(buildValueResult(o, ctx.from)); return; }
      if (allLoaded()) { cleanup(); resolve(null); } // loaded, but not a list/tag prop
    });
    const cleanup = () => { clearTimeout(timeout); unsubscribe(); };
  });
}
