/**
 * EC variable type inference for the Vars + Properties panel.
 *
 * Walks the editor doc, finds `_name := <expr>` assignments, and
 * classifies the RHS to infer the var's runtime type. Two layers:
 *
 *   - SYNCHRONOUS pass over the doc, no I/O: produces TypeInference
 *     stubs for every assignment. For SELECT / .children(T) / chains
 *     this is already definitive (the type name is right there).
 *
 *   - ASYNC resolvers fired only when a `root.<lcCategory>.children()`
 *     pattern appears — one EC call per category, cached forever.
 *
 * The scanner is debounced (~500 ms) so a fast typist doesn't trigger
 * a fetch storm. Bridge fetches are capped at 3 in flight.
 *
 * What this MODULE owns:
 *   - parsing RHS shapes from the doc
 *   - keeping the var → inference Map up to date
 *   - asking the SW for fresh schemas (via FETCH_TYPE_SCHEMA)
 *   - exposing read APIs for the Vars panel renderer
 *
 * What it does NOT own:
 *   - UI rendering (panel side does that)
 *   - the cache itself (lives in src/lib/type-schema-cache.ts in the SW)
 */
import { EditorView } from '@codemirror/view';
import type { ViewUpdate } from '@codemirror/view';
import { sendRequest } from '../../lib/messaging';
import type { InspectorMessage, TypeSchemaProp, TypeOptionSet } from '../../lib/types';
import { ID_SPACE_PREFIXES } from '../../lib/ec-grammar';
import { intersectTypeSchemas } from '../../lib/type-schema-utils';

export type TypeInference =
  | { kind: 'list'; types: string[]; line: number }     // List<T> or List<T1|T2|...> for multi-type
  | { kind: 'scalar'; type: string; line: number; loopVar?: boolean }  // single object; loopVar → bound by a lambda (foreach/map/…)
  | { kind: 'primitive'; primitive: 'string' | 'number' | 'date' | 'bool'; line: number }
  | { kind: 'unknown'; reason: string; line: number; ref?: string };

const RESERVED = new Set([
  'if', 'then', 'else', 'elseif', 'endif', 'select', 'from', 'where', 'return',
  'transactional', 'and', 'or', 'not', 'in', 'contains', 'true', 'false', 'missing',
  'root', 'this', 'self', 'today', 'bop', 'eop',
]);

// `_name := <rhs>` at start-of-line (optional indent).
const ASSIGN_RE = /^\s*([A-Za-z_]\w*)\s*:=\s*(.+?)\s*$/;

// Cardinality-keeping chain methods — same element type as the receiver.
const PRESERVE_CHAIN = new Set([
  'filter', 'sort', 'sortReverse', 'reverse', 'distinct',
]);
// Methods that collapse a list to ONE element (same type).
const PICK_ONE_CHAIN = new Set([ 'first', 'last' ]);
// Methods whose argument is a class name → result is List<arg> for
// `.children(T)` / `.descendants(T)` or scalar `T` for `.ancestor(T)`.
const TYPED_NAV_LIST = new Set([ 'children', 'descendants' ]);
const TYPED_NAV_SCALAR = new Set([ 'ancestor' ]);

/** Methods whose `(_x: …)` arg binds an ELEMENT of the receiver collection —
 *  the lambda-param context (`coll.forEach(_x: …)`, `.map`, `.filter`, …).
 *  EC method names are case-insensitive, so this is lowercase and matched via
 *  `isElementContext`. Exported as the SINGLE source of "what is a loop binder",
 *  shared by the completer (propertyCompletions) and the doc-scan below so the
 *  Vars panel and autocomplete never disagree about loop variables. */
export const ELEMENT_CONTEXT_METHODS = new Set([
  'table', 'addcolumn', 'addrow', 'map', 'foreach', 'filter', 'calculate',
  'as', 'sort', 'sortreverse', 'groupby', 'distinct', 'sum', 'avg', 'min', 'max', 'count',
]);
export const isElementContext = (method: string): boolean => ELEMENT_CONTEXT_METHODS.has(method.toLowerCase());

