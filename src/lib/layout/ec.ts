/**
 * compile(plan, model) → { script, notes }.
 *
 * Turns the ordered plan into ONE Extended Code program. Objects created in this batch are
 * captured in `_n<k>` variables and referenced by variable when a later step depends on them
 * (a widget binding into a just-created container, a moveAfter of a just-created node). Existing
 * objects are referenced as `t.<businessId>`. The two-model split: widgets are added to the
 * scorecard (`_sc.add`), containers to their tab/container (`<parent>.add`), tabs to the tabset
 * (`_ts.add`).
 *
 * NOTE: target=template structural ops are unverified (see constraints.ts) — this emits against
 * the page's own objects; the sync layer is responsible for the template-vs-instance wrap once
 * that semantic is confirmed against a template-backed page.
 */
import { walk } from './model';
import { COMPOSITE_TYPES } from './constraints';
// Shared EC sanitisation (escaping + identifier/id validation) — the same guards the other EC
// generators use. ecClass/ecBid are thin aliases; ecStr wraps the shared escaper in quotes.
import { formatEcLiteral, validateEcIdentifier as ecClass, validateBusinessId as ecBid, validateRid as ecRid } from '../ec-guards';
import { styleAssignRhs, INVALID_COLOR_BID } from '../style-ec';
import { OVERRIDABLE_PROPS } from './types';
import type { Breakpoint, LModel, LNode, PlanNote, PlanStep } from './types';

const ecStr = (s: string): string => `"${formatEcLiteral(s)}"`;
/** Scalar EC literal — booleans → TRUE/FALSE, numbers as-is, strings quoted + escaped. Mirrors
 *  BmpClient.formatEcLiteral so the blueprint apply and the side-panel apply format style values
 *  identically (the shared `styleAssignRhs` delegates non-colour props here). */
const ecScalar = (v: string | number | boolean): string =>
  typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : typeof v === 'number' ? String(v) : ecStr(v);

const COL_PROP: Record<Breakpoint, string> = { L: 'columnsLargeScreen', M: 'columnsMediumScreen', S: 'columnsSmallScreen' };

/** F2: the only properties a reset may target — bare EC identifiers in `.reset(<prop>)`, so allowlisted
 *  to keep the emitted EC injection-proof. Single source of truth = OVERRIDABLE_PROPS. */
const RESETTABLE = new Set<string>(OVERRIDABLE_PROPS);

/** Responsive-width suffix for an add() — M/S are only emitted when authored (else BMP defaults). */
const colsSuffix = (cols: { L: number; M?: number; S?: number }): string =>
  (cols.M != null ? `, ${COL_PROP.M} := ${cols.M}` : '') + (cols.S != null ? `, ${COL_PROP.S} := ${cols.S}` : '');

