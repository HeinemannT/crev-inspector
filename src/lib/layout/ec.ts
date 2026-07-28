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
import { existingSupportCategory } from './flow';
import { COMPOSITE_TYPES } from './constraints';
// Shared EC sanitisation (escaping + identifier/id validation) — the same guards the other EC
// generators use. ecClass/ecBid are thin aliases; ecStr wraps the shared escaper in quotes.
import { formatEcLiteral, validateEcIdentifier as ecClass, validateBusinessId as ecBid, validateRid as ecRid } from '../ec-guards';
import { styleAssignRhs, INVALID_COLOR_BID } from '../style-ec';
import { OVERRIDABLE_PROPS, styleAssignments } from './types';
import type { Breakpoint, FlowNode, LModel, LNode, PlanNote, PlanStep } from './types';

const ecStr = (s: string): string => `"${formatEcLiteral(s)}"`;
/** Scalar EC literal — booleans → TRUE/FALSE, numbers as-is, strings quoted + escaped. Mirrors
 *  BmpClient.formatEcLiteral so the blueprint apply and the side-panel apply format style values
 *  identically (the shared `styleAssignRhs` delegates non-colour props here). */
const ecScalar = (v: string | number | boolean): string =>
  typeof v === 'boolean' ? (v ? 'TRUE' : 'FALSE') : typeof v === 'number' ? String(v) : ecStr(v);

/** Compile a list of `(prop, value)` appearance assignments to `prop := rhs` EC fragments via the shared
 *  `styleAssignRhs` (colour links → t.<bid> or "" to clear; scalars → ecScalar). Shared by the create and
 *  update paths. A malformed colour bid aborts the whole compile (better than emitting bad EC). */