// A lambda binding `<receiver>.<method>( _param :` — receiver is a chain root
// var/ref plus zero+ dotted (optionally one-paren) segments; param is `_`-prefixed
// (EC convention) so MAP/JSON `key:` literals don't false-match.
export const LAMBDA_BIND_RE = /(\b[A-Za-z_]\w*(?:\.\w+(?:\([^()]*\))?)*)\.([A-Za-z]\w*)\s*\(\s*(_\w+)\s*:/g;

interface InferenceState {
  /** name → inference. Map order = doc order; later assignments overwrite. */
  vars: Map<string, TypeInference>;
  /** className → fetched props. Populated as the panel requests schemas. */
  schemas: Map<string, TypeSchemaProp[]>;
  /** className → last-seen error reason WITH an expiry.
   *
   *  The Vars panel reads `getSchemaError` to render an explicit
   *  "fetch failed" state instead of looping on "Loading…" forever.
   *  Errors used to be permanent: a bridge restart mid-session left
   *  every previously-failed schema cached as broken until the user
   *  manually hit Refresh — same psychology as the hover-tooltip
   *  cache bug. Now each error carries an `expiresAt`; once past, the
   *  next render-path check treats it as absent and a fresh fetch is
   *  scheduled. Successful fetches still cache forever (in `schemas`)
   *  because object class identity doesn't drift while the editor is
   *  open. */
  schemaErrors: Map<string, { message: string; expiresAt: number }>;
  /** Set of types we've requested but haven't received yet — prevents
   *  request floods when the doc references the same type repeatedly. */
  inflight: Set<string>;
}

/** Lifetime of a negative schema-error entry. 30 s is long enough to
 *  avoid hammering the bridge on every keystroke while a real outage
 *  is happening, short enough that a bridge restart self-heals on the
 *  next render after the user notices. */
const SCHEMA_ERROR_TTL_MS = 30_000;

const state: InferenceState = {
  vars: new Map(),
  schemas: new Map(),
  schemaErrors: new Map(),
  inflight: new Set(),
};

/** Internal — has a CURRENT (non-expired) error for this class? */
function hasCurrentSchemaError(className: string): boolean {
  const key = lc(className);
  const entry = state.schemaErrors.get(key);
  if (!entry) return false;
  if (Date.now() >= entry.expiresAt) {
    state.schemaErrors.delete(key);
    return false;
  }
  return true;
}

/** Internal — record a fresh failure with a TTL. */
function recordSchemaError(className: string, message: string): void {
  state.schemaErrors.set(lc(className), {
    message,
    expiresAt: Date.now() + SCHEMA_ERROR_TTL_MS,
  });
}

/** Last-known fetch error for a class — read by the Vars panel to
 *  show a retryable error state. Treats expired entries as absent so
 *  the UI doesn't paint a stale "broken" message after the TTL. */
export function getSchemaError(className: string): string | undefined {
  const key = lc(className);
  const entry = state.schemaErrors.get(key);
  if (!entry) return undefined;
  if (Date.now() >= entry.expiresAt) {
    state.schemaErrors.delete(key);
    return undefined;
  }
  return entry.message;
}

let dirtyListeners: Set<() => void> = new Set();
function notify(): void { for (const l of dirtyListeners) l(); }

export function subscribe(fn: () => void): () => void {
  dirtyListeners.add(fn);
  return () => dirtyListeners.delete(fn);
}

export function getInference(name: string): TypeInference | undefined {
  return state.vars.get(name);
}
export function getAllInferences(): Map<string, TypeInference> {
  return state.vars;
}
export function getSchema(className: string): TypeSchemaProp[] | undefined {
  return state.schemas.get(lc(className));
}

/** Intersection of accessors across multiple types — used for
 *  multi-type SELECTs and `.merge`/`.union`. Returns the props
 *  array from the FIRST type, filtered to accessors present in ALL.
 *  When some types are not yet fetched, returns undefined so the
 *  caller can wait. */
export function intersectionSchema(types: string[]): TypeSchemaProp[] | undefined {
  if (types.length === 0) return [];
  if (types.length === 1) return state.schemas.get(lc(types[0]));
  const schemas = types.map(type => state.schemas.get(lc(type)));
  if (schemas.some(schema => !schema)) return undefined;
  return intersectTypeSchemas(schemas as TypeSchemaProp[][]);
}

// ── EC identifier shapes ──────────────────────────────────────────
// BMP class names are conventionally PascalCase and root categories
// lowerCamelCase, but BMP itself accepts either case in many places, so
// the inference is lenient: any leading [A-Za-z] is allowed and the
// real validity check is "does the schema fetch return props". Keyword
// tokens (SELECT/FROM) use explicit `[Ss][Ee]...` so a single /i flag
// on the full regex doesn't accidentally do anything else.
//
// `.children` / `.descendants` are accepted with OR without trailing
// `()` — users intuitively type the bare form while editing and the
// inference shouldn't punish them; BMP runtime tolerates both for the
// child-collection accessors.
const SELECT_RE = /^[Ss][Ee][Ll][Ee][Cc][Tt]\s+([A-Za-z][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z][A-Za-z0-9_]*)*)\b/;
const ROOT_NAV_RE = /^root\.([A-Za-z][A-Za-z0-9_]*)\.(?:children|descendants)(?:\s*\(\s*\))?\s*$/;
const TYPED_NAV_RE = /^[A-Za-z_]\w*(?:\.\w+(?:\([^)]*\))?)*\.(\w+)\s*\(\s*([A-Za-z][A-Za-z0-9_]*)\s*\)\s*$/;

/** A concrete `namespace.businessId` object reference with no property hops.
 *  Keep this aligned with the editor grammar's namespace list: the class can
 *  be resolved by the existing HOVER_RESOLVE path without scanning a type or
 *  collection. `o.<rid>` is deliberately excluded — RIDs are not valid EC
 *  object references even though the highlighter still recognises the legacy
 *  prefix. */
function concreteObjectRef(expression: string): string | null {
  const match = /^([a-z]{1,6})\.([A-Za-z0-9_]+)$/.exec(expression);
  if (!match || match[1] === 'o' || !ID_SPACE_PREFIXES.has(match[1])) return null;
  return match[0];
}

/** Canonicalise a captured BMP class-name into its PascalCase form.
 *
 *  EC's runtime is case-insensitive in many surfaces — `SELECT
 *  ceRiskAssessment` returns CeRiskAssessment instances just like
 *  `SELECT CeRiskAssessment` does — but the SCHEMA fetch path
 *  (FETCH_TYPE_SCHEMA → CorpoBeanInfo) is keyed on the exact Java
 *  class name, which is always PascalCase. So a user who writes
 *  `SELECT ceRiskAssessment` (an easy mistake; matches the root-
 *  category convention) used to get `list<ceRiskAssessment>`,
 *  and the schema fetch for that exact key returned nothing.
 *  Meanwhile `root.ceRiskAssessment.children()` already routed
 *  through the SW resolver and returned the canonical
 *  `CeRiskAssessment`, so schemas worked there. This bridges the
 *  asymmetry: every captured type name passes through here before
 *  it lands on the inference record.
 *
 *  Uppercase-first-letter is a heuristic — it's safe because every
 *  BMP class in the live workspace follows PascalCase. If a user
 *  invents a genuinely lowercase-first class name, BMP wouldn't
 *  recognise it either, so we wouldn't lose schema we could have
 *  fetched. */
function canonicalizeTypeName(name: string): string {
  if (!name) return name;
  const first = name[0];
  if (first >= 'a' && first <= 'z') return first.toUpperCase() + name.slice(1);
  return name;
}

