/**
 * Edit engine — every gesture as a pure `(model, …args) => model`. No DOM, no BMP.
 * Operations mutate a fresh clone, so callers can snapshot for undo/redo trivially.
 * Widths/parentage are validated against BMP reality in `constraints.ts`, not here.
 *
 * All of these are wired into the overlay: resize/setHeight/rename/remove/addWidget/addContainer/addTab
 * via the toolbar + picker, and moveInto/swap/insertRelative via the drag gestures (gestures.ts → the
 * doMoveInto/doSwap/doInsert controllers). `move` is the shared reparent+position primitive.
 * findNode/findTabOf are shared tree helpers used throughout.
 */
import { cloneModel, findNode, descendantWidgets, tempId, isChart, hasHeight, normalizeModel } from './model';
import type { Breakpoint, LModel, LNode, NodeStyle } from './types';

const clampCol = (n: number): number => Math.max(0, Math.min(6, Math.round(n)));

/** "Col <cols>" (or "Col auto" for a 0/auto-width container — cols 0 is not "6 columns"), de-duped
 *  against sibling names with a (2),(3)… suffix so two same-width boxes in one parent stay
 *  distinguishable. `selfId` is excluded so a resize-rename never collides with itself. Whether a
 *  container is auto-named is tracked by the `autoName` flag on the node (set on create, cleared on an
 *  explicit rename) — NOT by matching this string, so a container a human named "Col 3" is never
 *  hijacked by a later resize. */
function colName(siblings: LNode[], colsL: number, selfId: string): string {
  const base = colsL > 0 ? `Col ${colsL}` : 'Col auto';
  const taken = new Set(siblings.filter(s => s.id !== selfId).map(s => s.name));
  if (!taken.has(base)) return base;
  let k = 2;
  while (taken.has(`${base} (${k})`)) k++;
  return `${base} (${k})`;
}

/** Every mutation flows through here: clone, apply, then normalize to canonical band order — the
 *  single choke point that keeps raw children order identical to BMP's rendered order (see
 *  normalizeModel). A future primitive added to this file inherits the invariant for free. */
function edit(m: LModel, fn: (c: LModel) => void): LModel {
  const c = cloneModel(m);
  fn(c);
  return normalizeModel(c);
}

export function resize(m: LModel, id: string, bp: Breakpoint, n: number): LModel {
  return edit(m, c => {
    const f = findNode(c, id);
    if (!f) return;
    f.node.cols[bp] = clampCol(n);
    // Keep a tool-named ("Col N") container's name in step with its large-screen width, until the user
    // renames it (which clears `autoName`). Flag-driven, not name-pattern matched, so a container a
    // human deliberately named "Col 3" is never renamed out from under them.
    if (bp === 'L' && f.node.kind === 'container' && f.node.autoName) {
      f.node.name = colName(f.siblings, f.node.cols.L ?? 6, f.node.id);
    }
  });
}

/** F2: toggle a staged reset of `prop` (a BMP property name) on node `id`. Only a prop that actually
 *  OVERRIDES the template (present in node.overrides) can be reset; toggling adds/removes it from
 *  node.resets. The value is left unchanged — it reverts to the template's on apply (`.reset(prop)`). */
export function toggleReset(m: LModel, id: string, prop: string): LModel {
  return edit(m, c => {
    const f = findNode(c, id);
    if (!f || !(f.node.overrides ?? []).includes(prop)) return;
    const resets = new Set(f.node.resets ?? []);
    resets.has(prop) ? resets.delete(prop) : resets.add(prop);
    f.node.resets = resets.size ? [...resets] : undefined;
  });
}

export function setHeight(m: LModel, id: string, px: number): LModel {
  return edit(m, c => { const f = findNode(c, id); if (f && hasHeight(f.node.className)) f.node.height = Math.max(20, Math.round(px)); });
}

/** G3: stage a style edit — merge `patch` into the node's appearance (creating `style` if absent). The
 *  caller passes concrete values: a colour bid (or '' to clear the link), a boolean/number/enum-string.
 *  diff compares the merged style against the baseline field-wise, so an unchanged field is a no-op. */
