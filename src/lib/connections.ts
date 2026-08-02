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

/** Declared reverse refs are loaded only on demand, but they still need hard
 * payload bounds: one relationship can point at thousands of objects and a
 * type can declare several such fields. The +1 emitted by the builder lets
 * the parser report truncation without a separate count query. */
export const REVERSE_REF_FIELD_CAP = 50;
export const REVERSE_REF_TOTAL_CAP = 100;

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
    '_reverseN := 0',
  ];
  for (const f of fields) {
    if (!isSafeAccessor(f.accessor)) continue;
    // Read EVERY ref via forEach — verified live to iterate a set single
    // forward ref exactly once, a multi-value forward ref over all targets,
    // a reverse ref over its back-reference list, and to no-op on an unset
    // ref. One uniform read sidesteps both the single-vs-multi ambiguity and
    // EC's IF-is-an-expression rule (a guard block is a parse error).
    lines.push(`_r := _r + _sep + "f:${f.accessor}" + _sep + "\\n"`);
    if (f.direction === 'in') lines.push('_fieldN := 0');
    lines.push(`_o.${f.accessor}.forEach(_t:`);
    if (f.direction === 'in') {
      lines.push('     _fieldN := _fieldN + 1');
      lines.push('     _reverseN := _reverseN + 1');
      lines.push(`     IF _fieldN <= ${REVERSE_REF_FIELD_CAP + 1} AND _reverseN <= ${REVERSE_REF_TOTAL_CAP + 1} THEN`);
      lines.push(`          _r := _r + ${ROW('_t')} + "\\n"`);
      lines.push('     ELSE');
      lines.push('          _r := _r');
      lines.push('     ENDIF');
    } else {
      lines.push(`     _r := _r + ${ROW('_t')} + "\\n"`);
    }
    lines.push(`)`);
    if (f.direction === 'in') {
      lines.push(`_r := _r + _sep + "n:${f.accessor}" + _sep + str(_fieldN) + "\\n"`);
    }
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
  const counts = new Map<string, number>();
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
    continue;
  }
  for (let i = 0; i < chunks.length - 1; i++) {
    const head = chunks[i].trim();
    if (!head.startsWith('n:')) continue;
    const accessor = head.slice(2);
    const count = Number((chunks[i + 1] ?? '').trim().split('\n')[0]);
    if (Number.isSafeInteger(count) && count >= 0) counts.set(accessor, count);
  }

  return fields.map(f => {
    const rawTargets = byAccessor.get(f.accessor) ?? [];
    const targets = f.direction === 'in'
      ? rawTargets.slice(0, REVERSE_REF_FIELD_CAP)
      : rawTargets;
    const total = counts.get(f.accessor) ?? rawTargets.length;
    return {
      field: f.accessor,
      label: f.label,
      direction: f.direction,
      targets,
      ...(f.direction === 'in' && total > targets.length ? { capped: true } : {}),
    };
  });
}

// ── Junction inlining (C2) ──────────────────────────────────────────

/**
 * EC that reads the forward refs of a set of junction objects (e.g. the
 * CeWorkflows that mitigate a risk), so we can inline each junction's far side.
 * Emits a `{sep}j:<rid>{sep}` header per junction, then its forward-ref rows.
 */
export function buildJunctionEc(rids: string[], forwardFields: RefField[]): string {
  const lines: string[] = [`_sep := "${FLOW_SEP}"`, '_r := ""'];
  for (const rid of rids) {
    if (!/^-?\d+$/.test(rid)) continue; // rids are numeric; guard EC interpolation
    lines.push(`_j := lookup(${rid})`);
    lines.push(`_r := _r + _sep + "j:${rid}" + _sep + "\\n"`);
    for (const f of forwardFields) {
      if (!isSafeAccessor(f.accessor)) continue;
      lines.push(`_j.${f.accessor}.forEach(_t:`);
      lines.push(`     _r := _r + ${ROW('_t')} + "\\n"`);
      lines.push(`)`);
    }
  }
  lines.push('_r');
  return lines.join('\n');
}

/** Parse the junction EC into a map of junction-rid → its forward-ref targets. */
export function parseJunctions(log: string): Map<string, ConnTarget[]> {
  const out = new Map<string, ConnTarget[]>();
  const chunks = log.split(FLOW_SEP);
  for (let i = 0; i < chunks.length - 1; i++) {
    const head = chunks[i].trim();
    if (!head.startsWith('j:')) continue;
    const rid = head.slice(2);
    const targets: ConnTarget[] = [];
    for (const line of (chunks[i + 1] ?? '').split('\n')) {
      const t = parseRow(line.trim());
      if (t) targets.push(t);
    }
    out.set(rid, targets);
  }
  return out;
}

/**
 * Pick a junction's far side: a forward ref whose target is neither the source
 * object (that edge is the back-reference we arrived through) nor the junction
 * itself. Returns undefined when the junction has no distinct far side.
 */
export function pickFarSide(sourceRid: string, junctionRid: string, fars: ConnTarget[]): ConnTarget | undefined {
  return fars.find(f => f.rid && f.rid !== sourceRid && f.rid !== junctionRid && !f.broken);
}

// ── Inbound scan ("referenced by", C3) ──────────────────────────────

/** Max inbound referrers surfaced — single source of truth for the server-side
 *  emission cap, the parser cap, and the "first N referrers shown" UI note, so
 *  they can never drift apart. */
export const INBOUND_CAP = 100;

/**
 * EC for the universal inbound scan: `rref()` returns every object that
 * references this one, regardless of whether a reverse ref is declared — so it
 * surfaces edges BMP's own UI can't (an undeclared inbound reference). One row
 * per referrer: rid|id|name|className.
 *
 * Emission is capped server-side at INBOUND_CAP+1 rows. `rref()` on a heavily-
 * referenced object (a shared property / common template / FileResource used
 * everywhere) can return thousands of referrers; without the cap the server
 * builds and transmits ALL of them only for the client to keep the first 100.
 * The forEach still iterates — `rref` has no early break — but only the bounded
 * concat/payload is paid (mirrors the siblings cap in buildObjectPaneEc). The
 * +1 lets parseInbound still flag "capped".
 */
export function buildInboundEc(ref: string): string {
  return [
    `_o := ${ref}`,
    '_r := ""',
    '_n := 0',
    '_o.rref().forEach(_t:',
    '     _n := _n + 1',
    `     IF _n <= ${INBOUND_CAP + 1} THEN`,
    `          _r := _r + ${ROW('_t')} + "\\n"`,
    '     ELSE',
    '          _r := _r',
    '     ENDIF',
    ')',
    '_r',
  ].join('\n');
}

/** Parse the inbound rows, capped (a heavily-referenced object can have many). */
export function parseInbound(log: string, cap = INBOUND_CAP): { targets: ConnTarget[]; capped: boolean } {
  const targets: ConnTarget[] = [];
  let capped = false;
  for (const line of log.split('\n')) {
    const t = parseRow(line.trim());
    if (!t) continue;
    if (targets.length >= cap) { capped = true; break; }
    targets.push(t);
  }
  return { targets, capped };
}