// ── Case-insensitive type resolution ──────────────────────────────
// BMP resolves class names case-insensitively (`CeControlMeasure` ===
// `CECONTROLMEASURE` === `cecontrolmeasure`), but the editor used to key
// schemas + display labels by the EXACT casing the user typed — so an odd
// casing showed an unresolved / wrong-cased type in the Vars panel. We now
// key all schema state by a lowercased key (members resolve for any casing)
// and learn the canonical PascalCase from the schema fetch (`canonicalByLower`)
// for display.
const lc = (s: string): string => s.toLowerCase();

/** lowercased class name → canonical PascalCase (from FETCH_TYPE_SCHEMA).
 *  Not cleared on profile/server switch: a class's canonical casing is a
 *  property of the BMP type system, not the instance, so it doesn't drift
 *  across servers. Bounded by the number of distinct types typed in a
 *  session (negligible). Cleared in `_resetForTests`. */
const canonicalByLower = new Map<string, string>();

/** Best-known canonical display name for a class, regardless of input case.
 *  Falls back to the leading-lowercase fix until the schema fetch teaches us
 *  BMP's real casing. */
export function canonicalType(name: string): string {
  return canonicalByLower.get(lc(name)) ?? canonicalizeTypeName(name);
}

// ── Parse a single RHS expression into a TypeInference ─────────

/** `seenVars` is the in-progress scan output for THIS pass. Chain
 *  inference reads from it so that `_b := _a.first()` (line 2) can
 *  resolve `_a` declared on line 1 of the same scan, not the last
 *  scan's stale value. */
