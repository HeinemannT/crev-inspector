/**
 * diff(baseline, desired) -> ordered PlanStep[].
 *
 * Step groups are emitted in dependency order so the EC script is always valid:
 *   1. create   (pre-order DFS of desired -> parent before child, sibling order preserved)
 *   2. update   (column/name/height changes)
 *   3. reparent (binding/parent changes -- also where container-delete RE-HOME shows up, because
 *                edit.remove() already moved the widgets to the tab in the desired model)
 *   4. reorder  (sibling order changes -> moveAfter chains, SAME-KIND only)
 *   5. delete   (reverse depth -> children before parents)
 *
 * Reparent-before-delete prevents the RESULT-orphan: widgets are re-pointed to the tab before
 * their old container is removed.
 */
import { isTempId } from './model';
import type { Breakpoint, LModel, LNode, NodeKind, PlanStep } from './types';

interface Entry {
  node: LNode;
  parentId: string;
  parentKind: NodeKind;   // the parent NODE's kind; for a tab the parent is the tabset -> 'tab'
  depth: number;
  sibIndex: number;
}

function index(m: LModel): Map<string, Entry> {
  const map = new Map<string, Entry>();
  const rec = (list: LNode[], parentId: string, parentKind: NodeKind, depth: number) => {
    list.forEach((node, sibIndex) => {
      map.set(node.id, { node, parentId, parentKind, depth, sibIndex });
      rec(node.children, node.id, node.kind, depth + 1);
    });
  };
  rec(m.tabs, m.tabsetId, 'tab', 0);
  return map;
}

const childIdsOf = (idx: Map<string, Entry>, parentId: string): string[] =>
  [...idx.values()].filter(e => e.parentId === parentId).sort((a, b) => a.sibIndex - b.sibIndex).map(e => e.node.id);

function changedCols(a: LNode, b: LNode): Partial<Record<Breakpoint, number>> | undefined {
  const out: Partial<Record<Breakpoint, number>> = {};
  (['L', 'M', 'S'] as Breakpoint[]).forEach(bp => { if (a.cols[bp] !== b.cols[bp] && b.cols[bp] != null) out[bp] = b.cols[bp]!; });
  return Object.keys(out).length ? out : undefined;
}

export function diff(baseline: LModel, desired: LModel): PlanStep[] {
  const A = index(baseline);
  const B = index(desired);
  const steps: PlanStep[] = [];

  // 1. creates -- pre-order DFS of desired so parents precede children, siblings keep order
  const creates: PlanStep[] = [];
  const visit = (list: LNode[]) => list.forEach(n => {
    if (!A.has(n.id) || isTempId(n.id)) {
      const e = B.get(n.id)!;
      creates.push({ kind: 'create', node: n, parentId: e.parentId, parentKind: e.parentKind });
    }
    visit(n.children);
  });
  visit(desired.tabs);
  steps.push(...creates);

  // 2 + 3. updates and reparents for nodes present in both
  for (const [id, b] of B) {
    const a = A.get(id);
    if (!a) continue;
    const cols = changedCols(a.node, b.node);
    const name = a.node.name !== b.node.name ? b.node.name : undefined;
    const height = a.node.height !== b.node.height && b.node.height != null ? b.node.height : undefined;
    if (cols || name !== undefined || height !== undefined) {
      steps.push({ kind: 'update', id, className: b.node.className, cols, name, height });
    }
    if (a.parentId !== b.parentId) {
      steps.push({ kind: 'reparent', id, nodeKind: b.node.kind, toParentId: b.parentId, toParentKind: b.parentKind });
    }
  }

  // 4. reorders -- moveBefore/After only works among SAME-KIND siblings. Widgets are scorecard
  //    (org) children; containers/tabs are portal children. `widget.moveAfter(container)` errors
  //    ("Can't add <WidgetType> to <Tab>" -- verified live). BMP also renders containers before
  //    tab-bound widgets, so a cross-kind order would be ignored. Chain each kind-group alone.
  const kindOfId = (id: string): NodeKind | undefined => B.get(id)?.node.kind;
  const parents = new Set([...B.values()].map(e => e.parentId));
  for (const pid of parents) {
    if (!A.has(pid) && pid !== baseline.tabsetId) continue; // brand-new parent: children created in order
    for (const kind of ['tab', 'container', 'widget'] as NodeKind[]) {
      const group = childIdsOf(B, pid).filter(id => kindOfId(id) === kind);
      if (group.length < 2) continue;
      const survivingBase = childIdsOf(A, pid).filter(id => B.has(id) && kindOfId(id) === kind);
      const natural = [...survivingBase, ...group.filter(id => !A.has(id))]; // surviving then new (append)
      if (group.join(' ') !== natural.join(' ')) {
        for (let i = 1; i < group.length; i++) steps.push({ kind: 'reorder', id: group[i], afterId: group[i - 1] });
      }
    }
  }

  // 5. deletes -- reverse depth (children before parents)
  const deletes = [...A.values()].filter(e => !B.has(e.node.id)).sort((x, y) => y.depth - x.depth);
  deletes.forEach(e => steps.push({ kind: 'delete', id: e.node.id, nodeKind: e.node.kind, className: e.node.className }));

  return steps;
}
