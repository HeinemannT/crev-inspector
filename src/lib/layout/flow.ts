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
import { cloneModel, findTabOf, tempId } from './model';
import { minimalReorder } from './reorder';
import type { FlowEdit, FlowNode, LModel, PlanStep } from './types';

/** The resolved container an add/reorder targets: its class + rid + ORIGINAL (fetched) children. */
export interface FlowContainer {
  key: string;
  className: string;
  rid?: string;
  /** the projection's ORIGINAL ordered children (never the staged ones). */
  original: FlowNode[];
}

/** Find a flow node at any supported nesting depth. ButtonGroup is currently the only nested
 *  flow container, but keeping the walk recursive also covers a staged group and an off-page
 *  InputSet projection without teaching each caller where that group came from. */
function findFlowNode(children: readonly FlowNode[], key: string): FlowNode | undefined {
  for (const child of children) {
    if (child.id === key) return child;
    const nested = child.children ? findFlowNode(child.children, key) : undefined;
    if (nested) return nested;
  }
  return undefined;
}

/** Locate the flow container addressed by `key`: an InputSet/EditPage (a projection's `refId`), a
 *  nested ButtonGroup (a FlowNode inside a projection), or a STAGED-NEW container (a temp-keyed
 *  flowEdits entry carrying `newContainer` — original children are by definition empty). Returns null
 *  when `key` names no container. */
