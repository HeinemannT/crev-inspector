/**
 * Flow editing — the PURE core for the blueprint flow layer (add-within, reorder, action-button flag
 * flips). Parallel to the layout edit/diff engine; deliberately separate so the layout diff stays
 * byte-identical (pitfall #1) and flow state can be staged/deduped by businessId (pitfall #2).
 *
 * Read model:
 *   - `LModel.flows`      — read-only projections, keyed by flow-WIDGET businessId (from the fetch).
 *   - `LModel.flowEdits`  — staged edits, keyed by the CONTAINER (InputSet/EditPage/ButtonGroup) or the
 *                           action-button businessId. The ONLY flow state `flowDiff` compares.
 *
 * A "container key" (for add/reorder) is an InputSet/EditPage/ButtonGroup businessId. Two InputViews
 * backed by one InputSet share the same key, so an edit from either cell stages once (dedupe by key).
 */
import { cloneModel, tempId } from './model';
import type { FlowEdit, FlowNode, LModel, PlanStep } from './types';

/** The resolved container an add/reorder targets: its class + rid + ORIGINAL (fetched) children. */
export interface FlowContainer {
  key: string;
  className: string;
  rid?: string;
  /** the projection's ORIGINAL ordered children (never the staged ones). */
  original: FlowNode[];
}

/** Locate the flow container addressed by `key`: an InputSet/EditPage (a projection's `refId`) or a
 *  nested ButtonGroup (a FlowNode inside a projection). Returns null when `key` names no container. */
export function findFlowContainer(m: LModel, key: string): FlowContainer | null {
  const flows = m.flows;
  if (!flows) return null;
  for (const p of Object.values(flows)) {
    if (p.refId === key) return { key, className: p.refClass ?? 'InputSet', rid: p.refRid, original: p.children };
    // a nested ButtonGroup lives one level down in a projection's children
    for (const c of p.children) {
      if (c.id === key && c.children) return { key, className: c.className || 'ButtonGroup', rid: c.rid, original: c.children };
    }
  }
  return null;
}

/** The staged `FlowEdit` for `key`, or undefined. */
const editOf = (m: LModel, key: string): FlowEdit | undefined => m.flowEdits?.[key];

/** The EFFECTIVE (rendered) children of a flow container: original children + staged adds, reordered by
 *  the staged `order` when present (ids in `order` first, then any not listed, in their natural order).
 *  Pure — used by BOTH the renderer and the diff, so what the user sees is exactly what compiles. */
export function effectiveFlowChildren(m: LModel, key: string): FlowNode[] {
  const container = findFlowContainer(m, key);
  if (!container) return [];
  const e = editOf(m, key);
  const natural = [...container.original, ...(e?.adds ?? [])];
  if (!e?.order) return natural;
  const byId = new Map(natural.map(n => [n.id, n]));
  const ordered: FlowNode[] = [];
  for (const id of e.order) { const n = byId.get(id); if (n) { ordered.push(n); byId.delete(id); } }
  for (const n of natural) if (byId.has(n.id)) ordered.push(n); // anything the order list missed
  return ordered;
}

/** Immutable helper: clone the model and ensure a mutable `flowEdits[key]` entry exists, then run `fn`. */
function withFlowEdit(m: LModel, key: string, fn: (e: FlowEdit) => void): LModel {
  const c = cloneModel(m);
  const edits = (c.flowEdits ??= {});
  const e = (edits[key] ??= {});
  fn(e);
  // Drop an entry that ended up empty (e.g. a flag toggled back to its projection value).
  if (!e.adds?.length && !e.order && e.displayOnActionMenu === undefined && e.displayOnAllTabs === undefined) delete edits[key];
  return c;
}

/** Stage a new child in a flow container (type + name only — no property forms). `afterId` inserts right
 *  after that sibling (else appended). Returns the new model + the staged child's temp id. */
export function addFlowChild(m: LModel, key: string, className: string, name?: string, afterId?: string): { model: LModel; id: string } {
  const id = tempId('flow');
  const isBreak = className === 'EditPageBreak' || className === 'EditPageColumnBreak';
  const node: FlowNode = { id, className, name: name ?? `New ${className}`, ...(isBreak ? { isBreak: true } : {}) };
  const model = withFlowEdit(m, key, e => {
    (e.adds ??= []).push(node);
    // Placement: append by default. When inserting after a specific sibling, materialise the current
    // effective order (incl. this new node appended) and splice the new id into place → an `order` edit.
    if (afterId) {
      const cur = effectiveFlowChildren({ ...m, flowEdits: { ...(m.flowEdits ?? {}), [key]: { ...(m.flowEdits?.[key] ?? {}), adds: [...(m.flowEdits?.[key]?.adds ?? []), node] } } }, key).map(n => n.id);
      const at = cur.indexOf(afterId);
      const without = cur.filter(x => x !== id);
      const insertAt = at >= 0 ? without.indexOf(afterId) + 1 : without.length;
      without.splice(insertAt, 0, id);
      e.order = without;
    }
  });
  return { model, id };
}