function parseRhs(rhs: string, line: number, seenVars: Map<string, TypeInference>): TypeInference {
  // Strip every layer of balanced outer parens so `((SELECT Foo))` and
  // `(((SELECT Foo)))` work the same as the unwrapped form. Live-verified
  // that EC accepts arbitrary paren depth around an expression. We don't
  // chew through parens that belong to a method-call's argument list —
  // the balance check on `s.length - 1` guards that.
  let s = rhs.trim();
  while (s.startsWith('(') && s.endsWith(')')) {
    let depth = 0, balanced = true;
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '(') depth++;
      else if (s[i] === ')') { depth--; if (depth === 0 && i < s.length - 1) { balanced = false; break; } }
    }
    if (!balanced || depth !== 0) break;
    s = s.slice(1, -1).trim();
  }

  // `IF cond THEN expr1 ELSE expr2 ENDIF` — EC only accepts this shape
  // on the RHS when wrapped in parens (the outer strip above peels them
  // off first). Both branches' types are returned in EC; ours is the
  // THEN branch's inferred type. Wrong-leaning only when the two
  // branches have genuinely different cardinalities — rare in practice.
  // The branch is re-parsed via this function so SELECT / nav / chain
  // inside the IF all flow through normally.
  const ifMatch = /^IF\b([\s\S]+?)\bTHEN\b([\s\S]+?)\bELSE\b([\s\S]+?)\bENDIF\s*$/i.exec(s);
  if (ifMatch) {
    const thenBranch = ifMatch[2].trim();
    // Recurse on the THEN branch with the same seenVars; the inner
    // expression gets full type-inference treatment.
    return parseRhs(thenBranch, line, seenVars);
  }

  // SELECT X[, Y, ...] [WHERE … FROM … ORDER BY …]
  // Keyword is case-insensitive; type name is BMP-runtime-case-insensitive
  // but schema-fetch-case-sensitive — canonicalise so a leading lowercase
  // (`SELECT ceRiskAssessment`) lands on the BeanInfo's PascalCase key.
  const sel = SELECT_RE.exec(s);
  if (sel) {
    const types = sel[1].split(/\s*,\s*/).filter(Boolean).map(canonicalizeTypeName);
    return { kind: 'list', types, line };
  }

  // root.<lcCategory>.children() / .descendants()
  const rootNav = ROOT_NAV_RE.exec(s);
  if (rootNav) {
    const cat = rootNav[1];
    // Local cache hit — answer synchronously. Each session walks the
    // doc many times; we don't want to round-trip to the SW more than
    // once per category.
    const cachedType = rootCategoryCache.get(cat);
    if (cachedType === null) {
      return { kind: 'unknown', reason: `root.${cat} resolved to no class`, line };
    }
    if (typeof cachedType === 'string') {
      return { kind: 'list', types: [cachedType], line };
    }
    // Schedule a debounced resolve — partial typing of `root.X.children()`
    // produces many distinct `cat` strings on the way to the final name;
    // we want exactly one BMP call per stable name, not one per keystroke.
    // The debouncer handles all the bookkeeping (per-name timers, inflight
    // dedup) so this site stays a pure schedule.
    requestRootCategory(cat);
    return { kind: 'unknown', reason: `resolving root.${cat}…`, line };
  }

  // <ident>.children(T) / .descendants(T) / .ancestor(T)
  // Same canonicalisation as SELECT — `_x.children(ceIssue)` should
  // produce `list<CeIssue>` so the schema fetch lands.
  const typedNav = TYPED_NAV_RE.exec(s);
  if (typedNav) {
    const method = typedNav[1];
    const argType = canonicalizeTypeName(typedNav[2]);
    if (TYPED_NAV_LIST.has(method)) return { kind: 'list', types: [argType], line };
    if (TYPED_NAV_SCALAR.has(method)) return { kind: 'scalar', type: argType, line };
  }

  // Concrete object reference (`t.some_template`, `ceras.some_risk`, …).
  // Resolution is lazy: scanning a large script must remain pure and must not
  // issue one request per reference. The completion or Vars-panel consumer
  // calls ensureRefType only when this inference is actually needed. Once the
  // shared cache knows the class, the next scan upgrades the variable to a
  // normal scalar and every existing property-completion path works unchanged.
  const objectRef = concreteObjectRef(s);
  if (objectRef) {
    const cachedType = getRefType(objectRef);
    if (cachedType) return { kind: 'scalar', type: cachedType, line };
    const refKind = objectRef.startsWith('t.') ? 'template reference' : 'object reference';
    return { kind: 'unknown', reason: `Resolve ${refKind} ${objectRef} to show its properties`, line, ref: objectRef };
  }

  // <tracked-var>.first() / .last() — collapse list → scalar
  const pickOne = /^([A-Za-z_]\w*)(?:\.\w+(?:\([^)]*\))?)*\.(\w+)\s*\(\s*\)\s*$/.exec(s);
  if (pickOne) {
    const baseName = pickOne[1];
    const method = pickOne[2];
    if (PICK_ONE_CHAIN.has(method)) {
      const base = seenVars.get(baseName);
      if (base && base.kind === 'list') return { kind: 'scalar', type: base.types[0], line };
      // Same base could be list-shaped at a future scan — leave as
      // unknown for now; the next scan will retry.
    }
    if (PRESERVE_CHAIN.has(method)) {
      const base = seenVars.get(baseName);
      if (base) return { ...base, line }; // copy type, refresh line
    }
  }

  // <tracked-var>.filter(...) / .sort(...) etc. — preserves type
  const preserve = /^([A-Za-z_]\w*)\.(\w+)\s*\(/.exec(s);
  if (preserve && PRESERVE_CHAIN.has(preserve[2])) {
    const base = seenVars.get(preserve[1]);
    if (base) return { ...base, line };
  }

  // <tracked-var>.merge(SELECT X) / .union(SELECT X) — intersection.
  // Inner regex follows the same case rules as the top-level SELECT_RE.
  const setOp = /^([A-Za-z_]\w*)\.(merge|union)\s*\(\s*(.+)\s*\)\s*$/.exec(s);
  if (setOp) {
    const baseName = setOp[1];
    const inner = setOp[3];
    const base = seenVars.get(baseName);
    if (base && base.kind === 'list') {
      const innerSel = /^SELECT\s+([A-Za-z][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z][A-Za-z0-9_]*)*)\b/i.exec(inner);
      const innerTypes = innerSel
        ? innerSel[1].split(/\s*,\s*/).filter(Boolean).map(canonicalizeTypeName)
        : [];
      if (innerTypes.length > 0) {
        const merged = Array.from(new Set([...base.types, ...innerTypes]));
        return { kind: 'list', types: merged, line };
      }
    }
  }

  // `_y.whenMissing(default)` — defaulting wrapper preserves the
  // receiver's type. The arg can be anything; we keep the chain by
  // unwrapping to its receiver and re-parsing.
  const whenMissing = /^(.+?)\.whenMissing\s*\(.*\)\s*$/.exec(s);
  if (whenMissing) {
    const inner = whenMissing[1].trim();
    // Only recurse when the receiver itself is a tracked var reference,
    // otherwise we'd parse `output(_o.expression).whenMissing("")` and
    // loop. The receiver is usually `_y` or `_y.prop` — match those.
    if (/^[A-Za-z_]\w*(?:\.\w+)?$/.test(inner)) {
      const base = seenVars.get(inner.split('.')[0]);
      if (base) return { ...base, line };
    }
    // Fallback: treat as string (most common — string defaulting).
    return { kind: 'primitive', primitive: 'string', line };
  }

  // `output(...)` — pretty-prints any value as a string. The canonical
  // way to read the RAW text of an `.expression` ref (bare `.expression`
  // EVALUATES the code, `output(.expression)` returns it).
  if (/^output\s*\(/i.test(s)) {
    return { kind: 'primitive', primitive: 'string', line };
  }

  // `_y.size()` / `.indexOf(...)` — numeric results from a tracked var.
  // Useful in the Vars panel so size/indexOf don't render as "unknown".
  const sizeOrIndex = /^[A-Za-z_]\w*(?:\.\w+(?:\([^)]*\))?)*\.(size|indexOf|length|count)\s*\(/.exec(s);
  if (sizeOrIndex) return { kind: 'primitive', primitive: 'number', line };

  // `_y.toString()` / `.format(...)` — string results.
  const stringMethod = /^[A-Za-z_]\w*(?:\.\w+(?:\([^)]*\))?)*\.(toString|format|substring|toUpperCase|toLowerCase|replace|trim)\s*\(/.exec(s);
  if (stringMethod) return { kind: 'primitive', primitive: 'string', line };

  // Bare-var copy: `_x := _y` passes through `_y`'s inferred type.
  const bareVar = /^([A-Za-z_]\w*)\s*$/.exec(s);
  if (bareVar) {
    const base = seenVars.get(bareVar[1]);
    if (base) return { ...base, line };
  }

  // Primitive literals (low priority — used to flag "no schema").
  if (/^-?\d+(\.\d+)?$/.test(s)) return { kind: 'primitive', primitive: 'number', line };
  if (/^"[^"]*"$|^'[^']*'$/.test(s)) return { kind: 'primitive', primitive: 'string', line };
  if (/^(True|False|TRUE|FALSE|true|false)$/.test(s)) return { kind: 'primitive', primitive: 'bool', line };
  if (/^(today|TODAY|BOP|EOP|bop|eop)$/.test(s)) return { kind: 'primitive', primitive: 'date', line };
  if (/^date\s*\(/.test(s)) return { kind: 'primitive', primitive: 'date', line };

  // ── Conversion helpers ────────────────────────────────────────
  // `str(...)` → string, `num(...)` → number. EC ships both as
  // top-level functions; they're the canonical primitive coercions.
  if (/^str\s*\(/.test(s)) return { kind: 'primitive', primitive: 'string', line };
  if (/^num\s*\(/.test(s)) return { kind: 'primitive', primitive: 'number', line };

  // ── Constructors that create a typed scalar ───────────────────
  // `<receiver>.add(Type, …)` returns the newly-added scalar of the
  // first argument's type. Common in architect-workflow scripts:
  //   _folder := targetFolder.add(Category, id := "x", name := "X")
  // The receiver doesn't matter for the inference — we only need the
  // first arg, which must be a PascalCase identifier.
  const addCall = /^[A-Za-z_]\w*(?:\.\w+(?:\([^)]*\))?)*\.add\s*\(\s*([A-Za-z][A-Za-z0-9_]*)\b/.exec(s);
  if (addCall) return { kind: 'scalar', type: canonicalizeTypeName(addCall[1]), line };

  // ── JSON / MAP / LIST / when / MISSING — useful "unknown" reasons.
  // Catching these by name lets the panel show WHY a var has no
  // schema instead of the generic "unrecognised assignment shape"
  // (which reads like a parser bug). User can then act: write a
  // typed assignment if they need a schema view.
  if (/^JSON\s*\(/.test(s)) return { kind: 'unknown', reason: 'JSON literal: no static schema', line };
  if (/^MAP\s*\(/.test(s)) return { kind: 'unknown', reason: 'MAP literal: no static schema', line };
  if (/^LIST\s*\(/.test(s)) return { kind: 'unknown', reason: 'LIST literal: element types not statically derivable', line };
  if (/^when\s*\(/.test(s)) return { kind: 'unknown', reason: 'when(...): branches not statically resolvable', line };
  if (/^MISSING$/.test(s)) return { kind: 'unknown', reason: 'MISSING: no type until assigned', line };
  if (/^(this|self)(\.|$)/.test(s)) return { kind: 'unknown', reason: `${s.split(/[.\s]/)[0]}: context-dependent, no static type`, line };

  // ── Reference shorthands (t./d./k./o./r.) ─────────────────────
  // `t.<id>` (template), `d.<id>` (default), `k.<id>` (constant),
  // `o.<rid>` (numeric RID), `r.<id>` (resource). All scalar; we
  // can't know the type without a runtime lookup, but the reason
  // tells the user the var IS a scalar.
  const refShorthand = /^([todrk])\.[A-Za-z_0-9][A-Za-z_0-9]*\s*$/.exec(s);
  if (refShorthand) {
    const ns = refShorthand[1];
    const which = { t: 'template', d: 'default', k: 'constant', o: 'object by RID', r: 'resource' }[ns] ?? ns;
    return { kind: 'unknown', reason: `${which} reference: type fetched at runtime`, line };
  }

  // ── Arithmetic + string concat heuristics ─────────────────────
  // We don't try to parse the whole expression — just look at the
  // outer operator. `+` with a string literal anywhere = string;
  // `+ - * /` with only numerics = number. Wrong-leaning only when
  // a user mixes types deliberately, which the panel surfaces as
  // "unknown" via fall-through.
  if (/^[^"']*"[^"]*"|^[^"']*'[^']*'/.test(s) && /\s\+\s/.test(s)) {
    return { kind: 'primitive', primitive: 'string', line };
  }
  // Pure numeric: digits, vars, and arithmetic operators only.
  if (/^[-+*/\s\d().A-Za-z_]+$/.test(s) && /[-+*/]/.test(s) && !/"|'/.test(s)) {
    // Distinguish "string-concat with a tracked-var of string type"
    // from genuine math: if we see ONLY `+` and any operand is a
    // tracked-var of string type, fall through to default-string
    // below.
    return { kind: 'primitive', primitive: 'number', line };
  }

  return { kind: 'unknown', reason: 'unrecognised assignment shape', line };
}

// ── Async helpers ─────────────────────────────────────────────

let pendingFetches = 0;
const fetchQueue: Array<() => Promise<void>> = [];
const MAX_INFLIGHT = 3;

function pump(): void {
  while (pendingFetches < MAX_INFLIGHT && fetchQueue.length > 0) {
    const task = fetchQueue.shift()!;
    pendingFetches++;
    void task().finally(() => { pendingFetches--; pump(); });
  }
}

function enqueue(task: () => Promise<void>): void {
  fetchQueue.push(task);
  pump();
}

// ── Resolution rate limiter (guardrail) ──────────────────────────
// Hard backstop so the editor can NEVER flood BMP with automatic resolution
// queries — regardless of how large, complex, or pathological the script is, or
// a future bug. This is INDEPENDENT of the per-key caches (which already make each
// DISTINCT lookup fire at most once): it caps the RATE at which NEW distinct
// lookups may be issued. Token bucket — a healthy burst (open a big script, warm
// many schemas) drains it; sustained runaway is throttled to the refill rate.
// Over budget → the gated ensure* call silently no-ops; the panel/completion
// degrades to "no data" and a later keystroke (once tokens refill) succeeds.
// Manual refresh (refreshSchema) BYPASSES this — it's a one-at-a-time explicit
// user action. Concurrency is separately capped at MAX_INFLIGHT, so even a full
// burst reaches BMP ≤3-at-a-time.
export class TokenBucket {
  private tokens: number;
  private last: number;
  constructor(private max: number, private refillPerSec: number, now: number) {
    this.tokens = max;
    this.last = now;
  }
  /** Consume one token at time `now`; true if available. */
  take(now: number): boolean {
    const dt = (now - this.last) / 1000;
    if (dt > 0) {
      this.tokens = Math.min(this.max, this.tokens + dt * this.refillPerSec);
      this.last = now;
    }
    if (this.tokens >= 1) { this.tokens -= 1; return true; }
    return false;
  }
  reset(now: number): void { this.tokens = this.max; this.last = now; }
}

const RESOLVE_BUCKET_MAX = 120;       // burst headroom (open-a-big-script warm)
const RESOLVE_REFILL_PER_SEC = 6;     // sustained ceiling
let resolveBucket = new TokenBucket(RESOLVE_BUCKET_MAX, RESOLVE_REFILL_PER_SEC, Date.now());
let resolveThrottleLogged = false;

/** Gate an automatic editor resolution. Returns false (→ caller silently skips)
 *  when the rate budget is exhausted. Logs once per throttle episode, not per drop. */
function allowResolve(): boolean {
  if (resolveBucket.take(Date.now())) { resolveThrottleLogged = false; return true; }
  if (!resolveThrottleLogged) {
    resolveThrottleLogged = true;
    console.warn('[crev] editor BMP resolution rate-limited — too many distinct lookups in a short window; degrading silently until it cools down');
  }
  return false;
}

/** Per-key debounced scheduler. New schedules for the same key reset
 *  that key's timer; `fire` is expected to dedupe in-flight work. */
class DebouncedResolver {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(private fire: (k: string) => void, private delayMs: number) {}

  schedule(k: string): void {
    const existing = this.timers.get(k);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      this.timers.delete(k);
      this.fire(k);
    }, this.delayMs);
    this.timers.set(k, t);
  }

  _resetForTests(): void {
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}

/** Quiet-window for partial-identifier validation. Matches the
 *  prefetch window so typing into `Ce` `CeR` `CeRi` `...` collapses
 *  to one fetch for the final name. */
const RESOLVE_DEBOUNCE_MS = 500;

const schemaResolver = new DebouncedResolver(
  (className) => ensureSchemaNow(className),
  RESOLVE_DEBOUNCE_MS,
);

/** Public schema-fetch API — debounced. Use `ensureSchemaNow` for
 *  user-initiated paths where the caller is waiting on the result
 *  (e.g. `*`-expansion completions). */
export function ensureSchema(className: string): void {
  if (state.schemas.has(lc(className))) return;
  if (state.inflight.has(lc(className))) return;
  if (hasCurrentSchemaError(className)) return;
  schemaResolver.schedule(className);
}

/** Record the canonical PascalCase for a class so the Vars panel can show
 *  it regardless of the casing the user typed. */
function rememberCanonical(requested: string, canonical: string | undefined): void {
  if (!canonical) return;
  canonicalByLower.set(lc(requested), canonical);
  canonicalByLower.set(lc(canonical), canonical);
}

/** Eager schema fetch — skips the debounce. */
export function ensureSchemaNow(className: string): void {
  if (state.schemas.has(lc(className))) return;
  if (state.inflight.has(lc(className))) return;
  if (hasCurrentSchemaError(className)) return;
  if (!allowResolve()) return; // rate-limit guardrail (cache checks first — a hit never costs a token)
  state.inflight.add(lc(className));
  enqueue(async () => {
    try {
      const r = await sendRequest({
        type: 'FETCH_TYPE_SCHEMA',
        className,
        exampleRef: schemaExampleRefs.get(lc(className)),
      } as InspectorMessage);
      if (r?.type === 'FETCH_TYPE_SCHEMA_RESULT') {
        if (r.ok && r.props) {
          state.schemas.set(lc(className), r.props);
          rememberCanonical(className, r.canonicalClassName);
          state.schemaErrors.delete(lc(className));
        } else {
          // Cache the error so the UI surfaces it AND so re-renders
          // don't burn fetches on every keystroke. TTL'd so a bridge
          // restart self-heals on the next render after the window
          // expires — see SCHEMA_ERROR_TTL_MS.
          recordSchemaError(className, r.error || 'Unknown error');
        }
        notify();
      } else {
        // No response at all (SW handler missing / messaging broken).
        recordSchemaError(className, 'No response from service worker');
        notify();
      }
    } catch (e) {
      recordSchemaError(className, (e as Error)?.message || 'Fetch failed');
      notify();
    } finally {
      state.inflight.delete(lc(className));
    }
  });
}

/** Bypass the cache and re-fetch a className. Wired to the Vars
 *  panel's ↻ button. Also clears any previous error so the negative
 *  cache in ensureSchema lets new fetches through. */
export function refreshSchema(className: string): void {
  state.schemas.delete(lc(className));
  state.schemaErrors.delete(lc(className));
  state.inflight.add(lc(className));
  notify(); // immediate UI update so the spinner shows
  enqueue(async () => {
    try {
      const r = await sendRequest({
        type: 'FETCH_TYPE_SCHEMA',
        className,
        refresh: true,
        exampleRef: schemaExampleRefs.get(lc(className)),
      } as InspectorMessage);
      if (r?.type === 'FETCH_TYPE_SCHEMA_RESULT') {
        if (r.ok && r.props) {
          state.schemas.set(lc(className), r.props);
          rememberCanonical(className, r.canonicalClassName);
        } else {
          recordSchemaError(className, r.error || 'Unknown error');
        }
        notify();
      } else {
        recordSchemaError(className, 'No response from service worker');
        notify();
      }
    } catch (e) {
      recordSchemaError(className, (e as Error)?.message || 'Fetch failed');
      notify();
    } finally {
      state.inflight.delete(lc(className));
    }
  });
}

// ── List/tag option sets (value autocomplete + Vars-panel dropdowns) ─────────
// Parallel to the schema cache but kept separate: a failure to load options
// must never affect property-name completion. No error caching — these are
// user-triggered and infrequent, so a failed fetch just retries next time and
// value autocomplete silently degrades to no suggestions.
//
// Keyed by lc(className) only, like `schemas` — NOT by serverId. The SW-side
// caches ARE profile-scoped; this mirror is not, so switching BMP profile
// WITHOUT reloading the editor would serve options from the previous server
// until reload. Acceptable: a profile switch is a deliberate settings action
// and a full reload re-injects the editor. If a live profile-change signal is
// ever plumbed to the editor, clear both this and `schemas` on it.
const typeOptions = new Map<string, TypeOptionSet[]>();
const optionsInflight = new Set<string>();

/** Cached option sets for a class, or undefined if not loaded yet. */
export function getOptions(className: string): TypeOptionSet[] | undefined {
  return typeOptions.get(lc(className));
}

/** Cached option set for one property, or undefined. */
export function getOption(className: string, accessor: string): TypeOptionSet | undefined {
  return typeOptions.get(lc(className))?.find(o => o.accessor === accessor);
}

/** Eager fetch of a class's list/tag option sets (skips any debounce). Fires
 *  `notify()` on arrival so a pending value-completion / the Vars panel updates.
 *  Mirrors ensureSchemaNow but with graceful degradation on failure. */
export function ensureOptionsNow(className: string): void {
  const key = lc(className);
  if (typeOptions.has(key) || optionsInflight.has(key)) return;
  if (!allowResolve()) return; // rate-limit guardrail
  optionsInflight.add(key);
  enqueue(async () => {
    try {
      const r = await sendRequest({ type: 'FETCH_TYPE_OPTIONS', className } as InspectorMessage);
      if (r?.type === 'FETCH_TYPE_OPTIONS_RESULT' && r.ok && r.options) {
        typeOptions.set(key, r.options);
        notify();
      }
    } catch {
      // Swallow — value autocomplete degrades to no suggestions, never blocks.
    } finally {
      optionsInflight.delete(key);
    }
  });
}

// ── ns.bid reference → type resolution (dot-member property completion) ──────
// `ceras.stmt_supplier_failure.<prop>` needs the CLASS of the referenced object
// before its schema can be offered. BMP resolves a `namespace.businessId` ref to
// an identity in ~1ms (live-verified) via the same HOVER_RESOLVE EC the hover
// tooltip uses — we only read `objectType` here. Same shape as the root-category
// resolver below: cache forever (an object's class doesn't drift while the editor
// is open), dedup in-flight, `notify()` on arrival so a pending completion (which
// rides `subscribe`) wakes. Failed/empty lookups are deliberately NOT cached:
// an editor can ask during the short connection-startup window, and treating
// that as a permanent miss leaves valid refs unresolved for the window's whole
// lifetime. NOT keyed by serverId — see the typeOptions note; a profile switch
// without an editor reload could serve a stale class, acceptable for the same
// reason.
const refTypeCache = new Map<string, string>();
const refTypeInflight = new Set<string>();
/** One validated concrete reference per resolved class. Used only when BMP's
 * class-level config metadata is empty and the worker falls back to help(ref). */
const schemaExampleRefs = new Map<string, string>();

/** Cached class for a `namespace.businessId` ref, or undefined when it has not
 *  resolved successfully yet. */
export function getRefType(ref: string): string | undefined {
  return refTypeCache.get(ref);
}

/** Eager resolve of a `namespace.businessId` ref to its object's class. Mirrors
 *  ensureSchemaNow's guard/enqueue/notify; degrades silently on transport failure
 *  (the ref stays unresolved and a later completion retries). */
export function ensureRefType(ref: string): void {
  if (refTypeCache.has(ref) || refTypeInflight.has(ref)) return;
  if (!allowResolve()) return; // rate-limit guardrail
  refTypeInflight.add(ref);
  enqueue(async () => {
    try {
      const r = await sendRequest({ type: 'HOVER_RESOLVE', ref } as InspectorMessage);
      if (r?.type === 'HOVER_RESOLVE_RESULT' && r.objectType) {
        // objectType is already BMP's canonical PascalCase; canonicalize is a
        // harmless no-op that also records the casing for the Vars panel.
        const cls = canonicalizeTypeName(r.objectType);
        refTypeCache.set(ref, cls);
        schemaExampleRefs.set(lc(cls), ref);
        // A class-only lookup may already have reported an empty schema.
        // Concrete evidence makes that negative cache obsolete immediately.
        state.schemaErrors.delete(lc(cls));
        rememberCanonical(cls, r.objectType);
        // A reference can be the RHS of a tracked variable assignment. Re-scan
        // the immutable last document so `_x := t.foo` upgrades from a pending
        // reference to scalar<Foo> as soon as the shared lookup lands.
        const doc = lastDoc;
        if (doc) scanDocForInferences(doc);
        else notify();
      }
      // No response (SW handler missing / bridge down): leave uncached so the
      // next completion retries rather than caching a permanent miss.
    } catch {
      // Transport error: same — leave uncached for retry.
    } finally {
      refTypeInflight.delete(ref);
    }
  });
}

/** Local mirror of the SW root-category cache. We populate it on
 *  resolve so re-scans (which happen on every keystroke) don't need
 *  to round-trip. `string` = resolved; `null` = resolved to "no
 *  class" (or BMP rejected the category); absent = never asked. */
const rootCategoryCache = new Map<string, string | null>();
const rootInFlight = new Set<string>();

/** Debounced root-category resolver. The parseRhs regex matches a
 *  complete `root.<cat>.children()` pattern, but `<cat>` may still
 *  be a transient partial as the user types — wait for typing to
 *  settle before hitting BMP.
 *
 *  The SW handler distinguishes "BMP rejected this category" (cached
 *  as null, never re-asked) from transport / timeout failures (not
 *  cached, retryable). */
function requestRootCategory(category: string): void {
  if (rootCategoryCache.has(category)) return;
  if (rootInFlight.has(category)) return;
  rootResolver.schedule(category);
}

const rootResolver = new DebouncedResolver(
  (category) => { void resolveRootCategoryNow(category); },
  RESOLVE_DEBOUNCE_MS,
);

async function resolveRootCategoryNow(category: string): Promise<void> {
  if (rootCategoryCache.has(category)) return;
  if (rootInFlight.has(category)) return;
  if (!allowResolve()) return; // rate-limit guardrail
  rootInFlight.add(category);
  try {
    const r = await sendRequest({ type: 'RESOLVE_ROOT_CATEGORY', category } as InspectorMessage);
    if (r?.type === 'RESOLVE_ROOT_CATEGORY_RESULT' && r.ok) {
      // ok:true with no className = SW classified this as a definitive
      // "no such category" — cache it as null so we stop re-asking.
      rootCategoryCache.set(category, r.className ?? null);
      // Re-scan so every `root.<cat>.children()` inference picks up
      // the new mapping. Cheaper than diffing.
      const ed = lastDoc;
      if (ed) scanDocForInferences(ed);
      notify();
    }
    // ok === false → transport/timeout → don't cache, allow future retry
  } finally {
    rootInFlight.delete(category);
  }
}

/** Snapshot of the doc last scanned — used by the async root resolver
 *  to trigger a re-scan when an answer arrives. The CodeMirror Doc is
 *  immutable per-state so holding a reference is safe. */
let lastDoc: { lines: number; line(n: number): { text: string } } | null = null;

// ── Doc scan + listener ───────────────────────────────────────

export function scanDocForInferences(doc: { lines: number; line(n: number): { text: string } }): void {
  // Hold a reference so the async root-category resolver can re-scan
  // when its answer lands.
  lastDoc = doc;
  const next = new Map<string, TypeInference>();
  for (let i = 1; i <= doc.lines; i++) {
    const t = doc.line(i).text;
    const m = ASSIGN_RE.exec(t);
    if (!m) continue;
    const name = m[1];
    if (RESERVED.has(name.toLowerCase())) continue;
    if (!next.has(name)) {
      // Pass `next` so chain inference on this line can resolve
      // vars declared on prior lines of the SAME scan, not stale
      // state from the previous scan.
      next.set(name, parseRhs(m[2], i, next));
    }
  }
  // Second pass — named lambda params (`coll.forEach(_x: …)`). These aren't
  // assignments, so the loop above misses them, yet the Vars panel should list
  // `_risk` like any other variable. The binder always sits BELOW its source,
  // so the receiver's type is already in `next`; resolve it and record the param
  // as that collection's element. Completion still resolves loop vars positionally
  // (scope-correct); this flat record is for the panel and a consistent fallback.
  for (let i = 1; i <= doc.lines; i++) {
    const t = doc.line(i).text;
    LAMBDA_BIND_RE.lastIndex = 0;
    let lm: RegExpExecArray | null;
    while ((lm = LAMBDA_BIND_RE.exec(t)) !== null) {
      const [, receiver, method, param] = lm;
      if (!isElementContext(method)) continue;
      if (next.has(param) || RESERVED.has(param.toLowerCase())) continue;
      const recv = parseRhs(receiver, i, next);
      if (recv.kind === 'list' && recv.types.length > 0) {
        next.set(param, { kind: 'scalar', type: recv.types[0], line: i, loopVar: true });
      }
    }
  }
  state.vars = next;
  notify();
  // NOTE: deliberately no eager `ensureSchema()` calls here. Fetches
  // are triggered lazily by renderVarsProps when the user actually
  // opens a var's property pane. That's both faster (no 500ms
  // debounce needed — pure-parse is O(N) over the doc and dirt
  // cheap) and lighter on the bridge (a doc referencing 10 types
  // doesn't fetch 10 schemas when the user only looks at one).
}

/** Sync doc listener — runs on every docChanged keystroke. Pure
 *  parse with no I/O so we can afford the cost; the Vars panel
 *  (name list + type chips) updates instantly when the user types
 *  a new `_v := SELECT X`. Schemas, which DO cost an EC round-trip,
 *  are warmed in the background via a debounced prefetch so that
 *  `*`-expansion + property pane have data ready when the user
 *  actually opens them — but partial-type-name keystrokes don't
 *  burn N wasted fetches as the user types `CeRiskAss...ment`. */
let prefetchTimer: ReturnType<typeof setTimeout> | null = null;
const PREFETCH_DEBOUNCE_MS = 500;

function schedulePrefetch(): void {
  if (prefetchTimer) clearTimeout(prefetchTimer);
  prefetchTimer = setTimeout(() => {
    prefetchTimer = null;
    // Use ensureSchemaNow here — schedulePrefetch IS itself the
    // debounce window for warming, so stacking the per-name debounce
    // inside ensureSchema would just delay the warm by another 500ms.
    for (const inf of state.vars.values()) {
      if (inf.kind === 'list') for (const t of inf.types) ensureSchemaNow(t);
      else if (inf.kind === 'scalar') ensureSchemaNow(inf.type);
    }
  }, PREFETCH_DEBOUNCE_MS);
}

export const typeInferenceListener = EditorView.updateListener.of((update: ViewUpdate) => {
  if (!update.docChanged) return;
  scanDocForInferences(update.state.doc);
  schedulePrefetch();
});

/** Clear all inferred state — used when the editor swaps to a non-EC
 *  property (HTML/JS/CSS) so the panel doesn't show stale EC vars. */
export function clearInferences(): void {
  state.vars.clear();
  lastDoc = null;
  // Schemas + cache survive — different scripts often reference the
  // same types, so wiping would be a waste. The SW-side cache also
  // survives, of course.
  notify();
}

/** Test hook — drop EVERYTHING (inferences, schemas, root-category
 *  mappings, in-flight fetch queue). NOT used in production code;
 *  the SW-side cache is authoritative there. */
export function _resetForTests(): void {
  state.vars.clear();
  state.schemas.clear();
  state.schemaErrors.clear();
  state.inflight.clear();
  typeOptions.clear();
  optionsInflight.clear();
  refTypeCache.clear();
  refTypeInflight.clear();
  schemaExampleRefs.clear();
  resolveBucket = new TokenBucket(RESOLVE_BUCKET_MAX, RESOLVE_REFILL_PER_SEC, Date.now());
  resolveThrottleLogged = false;
  canonicalByLower.clear();
  rootCategoryCache.clear();
  rootInFlight.clear();
  fetchQueue.length = 0;
  // pendingFetches counter is module-level; we can't safely zero it
  // while tasks are still in flight, but a fresh test seeds its own
  // mocks so any "old" task that lands will write to schemas that
  // the next test's reset wipes out anyway.
  if (prefetchTimer) { clearTimeout(prefetchTimer); prefetchTimer = null; }
  schemaResolver._resetForTests();
  rootResolver._resetForTests();
  lastDoc = null;
  notify();
}