export function findFlowContainer(m: LModel, key: string): FlowContainer | null {
  const nc = m.flowEdits?.[key]?.newContainer;
  if (nc) return { key, className: nc.className, original: [] };
  for (const p of Object.values(m.flows ?? {})) {
    if (p.refId === key) return { key, className: p.refClass ?? 'InputSet', rid: p.refRid, original: p.children };
    const nested = findFlowNode(p.children, key);
    // An empty ButtonGroup has no `children` property on the wire. It is still a valid add target.
    if (nested?.className === 'ButtonGroup') {
      return { key, className: 'ButtonGroup', rid: nested.rid, original: nested.children ?? [] };
    }
  }
  // on-demand fetched children of an EXISTING off-page reference the user wired to (FIX: wire to
  // existing — the main fetch never projected it, so its real contents come from flowRefChildren).
  const rc = m.flowRefChildren?.[key];
  if (rc) return { key, className: rc.className, rid: rc.rid, original: rc.children };
  for (const cached of Object.values(m.flowRefChildren ?? {})) {
    const nested = findFlowNode(cached.children, key);
    if (nested?.className === 'ButtonGroup') {
      return { key, className: 'ButtonGroup', rid: nested.rid, original: nested.children ?? [] };
    }
  }
  // A ButtonGroup can itself be staged under an InputSet and receive buttons before the first Apply.
  // Resolve it from staged adds so its ButtonInput create is typed and dependency-ordered correctly.
  for (const edit of Object.values(m.flowEdits ?? {})) {
    const staged = findFlowNode(edit.adds ?? [], key);
    if (staged?.className === 'ButtonGroup') {
      return { key, className: 'ButtonGroup', original: staged.children ?? [] };
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
  // No container yet (a just-wired existing ref whose children fetch is still in flight, or a ref that
  // isn't fetchable) still shows its STAGED adds — they live in flowEdits, independent of the fetch. The
  // old early `return []` here hid them entirely, so "add element" appeared to do nothing until (if ever)
  // the fetch landed.
  const container = findFlowContainer(m, key);
  const e = editOf(m, key);
  const original = container?.original ?? [];
  if (!original.length && !e?.adds?.length) return [];
  const removed = new Set(e?.removes ?? []);
  const natural = [...original, ...(e?.adds ?? [])].filter(node => !removed.has(node.id));
  const ordered: FlowNode[] = [];
  if (!e?.order) {
    ordered.push(...natural);
  } else {
    const byId = new Map(natural.map(n => [n.id, n]));
    for (const id of e.order) { const n = byId.get(id); if (n) { ordered.push(n); byId.delete(id); } }
    for (const n of natural) if (byId.has(n.id)) ordered.push(n); // anything the order list missed
  }
  // Overlay staged renames (keyed per flow object) so the renderer AND the reorder-id source both see the
  // new name; reorder only reads ids, so this is display-only for it. Recurses one nesting level (a
  // ButtonGroup grandchild rename rides here too). Identity is preserved when nothing changed.
  return ordered.map(n => overlayFlowEdit(m, n));
}

/** Apply a staged `rename` edit to a flow node (and, recursively, its nested children), returning the
 *  same object when nothing changed. Keyed per flow-object businessId in `flowEdits`. */
function overlayFlowEdit(m: LModel, n: FlowNode): FlowNode {
  const edit = m.flowEdits?.[n.id];
  const kids = n.children?.map(c => overlayFlowEdit(m, c));
  const kidsChanged = !!kids && n.children!.some((c, i) => c !== kids[i]);
  if (edit?.rename === undefined && edit?.propertyMapping === undefined && !kidsChanged) return n;
  return {
    ...n,
    ...(edit?.rename !== undefined ? { name: edit.rename } : {}),
    ...(edit?.propertyMapping !== undefined ? { prop: edit.propertyMapping } : {}),
    ...(kids ? { children: kids } : {}),
  };
}

/** Immutable helper: clone the model and ensure a mutable `flowEdits[key]` entry exists, then run `fn`. */
function withFlowEdit(m: LModel, key: string, fn: (e: FlowEdit) => void): LModel {
  const c = cloneModel(m);
  const edits = (c.flowEdits ??= {});
  const e = (edits[key] ??= {});
  fn(e);
  // Drop an entry that ended up empty (e.g. a flag toggled back to its projection value).
  if (!e.adds?.length && !e.removes?.length && !e.order && e.displayOnActionMenu === undefined && e.displayOnAllTabs === undefined
    && !e.newContainer && !e.wireRef && e.rename === undefined && e.propertyMapping === undefined) delete edits[key];
  return c;
}

/** Stage a new child in a flow container (type + name only — no property forms). `afterId` inserts right
 *  after that sibling, null inserts at the front, and undefined appends. */
export function addFlowChild(m: LModel, key: string, className: string, name?: string, afterId?: string | null): { model: LModel; id: string } {
  const id = tempId('flow');
  const isBreak = className === 'EditPageBreak' || className === 'EditPageColumnBreak';
  const node: FlowNode = { id, className, name: name ?? `New ${className}`, ...(isBreak ? { isBreak: true } : {}) };
  const model = withFlowEdit(m, key, e => {
    (e.adds ??= []).push(node);
    // Placement: append by default. When inserting after a specific sibling, materialise the current
    // effective order (incl. this new node appended) and splice the new id into place → an `order` edit.
    if (afterId !== undefined) {
      const cur = effectiveFlowChildren({ ...m, flowEdits: { ...(m.flowEdits ?? {}), [key]: { ...(m.flowEdits?.[key] ?? {}), adds: [...(m.flowEdits?.[key]?.adds ?? []), node] } } }, key).map(n => n.id);
      const without = cur.filter(x => x !== id);
      const at = afterId === null ? -1 : without.indexOf(afterId);
      const insertAt = afterId === null ? 0 : at >= 0 ? at + 1 : without.length;
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
  // Collapse a no-op drop (dragged back to where it already sits): if the desired order equals the
  // NATURAL order (original children + adds appended), clear `order` so the edit doesn't linger as a
  // phantom pending change with an empty apply. flowDiff emits no reorder step for order===natural
  // anyway, but the un-collapsed entry still counted toward flowChangeCount.
  const container = findFlowContainer(m, key);
  const natural = container ? [...container.original.map(c => c.id), ...(m.flowEdits?.[key]?.adds ?? []).map(a => a.id)] : without;
  return withFlowEdit(m, key, e => {
    if (without.join(' ') === natural.join(' ')) delete e.order;
    else e.order = without;
  });
}

/** Cancel a staged add before it has ever reached BMP. */
export function removeFlowAdd(m: LModel, key: string, id: string): LModel {
  if (!m.flowEdits?.[key]?.adds?.some(a => a.id === id)) return m;
  return withFlowEdit(m, key, e => {
    e.adds = (e.adds ?? []).filter(a => a.id !== id);
    if (e.order) e.order = e.order.filter(x => x !== id);
  });
}

/** Stage deletion of one flow child. A staged-new child is cancelled outright;
 * an existing child is retained in the baseline and omitted from the desired
 * projection until Apply emits `<child>.delete()`. */
export function deleteFlowChild(m: LModel, key: string, id: string): LModel {
  if (m.flowEdits?.[key]?.adds?.some(add => add.id === id)) return removeFlowAdd(m, key, id);
  const container = findFlowContainer(m, key);
  if (!container?.original.some(child => child.id === id)) return m;
  return withFlowEdit(m, key, edit => {
    const removes = new Set(edit.removes ?? []);
    removes.add(id);
    edit.removes = [...removes];
    if (edit.order) edit.order = edit.order.filter(childId => childId !== id);
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

/** Is this flowEdits entry a staged page-level ActionButton (from `addActionButton`)? A temp key whose
 *  single add IS an ActionButton. The `!newContainer` guard excludes a staged-new container entry (also
 *  temp-keyed with adds), so both the diff and the tray agree on what renders as a page-level button. */
export function isStagedActionButtonAdd(key: string, e: FlowEdit): boolean {
  return key.includes(':') && !e.newContainer && e.adds?.length === 1 && e.adds[0].className === 'ActionButton';
}

// ── staged-new references (create a NEW InputSet / EditPage from blueprint) ──────────────────────

/** Stage a NEW InputSet/EditPage for a flow widget: a temp-keyed `newContainer` entry (children stage
 *  underneath it immediately via the normal addFlowChild path) + the widget's `wireRef` pointing at it.
 *  A COV gaining an editPage also stages `createMode := "EDITORADD"` unless it's already an EDITOR*
 *  mode (an ADD-mode COV ignores its editPage — flip verified live on t.50842, 2026-07-12). */
export function stageNewFlowContainer(m: LModel, widgetId: string, prop: 'inputSet' | 'editPage', name: string): { model: LModel; id: string } {
  const id = tempId('flowset');
  const className = prop === 'inputSet' ? 'InputSet' as const : 'EditPage' as const;
  const editPageType = prop === 'editPage' ? m.flows?.[widgetId]?.objectTypeClass : undefined;
  let next = withFlowEdit(m, id, e => {
    e.newContainer = { className, name, ...(editPageType ? { editPageType } : {}) };
  });
  next = withFlowEdit(next, widgetId, e => {
    e.wireRef = { prop, targetId: id, targetClass: className, targetName: name, ...(needsModeFlip(m, widgetId, prop) ? { setCreateMode: true } : {}) };
  });
  return { model: next, id };
}

/** Stage wiring a flow widget to an EXISTING InputSet/EditPage (the "wire to existing" picker).
 *  Wiring back to the projection's current reference clears the staged edit (a no-op wire). */
export function wireFlowRef(m: LModel, widgetId: string, prop: 'inputSet' | 'editPage', targetId: string, targetClass: string, targetName?: string): LModel {
  // cancel a previously staged-new container this widget pointed at (it would otherwise orphan)
  const base = dropStagedContainer(m, m.flowEdits?.[widgetId]?.wireRef?.targetId);
  return withFlowEdit(base, widgetId, e => {
    if (m.flows?.[widgetId]?.refId === targetId) delete e.wireRef; // wired back to the live reference
    else e.wireRef = { prop, targetId, targetClass, ...(targetName ? { targetName } : {}), ...(needsModeFlip(m, widgetId, prop) ? { setCreateMode: true } : {}) };
  });
}

/** Cancel a staged wire (and the staged-new container behind it, when there is one). */
export function unwireFlowRef(m: LModel, widgetId: string): LModel {
  const target = m.flowEdits?.[widgetId]?.wireRef?.targetId;
  const next = withFlowEdit(m, widgetId, e => { delete e.wireRef; });
  return dropStagedContainer(next, target);
}

/** Drop a staged-new container (and everything staged under it) when the widget that pointed at it stops
 *  doing so — else the temp-keyed `newContainer` entry orphans. No-op unless `targetId` is a temp id whose
 *  entry actually carries a `newContainer`. */
function dropStagedContainer(m: LModel, targetId: string | undefined): LModel {
  if (targetId && targetId.includes(':') && m.flowEdits?.[targetId]?.newContainer) {
    return withFlowEdit(m, targetId, e => { delete e.newContainer; delete e.adds; delete e.order; });
  }
  return m;
}

/** Should wiring an editPage onto this widget also flip createMode to EDITORADD? Only for a COV whose
 *  current (normalized) mode is not already an EDITOR* mode — a staged-new COV has no projection and
 *  defaults to ADD, so it flips too. */
function needsModeFlip(m: LModel, widgetId: string, prop: 'inputSet' | 'editPage'): boolean {
  if (prop !== 'editPage') return false;
  const mode = m.flows?.[widgetId]?.createMode ?? 'ADD';
  return mode !== 'EDITORADD' && mode !== 'EDITOREDIT';
}

// ── rename a flow object (child / container / reference / staged-new) ─────────────────────────────

/** Recursively find a flow node by id within a child list (one nesting level in practice). Shared by the
 *  name/rid lookups over an existing object's children. */
function findInFlowChildren(children: FlowNode[], id: string): FlowNode | undefined {
  for (const c of children) {
    if (c.id === id) return c;
    if (c.children) { const deep = findInFlowChildren(c.children, id); if (deep) return deep; }
  }
  return undefined;
}

/** The CURRENT (unedited) name of an EXISTING flow object — a reference (InputSet/EditPage) or one of its
 *  children (incl. on-demand-fetched off-page children). Undefined when it isn't a known existing object
 *  (e.g. a staged add, handled separately). Lets `renameFlowObject` clear a rename typed back to original. */
function existingFlowObjectName(m: LModel, id: string): string | undefined {
  for (const p of Object.values(m.flows ?? {})) {
    if (p.refId === id) return p.refName;
    const c = findInFlowChildren(p.children, id);
    if (c) return c.name;
  }
  for (const rc of Object.values(m.flowRefChildren ?? {})) {
    const c = findInFlowChildren(rc.children, id);
    if (c) return c.name;
  }
  return undefined;
}

/** Stage a NAME change on a flow object, keyed per object (pitfall #2). Three cases, in order:
 *   1. a STAGED-ADD child → mutate the add node's name in place (name rides the create — no rename step);
 *   2. a STAGED-NEW container → update its `newContainer.name` (compiled in the create) + sync the wiring
 *      label on whichever widget points at it, so the reference band reflects the new name;
 *   3. an EXISTING object (child / container / reference) → stage `rename` (cleared when typed back to the
 *      original). Names are hostile input — the EC compiler escapes them (ecStr).
 *  Returns the new model, or null for a no-op (empty / unchanged name). */
export function renameFlowObject(m: LModel, id: string, rawName: string): LModel | null {
  const name = rawName.trim();
  if (!name) return null;
  // 1) staged-add child — mutate the add node's name in place under its container key
  for (const [key, e] of Object.entries(m.flowEdits ?? {})) {
    if (e.adds?.some(a => a.id === id)) {
      if (e.adds.find(a => a.id === id)!.name === name) return null;
      return withFlowEdit(m, key, ee => { const a = ee.adds?.find(x => x.id === id); if (a) a.name = name; });
    }
  }
  // 2) staged-new container — update its staged name + the wiring label(s) that point at it
  if (m.flowEdits?.[id]?.newContainer) {
    if (m.flowEdits[id].newContainer!.name === name) return null;
    const c = cloneModel(m);
    const nc = c.flowEdits![id].newContainer; if (nc) nc.name = name;
    for (const we of Object.values(c.flowEdits!)) if (we.wireRef?.targetId === id) we.wireRef.targetName = name;
    return c;
  }
  // 3) existing object — stage a rename (clear it when renamed back to the original)
  const cur = existingFlowObjectName(m, id);
  return withFlowEdit(m, id, ee => { if (cur !== undefined && cur === name) delete ee.rename; else ee.rename = name; });
}

/** Stage an EditField property mapping. A staged add keeps the mapping on its
 * create node; an existing field gets a dedicated update entry. */
export function setEditFieldProperty(m: LModel, parentId: string, id: string, accessor: string): LModel {
  const clean = accessor.trim();
  if (m.flowEdits?.[parentId]?.adds?.some(add => add.id === id && add.className === 'EditField')) {
    return withFlowEdit(m, parentId, edit => {
      const add = edit.adds?.find(node => node.id === id);
      if (add) add.prop = clean;
    });
  }
  const original = findFlowContainer(m, parentId)?.original.find(node => node.id === id);
  if (!original || original.className !== 'EditField') return m;
  return withFlowEdit(m, id, edit => {
    if ((original.prop ?? '') === clean) delete edit.propertyMapping;
    else edit.propertyMapping = clean;
  });
}

/** The staged reference for a widget (wireRef), or its live projection ref — the renderer's one lookup. */
export function effectiveRef(m: LModel, widgetId: string): { id: string; className: string; name?: string; staged: boolean; isNew: boolean } | null {
  const wire = m.flowEdits?.[widgetId]?.wireRef;
  if (wire) return { id: wire.targetId, className: wire.targetClass, name: wire.targetName, staged: true, isNew: wire.targetId.includes(':') };
  const p = m.flows?.[widgetId];
  if (p?.refId) return { id: p.refId, className: p.refClass ?? 'InputSet', name: p.refName, staged: false, isNew: false };
  return null;
}

// ── flow diff ────────────────────────────────────────────────────────────────────────────────────

/** An on-page reference's EXISTING Category (a reference whose parent is a Category) — the co-location
 *  target for anything new this apply creates in the support folder. Shared by the compiler's ONE
 *  support-Category resolver: a new tabset / InputSet / EditPage all reuse this Category rather than
 *  creating a duplicate (Config Studio's support-folder convention; the fixture's set+page live in
 *  Category t.50675). `name` is the Category's display name for the honest "lands in …" preview label
 *  (from `refParentName`, when the fetch carried it). Undefined = no on-page Category → the compiler
 *  creates ONE `root.portal.add(Category, name := <page display name>)` and reuses that. */
export function existingSupportCategory(m: LModel): { id: string; name?: string } | undefined {
  for (const p of Object.values(m.flows ?? {})) {
    if (p.refId && p.refParentClass === 'Category' && p.refParentId) {
      return { id: p.refParentId, ...(p.refParentName ? { name: p.refParentName } : {}) };
    }
  }
  return undefined;
}

/** Diff the staged flow edits into plan steps. Keyed by businessId, so an edit staged from two cells is
 *  processed ONCE (pitfall #2). Emits nothing when `flowEdits` is empty — so a freshly-loaded model (and
 *  the layout-only regression) is byte-identical to one without flow (pitfall #1). Deterministic order:
 *  new-container creates (Category → set/page) → child creates → reorders → flags → reference wires
 *  LAST (so a wire can reference any staged-new target's var — including a staged-new widget's `_n<k>`
 *  var from the layout creates, which always precede flow steps in the composed plan). */
export function flowDiff(_baseline: LModel, desired: LModel): PlanStep[] {
  const edits = desired.flowEdits;
  if (!edits) return [];
  const containerCreates: PlanStep[] = [];
  const creates: Extract<PlanStep, { kind: 'flowCreate' }>[] = [];
  const reorders: PlanStep[] = [];
  const deletes: PlanStep[] = [];
  const renames: PlanStep[] = [];
  const properties: PlanStep[] = [];
  const flags: PlanStep[] = [];
  const wires: PlanStep[] = [];

  for (const [key, e] of Object.entries(edits)) {
    // A rename of an EXISTING flow object (child / container / reference) — `<obj>.change(name := …)`,
    // compiled after creates. Staged-add / staged-new renames never set `rename` (their name rides the
    // create), so this only ever fires for a real businessId-keyed object.
    if (e.rename !== undefined) {
      const rid = flowObjectRid(desired, key);
      const className = desired.flows?.[key]?.refClass;
      renames.push({ kind: 'flowRename', id: key, name: e.rename, ...(rid ? { rid } : {}), ...(className ? { className } : {}) });
    }
    if (e.propertyMapping !== undefined) {
      const rid = flowObjectRid(desired, key);
      const parent = Object.values(desired.flows ?? {}).find(projection =>
        projection.children.some(child => child.id === key));
      if (parent?.refId) {
        properties.push({
          kind: 'flowProperty',
          id: key,
          parentId: parent.refId,
          accessor: e.propertyMapping,
          ...(rid ? { rid } : {}),
        });
      }
    }
    // A staged-new InputSet/EditPage: create it in the page's ONE support Category (the compiler
    // resolves that Category — reuse an on-page one, else create it — and shares it across every
    // support landing), THEN its staged children under it (same entry).
    if (e.newContainer) {
      containerCreates.push({
        kind: 'flowCreate',
        node: { id: key, className: e.newContainer.className, name: e.newContainer.name },
        parentId: '*support*', parentClass: 'Category',
        ...(e.newContainer.editPageType ? { editPageType: e.newContainer.editPageType } : {}),
      });
    }
    // The widget's staged reference wire (emitted last, after every create).
    if (e.wireRef) {
      const proj = desired.flows?.[key];
      wires.push({
        kind: 'flowWire', id: key, prop: e.wireRef.prop, targetId: e.wireRef.targetId,
        ...(e.wireRef.targetName ? { targetName: e.wireRef.targetName } : {}),
        ...(e.wireRef.setCreateMode ? { setCreateMode: true } : {}),
        ...(proj?.ownerRid ? { rid: proj.ownerRid } : {}),
      });
    }
    // A NEW page-level ActionButton: the key is a temp id and the single add IS the button. Its `prop`
    // carries the tab/RESULT container binding. Emit a widget-style create + its flag.
    if (isStagedActionButtonAdd(key, e)) {
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
    // reorder — MINIMAL moves (one op per displaced item) vs the natural order (original + adds appended,
    // which is what BMP has after the create steps run). Shared with the layout diff (reorder.ts).
    if (e.order && container) {
      const removed = new Set(e.removes ?? []);
      const natural = [...container.original.map(c => c.id), ...(e.adds ?? []).map(a => a.id)]
        .filter(id => !removed.has(id));
      const desiredOrder = effectiveFlowChildren(desired, key).map(n => n.id);
      const ridOf = (id: string): string | undefined =>
        container.original.find(c => c.id === id)?.rid ?? (e.adds ?? []).find(a => a.id === id)?.rid;
      for (const mv of minimalReorder(natural, desiredOrder)) {
        reorders.push({ kind: 'flowReorder', id: mv.id, parentId: key,
          ...(mv.dir === 'before' ? { beforeId: mv.anchorId } : { afterId: mv.anchorId }),
          ...(ridOf(mv.id) ? { rid: ridOf(mv.id) } : {}) });
      }
    }
    for (const id of e.removes ?? []) {
      const child = container?.original.find(candidate => candidate.id === id);
      if (!child) continue;
      deletes.push({
        kind: 'flowDelete',
        id,
        parentId: key,
        className: child.className,
        ...(child.rid ? { rid: child.rid } : {}),
        ...(child.name ? { name: child.name } : {}),
      });
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
  // A user may add a ButtonGroup and then add its ButtonInput before Apply. Object-key insertion order
  // normally happens to put the group first, but undo/redo, restored drafts, and future serialization
  // must not be allowed to reverse those dependent creates. Stable-toposort flow creates by temp parent.
  const createdIds = new Set(creates.map(step => step.node.id));
  const emittedIds = new Set<string>();
  const pending = [...creates];
  const orderedCreates: typeof creates = [];
  while (pending.length) {
    const ready = pending.findIndex(step => !createdIds.has(step.parentId) || emittedIds.has(step.parentId));
    // A cycle is not constructible through the UI. Preserve deterministic input order if malformed
    // restored state ever contains one; the compiler/server will then surface the invalid parentage.
    const index = ready >= 0 ? ready : 0;
    const [step] = pending.splice(index, 1);
    orderedCreates.push(step);
    emittedIds.add(step.node.id);
  }
  return [...containerCreates, ...orderedCreates, ...reorders, ...renames, ...properties, ...deletes, ...flags, ...wires];
}

/** rid of an EXISTING flow object (reference or one of its children) — threaded on a flowRename so a
 *  businessId-less object (id === rid) can be addressed by `lookup(rid)` in the compiler. */
function flowObjectRid(m: LModel, id: string): string | undefined {
  for (const p of Object.values(m.flows ?? {})) {
    if (p.refId === id) return p.refRid;
    const c = findInFlowChildren(p.children, id); if (c) return c.rid;
  }
  for (const rc of Object.values(m.flowRefChildren ?? {})) {
    const c = findInFlowChildren(rc.children, id); if (c) return c.rid;
  }
  return undefined;
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
 *  starts at the button's `container` binding, which can name the tab itself OR any nested container
 *  below it. A RESULT-bound button renders on every tab (BMP renders the shared Result tab's widgets
 *  under each tab), so it counts as "this tab" everywhere. A fetched menu button staged to the grid
 *  STAYS in the tray flagged `leaving` (it owns no grid cell until the post-apply reload). Pure — the
 *  tray renderer and its tests both consume this. */
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
    const ownerTabId = boundTab ? findTabOf(m, boundTab)?.id : null;
    const onThisTab = allTabs
      || boundTab === 'RESULT'
      || boundTab === ''
      || ownerTabId === viewedTabId;
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
  // NAMES are part of the signature: a rename-only apply (`<obj>.change(name := …)`) touches no layout
  // node and no child MEMBERSHIP, so without names the rollback guard would misread a successful rename
  // as "BMP discarded the changes". JSON (not a delimiter-joined string) so a name containing the old
  // separators can't forge a collision. refId covers a pure reference-wire apply.
  const childSig = (children: FlowNode[]): unknown =>
    children.map(c => [c.id, c.name, c.children?.length ? childSig(c.children) : 0]);
  return JSON.stringify(Object.keys(flows).sort().map(k => {
    const p = flows[k];
    return [k, p.refId ?? '', p.refName ?? '', p.displayOnActionMenu ? 1 : 0, p.displayOnAllTabs ? 1 : 0, childSig(p.children)];
  }));
}