function styleEcParts(assigns: { prop: string; value: string | number | boolean }[], label: string): string[] {
  return assigns.map(a => {
    const rhs = styleAssignRhs(a.prop, a.value, ecScalar);
    if (rhs === INVALID_COLOR_BID) throw new Error(`invalid colour id for ${a.prop} on "${label}"`);
    return `${a.prop} := ${rhs}`;
  });
}

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
  const parentById = new Map<string, string>();
  walk(m, (n, parent) => { byId.set(n.id, n); if (parent) parentById.set(n.id, parent.id); });
  const flowById = new Map<string, { name: string; className: string }>();
  const addFlowNodes = (nodes: FlowNode[]) => nodes.forEach(n => {
    flowById.set(n.id, n);
    if (n.children) addFlowNodes(n.children);
  });
  Object.values(m.flows ?? {}).forEach(p => addFlowNodes(p.children));
  Object.values(m.flowEdits ?? {}).forEach(e => { if (e.adds) addFlowNodes(e.adds); });
  const flowOwner = (id: string) => byId.get(id)
    ?? (m.flows?.[id]?.ownerName ? { name: m.flows[id].ownerName!, className: m.flows[id].ownerClass } : undefined);
  // Reorders in a group that also receives a newly-created object are EC placement mechanics, not a
  // separate user change. Keep the EC, but omit that implementation detail from the human log.
  const createParents = new Set(plan.flatMap(s => s.kind === 'create' || s.kind === 'flowCreate' ? [s.parentId] : []));

  const vars = new Map<string, string>();
  // Reference an object in EC. New nodes from this batch → their `_n<k>` var. Existing nodes →
  // `t.<businessId>`, EXCEPT a node that carries no businessId (reconstruct fell its `id` back to
  // the rid, so `id === rid`): `t.<rid>` does NOT resolve (the `t.` namespace is businessId-keyed,
  // and an all-digit rid slips past the businessId validator), so it would silently mis-target.
  // Address those by rid via `lookup(<rid>)` instead — the same way the fetch reaches the page root.
  // Address an EXISTING object by businessId — `t.<businessId>` — EXCEPT one that carries no businessId
  // (reconstruct fell its `id` back to the rid, so `id === rid`): `t.<rid>` does NOT resolve (the `t.`
  // namespace is businessId-keyed, and an all-digit rid slips past the businessId validator), so address
  // those by rid via `lookup(<rid>)` — the same way the fetch reaches the page root. Shared tail below.
  const bidOrLookup = (id: string, rid?: string): string =>
    (rid && id === rid) ? `lookup(${ecRid(rid)})` : `t.${ecBid(id)}`;

  // Reference a layout node: a `_n<k>` var when created in this batch, else by businessId/lookup.
  const ref = (id: string): string => vars.get(id) ?? bidOrLookup(id, byId.get(id)?.rid);
  /** ref() for a node that may not be in the desired model (a delete subject lives only in the
   *  baseline). Falls back to the threaded rid for the businessId-less case, since byId can't see it. */
  const refDeleted = (id: string, rid?: string): string => bidOrLookup(id, rid);

  /** Flow-step object reference: a staged flow add captured in a `_ff<k>` var, else the businessId
   *  (or `lookup(rid)` for a businessId-less row — pitfall #5). Flow children live outside the LNode
   *  tree, so `byId` never has them; they address by businessId directly. */
  const fref = (id: string, rid?: string): string => vars.get(id) ?? bidOrLookup(id, rid);

  const needWidget = plan.some(s => s.kind === 'create' && s.node.kind === 'widget');
  const needTabset = plan.some(s => s.kind === 'create' && s.node.kind === 'tab');
  // A page-level flow create (a brand-new action-menu button) is added to the scorecard, like a widget.
  const needFlowSc = plan.some(s => s.kind === 'flowCreate' && s.parentId === '*page*');

  // Page root (owns widgets) + tabset (owns tabs) are both reached by business id with `t.<id>`.
  // This is uniform across page types: t.<scorecardId> resolves a Scorecard, t.<templateId> an
  // EnterpriseTemplate — whereas `SELECT EnterpriseTemplate` fails (templates aren't SELECT-able).
  // So we never SELECT the root; `pageClass` is metadata only. (Verified live 2026-06-26.)
  const lines: string[] = [];
  if (needWidget || needFlowSc) lines.push(`_sc := t.${ecBid(m.pageId)}`);

  const notes: PlanNote[] = [];
  let k = 0;
  let fk = 0; // flow-create var counter (`_ff<fk>`) — distinct namespace from layout's `_n<k>`
  const emit = (note: PlanNote, visible = true) => { lines.push(note.ec!); if (visible) notes.push(note); };

  // The ONE support Category for this apply — shared by the virtual-tabset create AND every new
  // InputSet/EditPage. Reuse an on-page reference's existing Category (co-locate) rather than making a
  // duplicate; else create ONE `root.portal.add(Category, name := <page display name>)` lazily,
  // captured in `_fcat`, and reuse it across steps. (EditPage is REFUSED at portal root, so the
  // Category is mandatory and used uniformly — verified live 2026-07-12: a single Category holds a
  // TabSet + its Tabs, InputSets, and EditPages together.)
  const existingCat = existingSupportCategory(m);
  const supportCatName = existingCat?.name ?? m.pageName ?? m.pageId;
  let supportCatRef: string | null = existingCat ? `t.${ecBid(existingCat.id)}` : null;
  const ensureSupportCat = (): string => {
    if (supportCatRef) return supportCatRef;
    emit({ verb: 'create', text: `Create support Category "${supportCatName}" in Portal`,
      action: 'Add', object: supportCatName, objectType: 'Category', where: 'Portal',
      ec: `_fcat := root.portal.add(Category, name := ${ecStr(supportCatName)}) // page support folder` });
    supportCatRef = '_fcat';
    return supportCatRef;
  };

  // A STAGED (virtual) tabset has no businessId yet — create it in the SAME EC as its tabs, landing it
  // in the shared support Category so a page's new tabset + new sets/pages all
  // live in ONE folder named after the page. Otherwise reference the existing tabset by business id.
  if (needTabset) {
    if (m.tabsetVirtual) {
      const cat = ensureSupportCat();
      const tsName = m.tabsetName ?? '» New TabSet';
      emit({ verb: 'create', text: `Create tabset "${tsName}" in ${supportCatName}`,
        action: 'Add', object: tsName, objectType: 'TabSet', where: supportCatName,
        ec: `_ts := ${cat}.add(TabSet, name := ${ecStr(tsName)}) // BMP assigns id` });
    }
  }
  const tabsetRef = (id: string): string =>
    m.tabsetVirtual && id === m.tabsetId ? '_ts' : `t.${ecBid(id)}`;

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
          const owner = m.tabsets?.find(t => t.id === s.parentId);
          emit({ verb: 'create', id: n.id, text: `Create tab "${n.name}"`,
            action: 'Add', object: n.name, objectType: 'Tab', where: owner?.name ?? s.parentId, detail: `${n.cols.L}/6`,
            ec: `${v} := ${tabsetRef(s.parentId)}.add(Tab, name := ${ecStr(n.name)}, columnsLargeScreen := ${n.cols.L}${colsSuffix(n.cols)}) // BMP assigns id` });
        } else if (n.kind === 'container') {
          emit({ verb: 'create', id: n.id, text: `Create new container "${n.name}" (${n.cols.L}/6) in ${where}`,
            action: 'Add', object: n.name, objectType: 'Container', where: par?.name, detail: `${n.cols.L}/6`,
            ec: `${v} := ${ref(s.parentId)}.add(Container, name := ${ecStr(n.name)}, columnsLargeScreen := ${n.cols.L}${colsSuffix(n.cols)}) // BMP assigns id` });
        } else if (s.parentKind === 'widget') {
          // Composite child (e.g. a button in a ButtonContainer): the child is added to the COMPOSITE
          // itself (`<composite>.add(Child)`), NOT bound to a portal cell — its parent is the composite
          // (verified live). Only valid for known composite types; a plain-widget parent is rejected.
          const parentClass = byId.get(s.parentId)?.className;
          if (!parentClass || !COMPOSITE_TYPES.has(parentClass)) {
            throw new Error(`cannot add ${n.className} into a ${parentClass ?? 'widget'}; it is not a composite container`);
          }
          emit({ verb: 'create', id: n.id, text: `Create ${n.className} "${n.name}" in ${parentClass}`,
            action: 'Add', object: n.name, objectType: n.className, where: par?.name,
            ec: `${v} := ${ref(s.parentId)}.add(${ecClass(n.className)}, name := ${ecStr(n.name)}) // BMP assigns id` });
        } else {
          const h = n.height != null ? `, chartHeight := ${n.height}` : '';
          emit({ verb: 'create', id: n.id, text: `Add ${n.className} "${n.name}" (${n.cols.L}/6) to ${where}`,
            action: 'Add', object: n.name, objectType: n.className, where: par?.name, detail: `${n.cols.L}/6`,
            ec: `${v} := _sc.add(${ecClass(n.className)}, name := ${ecStr(n.name)}, container := ${ref(s.parentId)}, columnsLargeScreen := ${n.cols.L}${colsSuffix(n.cols)}${h}) // BMP assigns id` });
        }
        // G3: a widget created AND styled in the same batch carries its appearance on `n.style`. The create
        // above has no baseline (diff couldn't pair it for an update), so emit the style as a follow-up
        // `.change()` on the just-captured `_n<k>` var — the verified set-a-style path. (Tabs/containers
        // never carry style, so styleAssignments returns [].)
        {
          const sa = styleAssignments(undefined, n.style);
          if (sa.length) emit({ verb: 'update', id: n.id, text: `Style "${n.name}"`,
            action: 'Style', object: n.name, objectType: n.className, detail: sa.map(a => a.prop).join(', '),
            ec: `${v}.change(${styleEcParts(sa, n.name).join(', ')})` });
        }
        break;
      }
      case 'update': {
        const parts: string[] = [];
        const what: string[] = []; // friendly qualifiers for the log's detail column, parallel to parts
        // null col/height = CLEARED. BMP has no verified clear verb for these (`:= MISSING` is a
        // no-op), so we skip serving it — the null exists only so the stale-guard sees a concurrent
        // clear as drift. If a step is ONLY clears, parts is empty; omit it rather than emit `change()`.
        if (s.cols) (['L', 'M', 'S'] as Breakpoint[]).forEach(bp => {
          if (s.cols![bp] != null) { parts.push(`${COL_PROP[bp]} := ${s.cols![bp]}`); what.push(bp === 'L' ? `${s.cols![bp]}/6` : `${s.cols![bp]}/6·${bp}`); }
        });
        if (s.name != null) { parts.push(`name := ${ecStr(s.name)}`); what.push(`→ "${s.name}"`); }
        if (s.height != null) { parts.push(`chartHeight := ${s.height}`); what.push(`${s.height}px`); }
        // G3 appearance edits — same shared compiler as the create path (styleEcParts).
        const styleCount = s.styleAssign?.length ?? 0;
        if (s.styleAssign?.length) {
          parts.push(...styleEcParts(s.styleAssign, byId.get(s.id)?.name ?? s.id));
          what.push(...s.styleAssign.map(a => a.prop));
        }
        const resets = (s.resetProps ?? []).filter(p => RESETTABLE.has(p)); // F2 — revert override to template
        if (!parts.length && !resets.length) break;
        const label = byId.get(s.id)?.name ?? s.id;
        const cls = byId.get(s.id)?.className;
        if (parts.length) emit({ verb: 'update', id: s.id, text: `Update "${label}" (${parts.length} change${parts.length > 1 ? 's' : ''})`,
          action: styleCount === parts.length ? 'Style' : 'Change', object: label, objectType: cls, detail: what.join(', '),
          ec: `${ref(s.id)}.change(${parts.join(', ')})` });
        // `.reset(<prop>)` drops the instance override so the property re-inherits the template's value.
        for (const p of resets) emit({ verb: 'update', id: s.id, text: `Reset "${label}" ${p} to template`,
          action: 'Reset', object: label, objectType: cls, detail: `${p} → template`,
          ec: `${ref(s.id)}.reset(${p})` });
        break;
      }
      case 'reparent': {
        const field = s.nodeKind === 'widget' ? 'container' : 'parent';
        const label = byId.get(s.id)?.name ?? s.id;
        const dest = byId.get(s.toParentId)?.name ?? s.toParentId;
        emit({ verb: 'move', id: s.id, text: `Move "${label}" into ${dest}`,
          action: 'Move', object: label, objectType: byId.get(s.id)?.className, where: dest,
          ec: `${ref(s.id)}.change(${field} := ${ref(s.toParentId)})` });
        break;
      }
      case 'reorder': {
        const label = byId.get(s.id)?.name ?? s.id;
        const anchor = s.beforeId ?? s.afterId!;
        emit({ verb: 'reorder', id: s.id, text: `Reorder "${label}"`,
          action: 'Reorder', object: label, objectType: byId.get(s.id)?.className,
          detail: `${s.beforeId ? 'before' : 'after'} "${byId.get(anchor)?.name ?? anchor}"`,
          ec: `${ref(s.id)}.${s.beforeId ? 'moveBefore' : 'moveAfter'}(${ref(anchor)})` },
          !createParents.has(parentById.get(s.id) ?? ''));
        break;
      }
      case 'delete': {
        emit({ verb: 'delete', id: s.id, text: `Delete ${s.nodeKind} (${s.className})`,
          action: 'Delete', object: s.name ?? s.id, objectType: s.className,
          ec: `${refDeleted(s.id, s.rid)}.delete()` });
        break;
      }
      // ── Flow steps (blueprint flow editing) ───────────────────────────────────────────────────
      case 'flowCreate': {
        const v = `_ff${fk++}`;
        vars.set(s.node.id, v);
        if (s.parentId === '*page*') {
          // A new action-menu button: added to the scorecard, born displayOnActionMenu (the flowFlag that
          // follows sets it). `node.prop` carries the tab/RESULT container binding staged with it.
          const cont = s.node.prop ? `, container := ${fref(s.node.prop)}` : '';
          emit({ verb: 'create', id: s.node.id, text: `Add action "${s.node.name}" to the action menu`,
            action: 'Add', object: s.node.name, objectType: 'ActionButton', where: 'action menu',
            ec: `${v} := _sc.add(ActionButton, name := ${ecStr(s.node.name)}${cont}) // BMP assigns id` });
        } else if (s.parentId === '*support*') {
          // A new InputSet/EditPage lands in the page's ONE support Category — the shared resolver
          // reuses an on-page reference's existing Category (co-locate) or lazily creates one named
          // after the page, so a set + a page (+ a new tabset) created together all share it.
          const cat = ensureSupportCat();
          const typeArg = s.node.className === 'EditPage' && s.editPageType
            ? `, types := list(${ecClass(s.editPageType)})`
            : '';
          emit({ verb: 'create', id: s.node.id, text: `Create ${s.node.className} "${s.node.name}" in ${supportCatName}`,
            action: 'Add', object: s.node.name, objectType: s.node.className, where: supportCatName,
            ec: `${v} := ${cat}.add(${ecClass(s.node.className)}, name := ${ecStr(s.node.name)}${typeArg}) // BMP assigns id` });
        } else {
          emit({ verb: 'create', id: s.node.id, text: `Add ${s.node.className} "${s.node.name}" to ${s.parentClass}`,
            action: 'Add', object: s.node.name, objectType: s.node.className, where: s.parentClass,
            ec: `${v} := ${fref(s.parentId, s.parentRid)}.add(${ecClass(s.node.className)}, name := ${ecStr(s.node.name)}) // BMP assigns id` });
        }
        break;
      }
      case 'flowWire': {
        // `prop` is a closed union ('inputSet' | 'editPage') — injection-safe by type. setCreateMode
        // folds the verified EDITORADD flip into the same change() (an ADD-mode COV ignores editPage —
        // change(createMode := "EDITORADD") round-trip execute-verified on t.50842, 2026-07-12).
        const mode = s.setCreateMode ? `, createMode := "EDITORADD"` : '';
        const tgt = s.targetName ?? s.targetId;
        const owner = flowOwner(s.id);
        emit({ verb: 'update', id: s.id, text: `Wire ${s.prop} to "${tgt}"`,
          action: 'Change', object: owner?.name ?? s.id, objectType: owner?.className,
          detail: `${s.prop} → "${tgt}"${s.setCreateMode ? ' · createMode → EDITOR ADD' : ''}`,
          ec: `${fref(s.id, s.rid)}.change(${s.prop} := ${fref(s.targetId)}${mode})` });
        break;
      }
      case 'flowRename': {
        // Rename an existing flow object: `<obj>.change(name := "…")`. Name is hostile input — ecStr
        // escapes it. fref() addresses it by businessId (or lookup(rid) for a businessId-less row).
        emit({ verb: 'update', id: s.id, text: `Rename to "${s.name}"`,
          action: 'Change', object: s.name, objectType: s.className, detail: `name → "${s.name}"`,
          ec: `${fref(s.id, s.rid)}.change(name := ${ecStr(s.name)})` });
        break;
      }
      case 'flowReorder': {
        const anchor = s.beforeId ?? s.afterId!;
        const node = flowById.get(s.id);
        const anchorNode = flowById.get(anchor);
        emit({ verb: 'reorder', id: s.id, text: `Reorder flow element`,
          action: 'Reorder', object: node?.name ?? s.id, objectType: node?.className,
          detail: `${s.beforeId ? 'before' : 'after'} "${anchorNode?.name ?? anchor}"`,
          ec: `${fref(s.id, s.rid)}.${s.beforeId ? 'moveBefore' : 'moveAfter'}(${fref(anchor)})` },
          !createParents.has(s.parentId));
        break;
      }
      case 'flowFlag': {
        const label = s.prop === 'displayOnActionMenu' ? (s.value ? 'move to action bar' : 'move to grid') : (s.value ? 'show on all tabs' : 'show on this tab only');
        const owner = flowOwner(s.id);
        emit({ verb: 'update', id: s.id, text: `Action button: ${label}`,
          action: 'Change', object: owner?.name ?? s.id, objectType: owner?.className ?? s.className, detail: `${s.prop} := ${s.value ? 'TRUE' : 'FALSE'}`,
          ec: `${fref(s.id, s.rid)}.change(${s.prop} := ${s.value ? 'TRUE' : 'FALSE'})` });
        break;
      }
    }
  }

  return { script: lines.join('\n'), notes };
}