export function setStyle(m: LModel, id: string, patch: Partial<NodeStyle>): LModel {
  return edit(m, c => {
    const f = findNode(c, id);
    if (!f) return;
    f.node.style = { ...(f.node.style ?? {}), ...patch };
  });
}

export function rename(m: LModel, id: string, name: string): LModel {
  return edit(m, c => {
    const f = findNode(c, id);
    if (!f) return;
    const nm = name.trim();
    if (!nm) return; // empty → keep the current name (and, for a container, its auto-name tracking)
    f.node.name = nm;
    f.node.autoName = undefined; // an explicit rename hands name ownership to the user
  });
}

/** Detach a node from its current siblings (mutates the working clone). */
function detach(c: LModel, id: string): LNode | null {
  const f = findNode(c, id);
  if (!f) return null;
  f.siblings.splice(f.index, 1);
  return f.node;
}

/** Reparent + position: insert `id` into `toParentId`'s children at `index` (clamped). */
export function move(m: LModel, id: string, toParentId: string, index: number): LModel {
  return edit(m, c => {
    const homeTab = toParentId === '*tab-root*' ? findTabOf(c, id) : null; // capture BEFORE detach
    const node = detach(c, id);
    if (!node) return;
    const dest = toParentId === '*tab-root*' ? null : findNode(c, toParentId)?.node ?? null;
    const list = dest ? dest.children : homeTab?.children ?? c.tabs;
    // A widget keeps its width on move: columnsLargeScreen is measured within the destination's OWN
    // 6-col grid, NOT relative to the container's page-width. (Verified live: a width-2 container holds
    // 6/6 widgets.) So no clamp — moving Notes into a narrow KPIs container must not shrink it.
    list.splice(Math.max(0, Math.min(index, list.length)), 0, node);
  });
}

/** Move into a tab/container's children, appended (the common "drop into box" case). */
export function moveInto(m: LModel, id: string, parentId: string): LModel {
  const f = findNode(m, parentId);
  return move(m, id, parentId, f ? f.node.children.length : 0);
}

/** True when `id` is `anc` itself or anywhere in its subtree — the guard against moving a node into
 *  its own descendant (which would orphan the subtree). Shared with the move-menu in the view. */
export function isAncestorOf(anc: LNode, id: string): boolean {
  return anc.id === id || anc.children.some(c => isAncestorOf(c, id));
}

/** Exchange two nodes' positions (keeps each node's own width). */
export function swap(m: LModel, a: string, b: string): LModel {
  return edit(m, c => {
    const fa = findNode(c, a), fb = findNode(c, b);
    if (!fa || !fb || a === b) return;
    if (isAncestorOf(fa.node, b) || isAncestorOf(fb.node, a)) return; // swapping a node with its own descendant would orphan the subtree
    if (fa.siblings === fb.siblings) {
      const t = fa.siblings[fa.index]; fa.siblings[fa.index] = fa.siblings[fb.index]; fa.siblings[fb.index] = t;
    } else {
      fa.siblings[fa.index] = fb.node; fb.siblings[fb.index] = fa.node;
    }
  });
}

/** Insert `id` before/after `targetId` within `targetId`'s parent (reorder, possibly reparenting). */
export function insertRelative(m: LModel, id: string, targetId: string, before: boolean): LModel {
  return edit(m, c => {
    const self = findNode(c, id);
    if (!self || id === targetId || isAncestorOf(self.node, targetId)) return; // never reorder relative to self / own subtree
    const node = detach(c, id);
    if (!node) return;
    const t = findNode(c, targetId);
    if (!t) { c.tabs.push(node); return; }
    const i = t.siblings.indexOf(t.node);
    t.siblings.splice(i + (before ? 0 : 1), 0, node);
  });
}

