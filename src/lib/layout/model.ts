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

/** Layout owner of a node: widgets bind via `containerRid`; tabs/containers via `parentRid`. */
function ownerOf(n: WireNode): string | undefined {
  return kindOf(n.type) === 'widget' ? (n.containerRid ?? n.parentRid) : n.parentRid;
}

export interface ReconstructCtx {
  scorecardId: string;
  scorecardRid?: string;
  scorecardClass?: string;
  tabsetId: string;
  target?: 'instance' | 'template';
  hasTemplate?: boolean;
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
      children: orderChildren(kids),
    };
  };

  // tabs = the children of the tabset (any node whose owner is the tabset rid AND is a Tab)
  const tabsetWire = nodes.find(n => n.businessId === ctx.tabsetId || n.rid === ctx.tabsetId);
  const tabWires = tabsetWire ? (childrenOf.get(tabsetWire.rid) ?? []).filter(n => kindOf(n.type) === 'tab') : [];

  return {
    scorecardId: ctx.scorecardId,
    scorecardRid: ctx.scorecardRid,
    scorecardClass: ctx.scorecardClass ?? 'Scorecard',
    tabsetId: ctx.tabsetId,
    tabs: tabWires.map(build),
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
