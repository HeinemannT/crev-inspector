/**
 * `*` → property list expansion for `.table(*)` call sites.
 *
 * When the user types a literal `*` immediately inside `.table(` and
 * the receiver is a tracked variable whose type we've inferred, an
 * autocomplete entry appears:
 *
 *   * → expand to N properties of <Type>
 *
 * Accepting it replaces the `*` with a comma-separated list of EC
 * accessors (intersection of accessors for multi-type lists). Always
 * uses non-system props by default — the user can hand-edit if they
 * want id/name/parent/etc. surfaced. Other "first-arg-is-an-expression"
 * methods (`.forEach`, `.calculate`, `.as`, `.map`) deliberately do
 * NOT trigger this expansion because a comma-list wouldn't be a
 * valid argument shape for them.
 *
 * Triggers explicitly on `*` so we don't bloat normal-word
 * autocomplete with this entry.
 */
import type { CompletionContext, CompletionResult } from '@codemirror/autocomplete';
import { getInference, getSchema, intersectionSchema, ensureSchemaNow, subscribe } from './typeInference';

// Only `.table(...)` accepts a comma-separated list of accessor names
// as its argument shape — that's the canonical "expand every column"
// case in EC. `.forEach(...)` takes `_item: <body>`, `.calculate` /
// `.as` take a single expression, and `.map` takes one or two
// property names. Surfacing `*` inside those would produce code that
// errors at runtime, so we keep the trigger narrow.
const STAR_METHODS = new Set(['table']);

/** Walk left from `pos` to find the open-paren that contains the
 *  cursor, plus the dotted-call chain that opens it. Returns the
 *  receiver-var name + method + the position of the `*` token. */
function findEnclosingCall(text: string, pos: number): { receiver: string; method: string; starFrom: number; starTo: number } | null {
  // Step 1: locate the `*` token at pos-1 (we're called when the user
  // typed `*` and the cursor sits after it).
  const star = text.lastIndexOf('*', pos - 1);
  if (star < 0 || star !== pos - 1) return null;

  // Step 2: walk left from `*` past whitespace + optional preceding
  // arguments. The token after the open paren can be `*` (trivial
  // case) or stuff like `_var: *` for forEach. We only support the
  // trivial case in v1 — first thing inside `(`. Anything fancier
  // returns null.
  let i = star - 1;
  while (i >= 0 && /\s/.test(text[i])) i--;
  if (i < 0 || text[i] !== '(') return null;

  // Step 3: scan left of `(` to grab `.<method>` then the receiver
  // identifier. Skip whitespace.
  let j = i - 1;
  while (j >= 0 && /\s/.test(text[j])) j--;
  if (j < 0) return null;
  // Collect method name walking back through word chars until `.`
  const methodEnd = j;
  while (j >= 0 && /\w/.test(text[j])) j--;
  if (j < 0 || text[j] !== '.') return null;
  const method = text.slice(j + 1, methodEnd + 1);
  if (!STAR_METHODS.has(method)) return null;

  // Step 4: scan left of `.` to grab the receiver identifier
  // (last component of any chain).
  let k = j - 1;
  while (k >= 0 && /\s/.test(text[k])) k--;
  const receiverEnd = k;
  while (k >= 0 && /\w/.test(text[k])) k--;
  const receiver = text.slice(k + 1, receiverEnd + 1);
  if (!receiver) return null;

  return { receiver, method, starFrom: star, starTo: star + 1 };
}

export function starExpansionCompletions(context: CompletionContext): CompletionResult | Promise<CompletionResult | null> | null {
  // Only fire when the user JUST typed `*` (i.e. the char before
  // cursor is `*`). Without this gate, the entry would surface on
  // every keystroke inside the call.
  const { state, pos } = context;
  const head = state.sliceDoc(Math.max(0, pos - 1), pos);
  if (head !== '*') return null;

  // Look at the line containing the cursor — assignments don't span
  // lines in EC, and call-site arguments don't either. Keeps the
  // walker bounded.
  const line = state.doc.lineAt(pos);
  const lineText = line.text;
  const lineOffset = pos - line.from;
  const m = findEnclosingCall(lineText, lineOffset);
  if (!m) return null;

  // Resolve receiver → inferred type → schema (possibly intersection).
  const inf = getInference(m.receiver);
  if (!inf) return null;
  if (inf.kind !== 'list' && inf.kind !== 'scalar') return null;
  const types = inf.kind === 'list' ? inf.types : [inf.type];

  const lookupProps = (): ReturnType<typeof getSchema> | undefined =>
    inf.kind === 'list' && types.length > 1
      ? intersectionSchema(types)
      : getSchema(types[0]);

  const propsNow = lookupProps();
  if (propsNow) return buildResult(propsNow, types, line.from + m.starFrom, line.from + m.starTo);

  // Schema(s) not loaded yet — kick fetches AND return a Promise that
  // resolves once they arrive. CodeMirror waits up to a few hundred
  // milliseconds for an async completion source before falling back.
  // If the user keeps typing, `context.aborted` flips and we bail.
  // User just typed `*` and is awaiting completions — go eager.
  for (const t of types) ensureSchemaNow(t);

  return new Promise<CompletionResult | null>((resolve) => {
    // Hard ceiling so a stuck fetch can't keep the autocomplete spinner
    // dangling — autocomplete itself will move on regardless, but we
    // tidy up our subscription.
    const timeout = setTimeout(() => { cleanup(); resolve(null); }, 2000);
    const unsubscribe = subscribe(() => {
      if (context.aborted) { cleanup(); resolve(null); return; }
      const p = lookupProps();
      if (!p) return;
      cleanup();
      resolve(buildResult(p, types, line.from + m.starFrom, line.from + m.starTo));
    });
    const cleanup = () => { clearTimeout(timeout); unsubscribe(); };
  });
}

function buildResult(
  props: NonNullable<ReturnType<typeof getSchema>>,
  types: string[],
  from: number,
  to: number,
): CompletionResult | null {
  const customProps = props.filter(p => !p.systemobject);
  const useProps = customProps.length > 0 ? customProps : props;
  if (useProps.length === 0) return null;

  const accessorList = useProps.map(p => p.accessor).join(', ');
  const typeLabel = types.length === 1 ? types[0] : types.join(' ∩ ');

  return {
    from,
    to,
    options: [
      {
        label: '*',
        displayLabel: '*',
        detail: `expand to ${useProps.length} properties of ${typeLabel}`,
        info: useProps.length <= 12
          ? accessorList
          : useProps.slice(0, 10).map(p => p.accessor).join(', ') + `, …+${useProps.length - 10} more`,
        // boost so this entry ranks above any other completion that
        // might happen to match `*` (unlikely, but safe).
        boost: 99,
        apply: accessorList,
        type: 'snippet',
      },
    ],
  };
}
