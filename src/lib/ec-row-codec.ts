/**
 * Shared row (de)serialization for EC output — the "emit a delimited row,
 * split the log back into typed fields" pattern hand-rolled across bmp-client,
 * layout/sync, layout/blast-radius, code-search, and handlers/objects (three
 * different delimiter conventions: `|`, `|||`, `\n`). A value containing the
 * delimiter silently corrupts a row if the escaping is wrong; this module is
 * the ONE place that pairs a row's shape (`RowField[]`) with both the EC
 * emitter and the matching parser, so a field can't drift between them.
 *
 * Deliberately NOT a replacement for every EC-output parser in the codebase:
 * `ec-parser.ts` (SEP-block parsing), `flow-parser.ts` (name-as-rest-of-line
 * column splitting for the flow-walker pipeline) and `ec-codegen.ts` (the
 * FLOW_SEP-block builder for the same pipeline) already do their jobs well
 * and are left as-is — see plan 014. This module targets the plain
 * "N fields joined by a delimiter, one row per line" shape duplicated
 * elsewhere. Pure string construction; no I/O.
 */

/** One field of a row: `name` is the key it parses back into, `expr` is the
 *  EC source fragment that produces its value (e.g. `_o.rid.whenMissing("")`,
 *  or a literal like `"user"`). Order matters — it IS the wire column order. */
export interface RowField {
  name: string;
  expr: string;
}

export function field(name: string, expr: string): RowField {
  return { name, expr };
}

/** Build the EC expression that concatenates `fields` with `delimiter`
 *  between each. Returns a bare expression (no `_r :=` wrapper, no trailing
 *  `\n`) — callers compose it into their own accumulator/line exactly as
 *  before, so the wire delimiter and surrounding EC never change. */
export function buildRowEc(fields: RowField[], delimiter: string): string {
  return fields.map(f => f.expr).join(` + "${delimiter}" + `);
}

export interface ParseRowOptions {
  /** When true, the LAST field absorbs the remainder of the line (rejoined
   *  with `delimiter`) instead of being a single column — for a free-text
   *  field (e.g. a name) that may itself contain the delimiter. */
  trailingFreeText?: boolean;
  /** Minimum column count to accept the row (default: `fieldNames.length`,
   *  i.e. every field required). Lower it for a site whose trailing fields
   *  are genuinely optional — a short row still parses, with the missing
   *  trailing fields coming back as `''` (never `undefined`; callers that
   *  distinguish "absent" from "empty" already do `field || undefined`). */
  minFields?: number;
}

export type ParsedRow = Record<string, string>;

/** Parse one delimited row into a `{ fieldName: value }` map (values
 *  trimmed). Returns null when the line has fewer columns than
 *  `opts.minFields` (default `fieldNames.length` — every field required;
 *  the `trailingFreeText` field still counts as one required column). */
export function parseDelimitedRow(
  line: string,
  fieldNames: string[],
  delimiter: string,
  opts: ParseRowOptions = {},
): ParsedRow | null {
  const parts = line.split(delimiter);
  if (parts.length < (opts.minFields ?? fieldNames.length)) return null;
  const out: ParsedRow = {};
  const lastIdx = fieldNames.length - 1;
  for (let i = 0; i < lastIdx; i++) out[fieldNames[i]] = (parts[i] ?? '').trim();
  if (opts.trailingFreeText) {
    out[fieldNames[lastIdx]] = parts.slice(lastIdx).join(delimiter).trim();
  } else {
    out[fieldNames[lastIdx]] = (parts[lastIdx] ?? '').trim();
  }
  return out;
}

/** Parse every line of a multi-row log that contains `delimiter` into rows,
 *  silently skipping blank/non-matching lines (e.g. `Result :` / `Duration`
 *  noise BMP interleaves into EC output). */
export function parseDelimitedLines(
  log: string,
  fieldNames: string[],
  delimiter: string,
  opts: ParseRowOptions = {},
): ParsedRow[] {
  const out: ParsedRow[] = [];
  for (const raw of log.split('\n')) {
    const line = raw.trim();
    if (!line || !line.includes(delimiter)) continue;
    const row = parseDelimitedRow(line, fieldNames, delimiter, opts);
    if (row) out.push(row);
  }
  return out;
}

/** The identity fields recurring everywhere: rid/id/name/className, EC
 *  `<var>.rid.whenMissing("")` reads matching the wire's field ORDER
 *  (individually configurable — the existing hand-rolled sites don't agree
 *  on it). `ridDefault` lets a site keep its own `whenMissing` sentinel
 *  ("MISSING" / "SKIP" / "") without diverging from every other call. */
export interface IdentityRowOptions {
  /** EC literal passed to `.rid.whenMissing(...)`. Default `'""'`. */
  ridDefault?: string;
  /** Append a trailing `.key.whenMissing("")` field. */
  key?: boolean;
  /** Override field order/selection. Default: rid, id, name, className[, key]. */
  order?: Array<'rid' | 'id' | 'name' | 'className' | 'key'>;
}

export function identityRow(varName: string, opts: IdentityRowOptions = {}): RowField[] {
  const defaults: Record<string, string> = {
    rid: opts.ridDefault ?? '""', id: '""', name: '""', className: '""', key: '""',
  };
  const order = opts.order ?? (opts.key ? ['rid', 'id', 'name', 'className', 'key'] as const : ['rid', 'id', 'name', 'className'] as const);
  return order.map(f => field(f, `${varName}.${f}.whenMissing(${defaults[f]})`));
}