/** Stage a reorder within one flow container: move `id` to directly after `afterId` (or to the front
 *  when `afterId` is null). Records the full desired order on the edit. */
export function reorderFlowChild(m: LModel, key: string, id: string, afterId: string | null): LModel {
  const cur = effectiveFlowChildren(m, key).map(n => n.id);
  if (!cur.includes(id)) return m;
  const without = cur.filter(x => x !== id);
  const at = afterId ? without.indexOf(afterId) : -1;
  without.splice(at + 1, 0, id); // afterId not found → at=-1 → index 0 (front)
  return withFlowEdit(m, key, e => { e.order = without; });
}

/** Remove a STAGED add (temp-id child) from a flow container. Existing children are not deletable in
 *  blueprint (delete lives in Inspect); this only cancels a not-yet-applied add. */
export function removeFlowAdd(m: LModel, key: string, id: string): LModel {
  if (!m.flowEdits?.[key]?.adds?.some(a => a.id === id)) return m;
  return withFlowEdit(m, key, e => {
    e.adds = (e.adds ?? []).filter(a => a.id !== id);
    if (e.order) e.order = e.order.filter(x => x !== id);
  });
}

/** Stage an action-button flag flip (displayOnActionMenu = in-grid ↔ action bar; displayOnAllTabs =
 *  tray scope). `key` is the button's businessId. Toggling back to the projection's value clears it. */
export function setActionFlag(m: LModel, key: string, prop: 'displayOnActionMenu' | 'displayOnAllTabs', value: boolean): LModel {
  const proj = m.flows?.[key];
  return withFlowEdit(m, key, e => {
    if (proj && (proj[prop] ?? false) === value) delete e[prop];
    else e[prop] = value;
  });
}

/** Stage a NEW action-menu button under the page (born displayOnActionMenu := true). `tabContainer` is
 *  the tab/RESULT binding. Keyed by its own temp id in flowEdits (an `adds` list with one entry marks it
 *  a page-level create — the compiler recognises an ActionButton add whose container key is a `new:` id). */
export function addActionButton(m: LModel, tabContainer: string, name?: string): { model: LModel; id: string } {
  const id = tempId('flowab');
  const node: FlowNode = { id, className: 'ActionButton', name: name ?? 'New Action', prop: tabContainer };
  const model = withFlowEdit(m, id, e => { e.adds = [node]; e.displayOnActionMenu = true; });
  return { model, id };
}

// ── flow diff ────────────────────────────────────────────────────────────────────────────────────

/** Diff the staged flow edits into plan steps. Keyed by businessId, so an edit staged from two cells is
 *  processed ONCE (pitfall #2). Emits nothing when `flowEdits` is empty — so a freshly-loaded model (and
 *  the layout-only regression) is byte-identical to one without flow (pitfall #1). Order: flowCreate →
 *  flowReorder → flowFlag (creates before the moves that may reference them; flags are independent). */