export function compile(plan: PlanStep[], m: LModel): { script: string; notes: PlanNote[] } {
  if (!plan.length) return { script: '', notes: [] };

  const byId = new Map<string, LNode>();
  walk(m, n => byId.set(n.id, n));

  const vars = new Map<string, string>();
  // Reference an object in EC. New nodes from this batch → their `_n<k>` var. Existing nodes →
  // `t.<businessId>`, EXCEPT a node that carries no businessId (reconstruct fell its `id` back to
  // the rid, so `id === rid`): `t.<rid>` does NOT resolve (the `t.` namespace is businessId-keyed,
  // and an all-digit rid slips past the businessId validator), so it would silently mis-target.
  // Address those by rid via `lookup(<rid>)` instead — the same way the fetch reaches the page root.
  const ref = (id: string): string => {
    const v = vars.get(id);
    if (v) return v;
    const n = byId.get(id);
    if (n?.rid && n.id === n.rid) return `lookup(${ecRid(n.rid)})`;
    return `t.${ecBid(id)}`;
  };
  /** ref() for a node that may not be in the desired model (a delete subject lives only in the
   *  baseline). Falls back to the threaded rid for the businessId-less case, since byId can't see it. */
  const refDeleted = (id: string, rid?: string): string =>
    (rid && id === rid) ? `lookup(${ecRid(rid)})` : `t.${ecBid(id)}`;

  const needWidget = plan.some(s => s.kind === 'create' && s.node.kind === 'widget');
  const needTabset = plan.some(s => s.kind === 'create' && s.node.kind === 'tab');

  // Page root (owns widgets) + tabset (owns tabs) are both reached by business id with `t.<id>`.
  // This is uniform across page types: t.<scorecardId> resolves a Scorecard, t.<templateId> an
  // EnterpriseTemplate — whereas `SELECT EnterpriseTemplate` fails (templates aren't SELECT-able).
  // So we never SELECT the root; `pageClass` is metadata only. (Verified live 2026-06-26.)
  const lines: string[] = [];
  if (needWidget) lines.push(`_sc := t.${ecBid(m.pageId)}`);
  if (needTabset) lines.push(`_ts := t.${ecBid(m.tabsetId)}`);

  const notes: PlanNote[] = [];
  let k = 0;
  const emit = (note: PlanNote) => { lines.push(note.ec!); notes.push(note); };

  for (const s of plan) {
    switch (s.kind) {
      case 'create': {
        const v = `_n${k++}`;
        vars.set(s.node.id, v);
        const n = s.node;
        // Destination phrasing so the preview is explicit about WHERE a new node lands (and whether a
        // container is being created vs a widget added to existing structure).
        const par = byId.get(s.parentId);
        const where = par ? (par.kind === 'tab' ? `tab "${par.name}"` : `container "${par.name}"`) : 'the page';
        if (n.kind === 'tab') {
          emit({ verb: 'create', text: `Create tab "${n.name}"`,
            ec: `${v} := _ts.add(Tab, name := ${ecStr(n.name)}, columnsLargeScreen := ${n.cols.L}${colsSuffix(n.cols)}) // BMP assigns id` });
        } else if (n.kind === 'container') {
          emit({ verb: 'create', text: `Create new container "${n.name}" (${n.cols.L}/6) in ${where}`,
            ec: `${v} := ${ref(s.parentId)}.add(Container, name := ${ecStr(n.name)}, columnsLargeScreen := ${n.cols.L}${colsSuffix(n.cols)}) // BMP assigns id` });
        } else if (s.parentKind === 'widget') {
          // Composite child (e.g. a button in a ButtonContainer): the child is added to the COMPOSITE
          // itself (`<composite>.add(Child)`), NOT bound to a portal cell — its parent is the composite
          // (verified live). Only valid for known composite types; a plain-widget parent is rejected.
          const parentClass = byId.get(s.parentId)?.className;
          if (!parentClass || !COMPOSITE_TYPES.has(parentClass)) {
            throw new Error(`cannot add ${n.className} into a ${parentClass ?? 'widget'}; it is not a composite container`);
          }
          emit({ verb: 'create', text: `Create ${n.className} "${n.name}" in ${parentClass}`,
            ec: `${v} := ${ref(s.parentId)}.add(${ecClass(n.className)}, name := ${ecStr(n.name)}) // BMP assigns id` });
        } else {
          const h = n.height != null ? `, chartHeight := ${n.height}` : '';
          emit({ verb: 'create', text: `Add ${n.className} "${n.name}" (${n.cols.L}/6) to ${where}`,
            ec: `${v} := _sc.add(${ecClass(n.className)}, name := ${ecStr(n.name)}, container := ${ref(s.parentId)}, columnsLargeScreen := ${n.cols.L}${colsSuffix(n.cols)}${h}) // BMP assigns id` });
        }
        break;
      }
      case 'update': {
        const parts: string[] = [];
        // null col/height = CLEARED. BMP has no verified clear verb for these (`:= MISSING` is a
        // no-op), so we skip serving it — the null exists only so the stale-guard sees a concurrent
        // clear as drift. If a step is ONLY clears, parts is empty; omit it rather than emit `change()`.
        if (s.cols) (['L', 'M', 'S'] as Breakpoint[]).forEach(bp => { if (s.cols![bp] != null) parts.push(`${COL_PROP[bp]} := ${s.cols![bp]}`); });
        if (s.name != null) parts.push(`name := ${ecStr(s.name)}`);
        if (s.height != null) parts.push(`chartHeight := ${s.height}`);
        // G3 appearance: colour links → `prop := t.<bid>` (or `:= ""` to clear), scalars → ecScalar. The
        // shared `styleAssignRhs` (also used by the side-panel apply) decides which, so the two paths
        // can't diverge. A malformed colour bid aborts the whole compile rather than emit bad EC.
        for (const a of s.styleAssign ?? []) {
          const rhs = styleAssignRhs(a.prop, a.value, ecScalar);
          if (rhs === INVALID_COLOR_BID) throw new Error(`invalid colour id for ${a.prop} on "${byId.get(s.id)?.name ?? s.id}"`);
          parts.push(`${a.prop} := ${rhs}`);
        }
        const resets = (s.resetProps ?? []).filter(p => RESETTABLE.has(p)); // F2 — revert override to template
        if (!parts.length && !resets.length) break;
        const label = byId.get(s.id)?.name ?? s.id;
        if (parts.length) emit({ verb: 'update', text: `Update "${label}" (${parts.length} change${parts.length > 1 ? 's' : ''})`,
          ec: `${ref(s.id)}.change(${parts.join(', ')})` });
        // `.reset(<prop>)` drops the instance override so the property re-inherits the template's value.
        for (const p of resets) emit({ verb: 'update', text: `Reset "${label}" ${p} to template`, ec: `${ref(s.id)}.reset(${p})` });
        break;
      }
      case 'reparent': {
        const field = s.nodeKind === 'widget' ? 'container' : 'parent';
        const label = byId.get(s.id)?.name ?? s.id;
        emit({ verb: 'move', text: `Move "${label}" into ${byId.get(s.toParentId)?.name ?? s.toParentId}`,
          ec: `${ref(s.id)}.change(${field} := ${ref(s.toParentId)})` });
        break;
      }
      case 'reorder': {
        const label = byId.get(s.id)?.name ?? s.id;
        emit({ verb: 'reorder', text: `Reorder "${label}"`,
          ec: `${ref(s.id)}.moveAfter(${ref(s.afterId)})` });
        break;
      }
      case 'delete': {
        emit({ verb: 'delete', text: `Delete ${s.nodeKind} (${s.className})`,
          ec: `${refDeleted(s.id, s.rid)}.delete()` });
        break;
      }
    }
  }

  return { script: lines.join('\n'), notes };
}
