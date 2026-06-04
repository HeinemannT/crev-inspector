/**
 * Connections resolver (service-worker side) — discovers an object's reference
 * relationships GENERICALLY from its class config and reads their current
 * endpoints. No hardcoded relationship table: this works on any workspace.
 *
 * Discovery reuses the (cached) type-schema props — each prop carries its
 * config kind. Forward refs (this → target) are ReferenceMethodConfig /
 * HistoricalReferenceMethodConfig; reverse refs (target → this) are
 * ReverseReferenceMethodConfig.
 *
 * Reading: every ref field is read via forEach — verified live to handle a
 * set single forward ref (one iteration), a multi-value forward ref (all
 * targets), a reverse ref (its back-reference list), and an unset ref
 * (no-op). So multiplicity needs no special-casing, and direction is purely
 * a display concern.
 *
 * The EC is built from the same proven atoms the rest of the codebase uses
 * (`.rid/.id/.name/.className.whenMissing("")`, the `_sep` block accumulator).
 */

import { FLOW_SEP } from './ec-codegen';
import type { ConnTarget, ConnGroup, TypeSchemaProp } from './types';

export type { ConnTarget, ConnGroup } from './types';

/** The schema-prop shape we read (a type's property config). Re-uses the
 *  cache/FETCH_TYPE_SCHEMA prop type so there's one source of truth. */
export type SchemaProp = TypeSchemaProp;

// ── Ref-field discovery from type-schema props ──────────────────────

/** A reference relationship field on a type. */
export interface RefField {
  accessor: string;
  label: string;
  direction: 'out' | 'in';
}

const FORWARD_REF_KINDS = new Set([
  'ReferenceMethodConfig',
  'HistoricalReferenceMethodConfig',
]);
const REVERSE_REF_KINDS = new Set([
  'ReverseReferenceMethodConfig',
]);

/** Pull the reference relationships out of a type's schema props. System
 *  props are kept — many real relationships (owner, master_reference) are
 *  system-defined — but obvious non-relationship system noise is excluded by
 *  the config-kind filter alone. */
export function refFieldsFromSchema(props: SchemaProp[]): RefField[] {
  const out: RefField[] = [];
  for (const p of props) {
    if (!p.accessor) continue;
    if (FORWARD_REF_KINDS.has(p.configClass)) {
      out.push({ accessor: p.accessor, label: humanize(p.accessor, p.label), direction: 'out' });
    } else if (REVERSE_REF_KINDS.has(p.configClass)) {
      out.push({ accessor: p.accessor, label: humanize(p.accessor, p.label), direction: 'in' });
    }
  }
  return out;
}

/** Prefer the config's own label; fall back to a de-snaked accessor. */
function humanize(accessor: string, label: string): string {
  const l = (label || '').trim();
  if (l) return l;
  return accessor.replace(/_/g, ' ');
}

// ── EC codegen ──────────────────────────────────────────────────────

/** Accessors are interpolated into EC source, so they must be safe identifiers
 *  (the schema only ever yields these, but defend the codegen boundary). */
function isSafeAccessor(a: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(a);
}

const ROW = (v: string) =>
  `${v}.rid.whenMissing("") + "|" + ${v}.id.whenMissing("") + "|" + ${v}.name.whenMissing("") + "|" + ${v}.className.whenMissing("")`;

/**
 * Build the EC that reads every ref field's endpoint(s) for `ref`. Each field
 * emits a `{sep}f:<accessor>{sep}` header followed by zero or more
 * `rid|id|name|className` rows. Forward → 0/1 row (single accessor); reverse →
 * 0+ rows (forEach).
 */
export function buildConnectionsEc(ref: string, fields: RefField[]): string {
  const lines: string[] = [
    `_sep := "${FLOW_SEP}"`,
    `_o := ${ref}`,
    '_r := ""',
  ];
  for (const f of fields) {
    if (!isSafeAccessor(f.accessor)) continue;
    // Read EVERY ref via forEach — verified live to iterate a set single
    // forward ref exactly once, a multi-value forward ref over all targets,
    // a reverse ref over its back-reference list, and to no-op on an unset
    // ref. One uniform read sidesteps both the single-vs-multi ambiguity and
    // EC's IF-is-an-expression rule (a guard block is a parse error).
    lines.push(`_r := _r + _sep + "f:${f.accessor}" + _sep + "\\n"`);
    lines.push(`_o.${f.accessor}.forEach(_t:`);
    lines.push(`     _r := _r + ${ROW('_t')} + "\\n"`);
    lines.push(`)`);
  }
  lines.push(`_r := _r + _sep + "DONE" + _sep`);
  lines.push('_r');
  return lines.join('\n');
}

// ── Parsing ─────────────────────────────────────────────────────────

function parseRow(line: string): ConnTarget | null {
  const parts = line.split('|');
  if (parts.length < 4) return null;
  const [rid, id, name, type] = parts;
  if (!rid) return null;
  // A ref whose target rid resolves but carries no identity is a dangling
  // pointer (deleted object) — flag it broken.
  const broken = !id && !name && !type;
  return { rid, businessId: id ?? '', name: name ?? '', type: type ?? '', broken: broken || undefined };
}

/**
 * Parse the EC output into connection groups, preserving the declared field
 * order/direction. `fields` drives which groups exist (so unset edges still
 * render); the log fills in their targets.
 */
export function parseConnections(log: string, fields: RefField[]): ConnGroup[] {
  const byAccessor = new Map<string, ConnTarget[]>();
  // Split into [header, body, header, body, ...] on the separator.
  const chunks = log.split(FLOW_SEP);
  for (let i = 0; i < chunks.length - 1; i++) {
    const head = chunks[i].trim();
    if (!head.startsWith('f:')) continue;
    const accessor = head.slice(2);
    const body = chunks[i + 1] ?? '';
    const targets: ConnTarget[] = [];
    for (const line of body.split('\n')) {
      const t = parseRow(line.trim());
      if (t) targets.push(t);
    }
    byAccessor.set(accessor, targets);
  }

  return fields.map(f => ({
    field: f.accessor,
    label: f.label,
    direction: f.direction,
    targets: byAccessor.get(f.accessor) ?? [],
  }));
}
