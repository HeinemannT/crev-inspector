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
import { isTempId, isResultTab } from './model';
import { styleAssignments } from './types';
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

function changedCols(a: LNode, b: LNode): Partial<Record<Breakpoint, number | null>> | undefined {
  const out: Partial<Record<Breakpoint, number | null>> = {};
  // Emit whenever the value differs, INCLUDING a clear (set → unset), carried as null. The old guard
  // (`b.cols[bp] != null`) dropped clears, which blinded the stale-guard to a concurrent server-side
  // clear (baseline 6 vs live unset read as "no change" → the apply would re-impose the 6, clobbering
  // it). null lets diff register that drift; ec.ts skips serving the clear (no verb for it yet).
  (['L', 'M', 'S'] as Breakpoint[]).forEach(bp => { if (a.cols[bp] !== b.cols[bp]) out[bp] = b.cols[bp] ?? null; });
  return Object.keys(out).length ? out : undefined;
}

/** G3: per-field appearance changes baseline→desired (shared `styleAssignments`, undefined when nothing
 *  moved). Only for nodes present in both models — a NEWLY-created widget's style is emitted by the EC
 *  compiler instead (its create step has no baseline here). */
function changedStyle(a: LNode, b: LNode): { prop: string; value: string | number | boolean }[] | undefined {
  const out = styleAssignments(a.style, b.style);
  return out.length ? out : undefined;
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
    // null = a cleared height (set → unset). Carried for the stale-guard, same as cols above.
    const height = a.node.height !== b.node.height ? (b.node.height ?? null) : undefined;
    // F2: newly-staged resets (props in desired.resets that the baseline didn't have). A staged reset
    // doesn't change the VALUE (it's reverted on apply), so it carries here even with no cols/name/height.
    const baseResets = a.node.resets ?? [];
    const resetProps = (b.node.resets ?? []).filter(p => !baseResets.includes(p));
    const styleAssign = changedStyle(a.node, b.node); // G3 appearance edits
    if (cols || name !== undefined || height !== undefined || resetProps.length || styleAssign) {
      steps.push({ kind: 'update', id, className: b.node.className, cols, name, height, ...(resetProps.length ? { resetProps } : {}), ...(styleAssign ? { styleAssign } : {}) });
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
    for (const kind of ['tab', 'container', 'widget'] as NodeKind[]) {
      // `index()` parents EVERY tab under the page's tabsetId — including the shared Result tab, whose
      // REAL parent is default_tabset. So it lands in this group with the page's own tabs. Exclude it
      // from BOTH the desired order AND the natural/surviving order below (excluding it from only one
      // would make them mismatch and emit a phantom reorder for every tab after it). It's pinned first
      // and not user-reorderable, and a chained `t.<pageTab>.moveAfter(t.RESULT)` would be cross-tabset.
      const excluded = (id: string): boolean => kind === 'tab' && !!B.get(id) && isResultTab(B.get(id)!.node);
      const group = childIdsOf(B, pid).filter(id => kindOfId(id) === kind && !excluded(id));
      if (group.length < 2) continue;
      // `natural` = the order BMP produces from the create+reparent steps ALONE (before any reorder),
      // so a reorder only emits when the desired order genuinely differs from it. That order is:
      //   surviving base children (kept in base order)            -- untouched, stay put
      //   + created nodes (desired order)                         -- creates run first, pre-order DFS
      //   + reparented-IN nodes (desired order)                   -- reparents run next, B-map order
      // both creates and reparents APPEND, and both phases iterate in desired order, so this mirrors
      // the live result. Excluding reparented-in nodes (the old bug) made every move-INTO a populated
      // box re-emit a moveAfter for each sibling -> "1 move = N changes". Including them at their
      // appended slot means an append-move needs no reorder at all. When an interleave IS wanted the
      // join still mismatches and the full chain (which reconstructs the exact order) fires.
      const survivingBase = childIdsOf(A, pid).filter(id => B.get(id)?.parentId === pid && kindOfId(id) === kind && !excluded(id));
      const createdIn = group.filter(id => !A.has(id));
      const reparentedIn = group.filter(id => A.has(id) && !survivingBase.includes(id));
      const natural = [...survivingBase, ...createdIn, ...reparentedIn];
      if (group.join(' ') !== natural.join(' ')) {
        for (let i = 1; i < group.length; i++) steps.push({ kind: 'reorder', id: group[i], afterId: group[i - 1] });
      }
    }
  }

  // 5. deletes -- reverse depth (children before parents). The phantom RESULT tab is never a real,
  // deletable object (it's where unplaced widgets land); when a "+ Create tabset" moves every widget off
  // it, it drops out of the desired model, but we must NOT emit a delete for it.
  const deletes = [...A.values()].filter(e => !B.has(e.node.id) && !isResultTab(e.node)).sort((x, y) => y.depth - x.depth);
  deletes.forEach(e => steps.push({ kind: 'delete', id: e.node.id, nodeKind: e.node.kind, className: e.node.className, rid: e.node.rid, name: e.node.name }));

  return steps;
}

/**
 * Headline change count vs raw action count. A single edit often compiles to several EC actions — e.g.
 * inserting one widget mid-list emits a create PLUS a moveAfter chain to re-seat its siblings. Those
 * reorders are a SIDE-EFFECT of the insert, not separate user changes, so the headline shouldn't inflate.
 *
 * `changes` = distinct nodes the user actually acted on: every create/update/reparent/delete subject,
 * plus any sibling-group that has reorders WITHOUT a create/reparent to explain them (a genuine
 * drag-to-reorder). `actions` = plan.length (every EC step), still surfaced so the work isn't hidden.
 */
export function summarizeChanges(plan: PlanStep[], desired: LModel): { changes: number; actions: number } {
  const idx = index(desired);
  const subjects = new Set<string>();        // create/update/reparent/delete — the acted-on nodes
  const causeParents = new Set<string>();    // parents whose membership changed (create/reparent) — explains reorders
  for (const s of plan) {
    if (s.kind === 'create') { subjects.add(s.node.id); causeParents.add(s.parentId); }
    else if (s.kind === 'update' || s.kind === 'delete') subjects.add(s.id);
    else if (s.kind === 'reparent') { subjects.add(s.id); causeParents.add(s.toParentId); }
    // flow steps: an add / flag flip / reference wire is one acted-on subject; flow reorders group below
    else if (s.kind === 'flowCreate') { subjects.add(s.node.id); causeParents.add(s.parentId); }
    else if (s.kind === 'flowFlag' || s.kind === 'flowWire' || s.kind === 'flowRename') subjects.add(s.id);
  }
  // reorder-only sibling groups not explained by an insert/move = a real reorder gesture; count once each
  const reorderGroups = new Set<string>();
  for (const s of plan) {
    if (s.kind === 'reorder') {
      const p = idx.get(s.id)?.parentId;
      if (p && !causeParents.has(p)) reorderGroups.add(p);
    } else if (s.kind === 'flowReorder') {
      if (!causeParents.has(s.parentId)) reorderGroups.add(s.parentId); // flow parent key, same rule
    }
  }
  return { changes: subjects.size + reorderGroups.size, actions: plan.length };
}