export function addWidget(m: LModel, parentId: string, index: number, className: string, name?: string, colsL = 6): { model: LModel; id: string } {
  const id = tempId('w');
  const node: LNode = {
    id, kind: 'widget', className, name: name ?? `New ${className}`,
    cols: { L: clampCol(colsL) || 6 }, height: isChart(className) ? 200 : undefined, children: [],
  };
  return { model: insertNode(m, parentId, index, node), id };
}

/** Add a Container. When no name is given it's auto-named for its width ("Col N", de-duped per parent)
 *  — computed from the destination's own children so the (2),(3)… counter is scoped to that parent. */
export function addContainer(m: LModel, parentId: string, index: number, colsL = 6, name?: string): { model: LModel; id: string } {
  const id = tempId('box');
  return {
    model: edit(m, c => {
      const f = findNode(c, parentId);
      const list = f ? f.node.children : c.tabs;
      const auto = name === undefined;
      const nm = auto ? colName(list, colsL, id) : name;
      const node: LNode = { id, kind: 'container', className: 'Container', name: nm, cols: { L: colsL }, children: [], ...(auto ? { autoName: true } : {}) };
      list.splice(Math.max(0, Math.min(index, list.length)), 0, node);
    }),
    id,
  };
}

export function addTab(m: LModel, index: number, name = 'New Tab'): { model: LModel; id: string } {
  const id = tempId('tab');
  const node: LNode = { id, kind: 'tab', className: 'Tab', name, cols: { L: 6 }, children: [] };
  return {
    model: edit(m, c => { c.tabs.splice(Math.max(0, Math.min(index, c.tabs.length)), 0, node); }),
    id,
  };
}

/** Stage a dedicated tabset for a RESULT-only page. The tabset is VIRTUAL — created at Apply, in the
 *  SAME EC as its tabs, not as an eager pre-commit — a "Main" tab is added, and the page's Result-tab
 *  widgets are rehomed onto it so they bind to a real cell instead of the phantom RESULT placement. Pure
 *  model transform; the compiler emits the tabset via `root.portal.add(TabSet …)` (see ec.ts). No-op
 *  unless the page is result-only. Returns the Main tab's staged id (so the caller can select it). */
export function createTabset(m: LModel): { model: LModel; id: string } {
  const id = tempId('tab');
  if (!m.resultOnly) return { model: m, id };
  return {
    model: edit(m, c => {
      // The result-only model holds the page's widgets on the Result tab — carry them onto the new Main
      // tab so the diff emits a reparent (container := Main), mirroring the old eager create-tabset move.
      const carried = c.tabs.flatMap(t => t.children);
      c.tabs = [{ id, kind: 'tab', className: 'Tab', name: 'Main', cols: { L: 6 }, children: carried }];
      c.tabsetId = tempId('tabset');
      c.tabsetVirtual = true;
      c.tabsetName = '» New TabSet';
      c.resultOnly = false;
    }),
    id,
  };
}

function insertNode(m: LModel, parentId: string, index: number, node: LNode): LModel {
  return edit(m, c => {
    const f = findNode(c, parentId);
    const list = f ? f.node.children : c.tabs;
    list.splice(Math.max(0, Math.min(index, list.length)), 0, node);
  });
}

/** Delete a node. A non-empty container re-homes its widget leaves to the enclosing tab first
 *  (BMP would otherwise orphan them to the RESULT tab — the verified gotcha). */
export function remove(m: LModel, id: string): LModel {
  return edit(m, c => {
    const f = findNode(c, id);
    if (!f) return;
    if (f.node.kind === 'container') {
      const widgets = descendantWidgets(f.node);
      const tab = findTabOf(c, id);
      if (widgets.length && tab) tab.children.push(...widgets.map(w => ({ ...w })));
    }
    f.siblings.splice(f.index, 1);
  });
}

/** The enclosing tab LNode of a node (or the node itself if it is a tab). */
export function findTabOf(m: LModel, id: string): LNode | null {
  for (const tab of m.tabs) {
    if (tab.id === id) return tab;
    let hit = false;
    const rec = (n: LNode) => { if (n.id === id) hit = true; else n.children.forEach(rec); };
    tab.children.forEach(rec);
    if (hit) return tab;
  }
  return null;
}
