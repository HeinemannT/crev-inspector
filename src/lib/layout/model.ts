/**
 * Model reconstruction + tree helpers.
 *
 * `reconstruct` is the ONLY place that touches the wire `LayoutNode`. It folds the flat node
 * list (tabs/containers linked by `parentRid`, widgets bound by `containerRid`) into the
 * editable `LModel` tree, ordered containers-first (verified: BMP renders containers before
 * tab-bound widgets). The caller (sync layer) is responsible for fetching a node list that
 * contains BOTH the tabset's tab/container subtree AND the scorecard's widgets with their
 * container bindings.
 */
import type { LayoutNode as WireNode } from '../types';
import type { LModel, LNode, NodeKind } from './types';

const CHART_CLASSES = /Chart$/;
export const isChart = (className: string): boolean => CHART_CLASSES.test(className);
/** Types that carry a real, authorable height property in BMP. */
export const hasHeight = (className: string): boolean => isChart(className) || className === 'URLView';

function kindOf(type: string): NodeKind {
  if (type === 'Tab') return 'tab';
  if (type === 'Container') return 'container';
  return 'widget';
}

/** BMP's constant businessId for a scorecard's intrinsic "Result" tab. It lives in the SHARED
 *  `default_tabset` (not the page's own tabset), so editing its structure (the tab itself, or any
 *  container created on it) reaches every object that shares that tabset — hence it's locked against
 *  rename/delete and carries a loud blast-radius warning on apply. Its directly-bound widgets are the
 *  page's own objects, so editing THOSE is page-local and safe. */
export const RESULT_TAB_ID = 'RESULT';
export const isResultTab = (n: { kind: NodeKind; id: string }): boolean => n.kind === 'tab' && n.id === RESULT_TAB_ID;

/** Layout owner of a node — uniform across kinds: a portal placement (`containerRid`) wins,
 *  else the structural parent (`parentRid`). This one rule covers every observed case:
 *   - widget bound to a portal cell      → containerRid (the cell)
 *   - portal Tab/Container               → containerRid empty → parentRid (tabset / parent tab)
 *   - org Container placed in a tab       → containerRid (the tab it was assigned to)
 *   - composite child (button in a       → containerRid empty (RESULT) → parentRid (the
 *     ButtonContainer)                       ButtonContainer it nests under)
 *  The fetch maps the phantom RESULT placement to an empty containerRid, so unplaced widgets
 *  fall through to their org parent (the scorecard) and get pruned out as orphans. */
function ownerOf(n: WireNode): string | undefined {
  return n.containerRid ?? n.parentRid;
}

export interface ReconstructCtx {
  pageId: string;
  pageRid?: string;
  pageClass?: string;
  tabsetId: string;
  target?: 'instance' | 'template';
  hasTemplate?: boolean;
  /** How to derive the page's tab list from the tabset:
   *   - 'all' (default): every tab the tabset owns — correct for a DEDICATED tabset (Scorecard /
   *     ModelPage), where the tabset belongs to this page.
   *   - 'withContent': only tabs that actually hold one of this page's widgets — required for the
   *     SHARED `default_tabset` used by enterprise objects, which carries 20+ system tabs that
   *     aren't this page's. Matches BMP's real "tab strip = union of tabs widgets resolve to". */
  tabScope?: 'all' | 'withContent';
}

export function reconstruct(nodes: readonly WireNode[], ctx: ReconstructCtx): LModel {
  const byRid = new Map<string, WireNode>();
  for (const n of nodes) byRid.set(n.rid, n);

  // children-by-owner, preserving input (sortIndex) order
  const childrenOf = new Map<string, WireNode[]>();
  for (const n of nodes) {
    const owner = ownerOf(n);
    if (!owner || !byRid.has(owner)) continue;
    (childrenOf.get(owner) ?? childrenOf.set(owner, []).get(owner)!).push(n);
  }

  const build = (wire: WireNode): LNode => {
    const kids = (childrenOf.get(wire.rid) ?? []).map(build);
    return {
      id: wire.businessId ?? wire.rid,
      rid: wire.rid,
      kind: kindOf(wire.type),
      className: wire.type,
      name: wire.name ?? wire.businessId ?? wire.rid,
      cols: {
        L: wire.columnsLargeScreen ?? 6,
        ...(wire.columnsMediumScreen != null ? { M: wire.columnsMediumScreen } : {}),
        ...(wire.columnsSmallScreen != null ? { S: wire.columnsSmallScreen } : {}),
      },
      ...(wire.chartHeight != null ? { height: wire.chartHeight } : {}),
      children: orderChildren(kids),
    };
  };

  // tabs = every emitted Tab node, in emit order. Not just the page tabset's children: a page can show
  // tabs from more than one tabset (the shared "Result" tab lives in default_tabset, not the page's own
  // tabset, yet renders in the same strip). Tabs never nest, so each Tab node is a root here.
  let tabs = nodes.filter(n => kindOf(n.type) === 'tab').map(build);
  // shared-tabset pages keep only tabs that hold one of THIS page's widgets (see tabScope doc)
  if (ctx.tabScope === 'withContent') tabs = tabs.filter(t => descendantWidgets(t).length > 0);

  return {
    pageId: ctx.pageId,
    pageRid: ctx.pageRid,
    pageClass: ctx.pageClass ?? 'Scorecard',
    tabsetId: ctx.tabsetId,
    tabs,
    target: ctx.target ?? 'template',
    hasTemplate: ctx.hasTemplate ?? false,
  };
}

/** Containers before tab-bound widgets, stable within each band (= verified BMP render order). */
export function orderChildren(children: LNode[]): LNode[] {
  return [
    ...children.filter(c => c.kind === 'container'),
    ...children.filter(c => c.kind !== 'container'),
  ];
}

// ── tree helpers ───────────────────────────────────────────────────────────

export function cloneModel(m: LModel): LModel {
  return { ...m, tabs: m.tabs.map(cloneNode) };
}
export function cloneNode(n: LNode): LNode {
  return { ...n, cols: { ...n.cols }, children: n.children.map(cloneNode) };
}

export interface Found {
  node: LNode;
  /** the LNode whose `children` array holds `node`, or null when `node` is a tab. */
  parent: LNode | null;
  siblings: LNode[];
  index: number;
}

/** Locate a node anywhere in the model (tabs + their subtrees). */
export function findNode(m: LModel, id: string): Found | null {
  const inList = (list: LNode[], parent: LNode | null): Found | null => {
    for (let i = 0; i < list.length; i++) {
      if (list[i].id === id) return { node: list[i], parent, siblings: list, index: i };
      const deep = inList(list[i].children, list[i]);
      if (deep) return deep;
    }
    return null;
  };
  return inList(m.tabs, null);
}

/** Depth-first walk over every node (tabs included). */
export function walk(m: LModel, fn: (n: LNode, parent: LNode | null) => void): void {
  const rec = (list: LNode[], parent: LNode | null) => {
    for (const n of list) { fn(n, parent); rec(n.children, n); }
  };
  rec(m.tabs, null);
}

/** All widget leaves reachable from a node (for container delete re-home). */
export function descendantWidgets(n: LNode): LNode[] {
  const out: LNode[] = [];
  const rec = (x: LNode) => x.children.forEach(c => (c.kind === 'widget' ? out.push(c) : rec(c)));
  rec(n);
  return out;
}

let tmpSeq = 0;
/** Fresh temp id for a staged add (resolved to a real id by the post-apply re-fetch). */
export function tempId(prefix = 'new'): string {
  tmpSeq += 1;
  return `${prefix}:${tmpSeq}`;
}
export const isTempId = (id: string): boolean => id.includes(':');
