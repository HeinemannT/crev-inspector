/**
 * Edit engine — every gesture as a pure `(model, …args) => model`. No DOM, no BMP.
 * Operations mutate a fresh clone, so callers can snapshot for undo/redo trivially.
 * Widths/parentage are validated against BMP reality in `constraints.ts`, not here.
 */
import { cloneModel, findNode, orderChildren, descendantWidgets, tempId, isChart, hasHeight } from './model';
import type { Breakpoint, LModel, LNode } from './types';

const clampCol = (n: number): number => Math.max(0, Math.min(6, Math.round(n)));

function edit(m: LModel, fn: (c: LModel) => void): LModel {
  const c = cloneModel(m);
  fn(c);
  return c;
}

export function resize(m: LModel, id: string, bp: Breakpoint, n: number): LModel {
  return edit(m, c => { const f = findNode(c, id); if (f) f.node.cols[bp] = clampCol(n); });
}

export function setHeight(m: LModel, id: string, px: number): LModel {
  return edit(m, c => { const f = findNode(c, id); if (f && hasHeight(f.node.className)) f.node.height = Math.max(20, Math.round(px)); });
}

export function rename(m: LModel, id: string, name: string): LModel {
  return edit(m, c => { const f = findNode(c, id); if (f) f.node.name = name.trim() || f.node.name; });
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
    // a widget moved to a narrower cell can't exceed the cell width
    if (dest && node.kind === 'widget') node.cols.L = Math.min(node.cols.L, dest.cols.L || 6);
    list.splice(Math.max(0, Math.min(index, list.length)), 0, node);
  });
}

/** Move into a tab/container's children, appended (the common "drop into box" case). */
export function moveInto(m: LModel, id: string, parentId: string): LModel {
  const f = findNode(m, parentId);
  return move(m, id, parentId, f ? f.node.children.length : 0);
}

/** Move a node onto another tab (cross-tab relocation), appended to that tab. */
export function moveToTab(m: LModel, id: string, tabId: string): LModel {
  return moveInto(m, id, tabId);
}

function isAncestorOf(anc: LNode, id: string): boolean {
  return anc.children.some(c => c.id === id || isAncestorOf(c, id));
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
    const node = detach(c, id);
    if (!node) return;
    const t = findNode(c, targetId);
    if (!t) { c.tabs.push(node); return; }
    const i = t.siblings.indexOf(t.node);
    t.siblings.splice(i + (before ? 0 : 1), 0, node);
  });
}

export function addWidget(m: LModel, parentId: string, index: number, className: string, name?: string): { model: LModel; id: string } {
  const id = tempId('w');
  const node: LNode = {
    id, kind: 'widget', className, name: name ?? `New ${className}`,
    cols: { L: 6 }, height: isChart(className) ? 200 : undefined, children: [],
  };
  return { model: insertNode(m, parentId, index, node), id };
}

export function addContainer(m: LModel, parentId: string, index: number, colsL = 6): { model: LModel; id: string } {
  const id = tempId('box');
  const node: LNode = { id, kind: 'container', className: 'Container', name: 'New Box', cols: { L: colsL }, children: [] };
  return { model: insertNode(m, parentId, index, node), id };
}

export function addTab(m: LModel, index: number, name = 'New Tab'): { model: LModel; id: string } {
  const id = tempId('tab');
  const node: LNode = { id, kind: 'tab', className: 'Tab', name, cols: { L: 6 }, children: [] };
  return {
    model: edit(m, c => { c.tabs.splice(Math.max(0, Math.min(index, c.tabs.length)), 0, node); }),
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

export function setTarget(m: LModel, target: LModel['target']): LModel {
  return { ...m, target: target === 'template' && !m.hasTemplate ? 'instance' : target };
}

/** Re-sort every sibling list containers-first (call after structural edits to match render). */
export function normalize(m: LModel): LModel {
  return edit(m, c => {
    const rec = (list: LNode[]) => { list.forEach(n => rec(n.children)); };
    c.tabs.forEach(t => { t.children = orderChildren(t.children); rec(t.children); });
  });
}