export function flowDiff(_baseline: LModel, desired: LModel): PlanStep[] {
  const edits = desired.flowEdits;
  if (!edits) return [];
  const creates: PlanStep[] = [];
  const reorders: PlanStep[] = [];
  const flags: PlanStep[] = [];

  for (const [key, e] of Object.entries(edits)) {
    // A NEW page-level ActionButton: the key is a temp id and the single add IS the button. Its `prop`
    // carries the tab/RESULT container binding. Emit a widget-style create + its flag.
    const pageAdd = key.includes(':') && e.adds?.length === 1 && e.adds[0].className === 'ActionButton';
    if (pageAdd) {
      const n = e.adds![0];
      creates.push({ kind: 'flowCreate', node: n, parentId: '*page*', parentClass: 'Scorecard' });
      flags.push({ kind: 'flowFlag', id: n.id, className: 'ActionButton', prop: 'displayOnActionMenu', value: true });
      continue;
    }

    const container = findFlowContainer(desired, key);
    // adds
    for (const add of e.adds ?? []) {
      creates.push({ kind: 'flowCreate', node: add, parentId: key, parentClass: container?.className ?? 'InputSet', ...(container?.rid ? { parentRid: container.rid } : {}) });
    }
    // reorder — only when the desired order genuinely differs from the natural (original + adds appended)
    if (e.order && container) {
      const natural = [...container.original.map(c => c.id), ...(e.adds ?? []).map(a => a.id)];
      const desiredOrder = effectiveFlowChildren(desired, key).map(n => n.id);
      if (desiredOrder.join(' ') !== natural.join(' ') && desiredOrder.length > 1) {
        const ridOf = (id: string): string | undefined =>
          container.original.find(c => c.id === id)?.rid ?? (e.adds ?? []).find(a => a.id === id)?.rid;
        for (let i = 1; i < desiredOrder.length; i++) {
          reorders.push({ kind: 'flowReorder', id: desiredOrder[i], afterId: desiredOrder[i - 1], parentId: key, ...(ridOf(desiredOrder[i]) ? { rid: ridOf(desiredOrder[i]) } : {}) });
        }
      }
    }
    // flags — compare against the projection's current value; only emit a genuine change
    const proj = desired.flows?.[key];
    for (const prop of ['displayOnActionMenu', 'displayOnAllTabs'] as const) {
      const v = e[prop];
      if (v !== undefined && (proj?.[prop] ?? false) !== v) {
        flags.push({ kind: 'flowFlag', id: key, className: proj?.ownerClass ?? 'ActionButton', prop, value: v, ...(proj?.ownerRid ? { rid: proj.ownerRid } : {}) });
      }
    }
  }
  return [...creates, ...reorders, ...flags];
}

/** Count of distinct flow objects the edits touch — for the pending-changes headline. */
export function flowChangeCount(m: LModel): number {
  return Object.keys(m.flowEdits ?? {}).length;
}

// ── action-menu tray ─────────────────────────────────────────────────────────────────────────────

export interface TrayEntry {
  p: import('./types').FlowProjection;
  /** The button is STAGED to leave the tray for the grid (displayOnActionMenu → false). It keeps its
   *  card until Apply (it has no grid cell to move to before the reload), marked "moves to grid". */
  leaving?: boolean;
}
export interface TrayModel {
  /** Cards shown for the viewed tab, in fetch order: the tab's own buttons + displayOnAllTabs ones. */
  shown: TrayEntry[];
  /** Menu buttons bound to OTHER tabs (not shown) — the honest count note. */
  otherTabs: number;
}

/** Which action-menu buttons the tray shows for `viewedTabId` — only menu buttons (staged flag flips
 *  respected via flowEdits), filtered to the viewed tab's own + `displayOnAllTabs` ones. Tab attribution
 *  is the button's `container` binding; a RESULT-bound button renders on every tab (BMP renders the
 *  shared Result tab's widgets under each tab), so it counts as "this tab" everywhere. A fetched menu
 *  button staged to the grid STAYS in the tray flagged `leaving` (it owns no grid cell until the
 *  post-apply reload). Pure — the tray renderer and its test both consume this. */
export function trayButtons(m: LModel, viewedTabId: string | null): TrayModel {
  const shown: TrayEntry[] = [];
  let otherTabs = 0;
  for (const p of Object.values(m.flows ?? {})) {
    if (p.ownerClass !== 'ActionButton') continue;
    const e = m.flowEdits?.[p.ownerId];
    const fetched = p.displayOnActionMenu ?? false;
    const onMenu = e?.displayOnActionMenu ?? fetched;
    if (!onMenu && !fetched) continue; // never menu-visible
    const allTabs = e?.displayOnAllTabs ?? p.displayOnAllTabs ?? false;
    const boundTab = p.container ?? '';
    const onThisTab = allTabs || boundTab === 'RESULT' || boundTab === '' || boundTab === viewedTabId;
    if (onThisTab) shown.push({ p, ...(fetched && !onMenu ? { leaving: true } : {}) });
    else otherTabs++;
  }
  return { shown, otherTabs };
}

/** A stable signature of every flow projection's child order + membership + action-button flags — so the
 *  apply rollback guard can tell whether a PURELY-flow change actually landed (the layout diff can't see
 *  flow, since flow rows live outside the LNode tree). Two loads with identical flow produce identical
 *  signatures; a landed add/reorder/flag flip changes it. */
export function flowSignature(m: LModel): string {
  const flows = m.flows ?? {};
  const childSig = (children: FlowNode[]): string =>
    children.map(c => c.id + (c.children?.length ? `[${childSig(c.children)}]` : '')).join(',');
  return Object.keys(flows).sort().map(k => {
    const p = flows[k];
    return `${k}:${p.displayOnActionMenu ? 1 : 0}${p.displayOnAllTabs ? 1 : 0}:${childSig(p.children)}`;
  }).join('|');
}
