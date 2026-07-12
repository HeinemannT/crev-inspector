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
import type { FlowEdit, FlowProjection, LModel, LNode, NodeKind, NodeStyle } from './types';
import { COMPOSITE_TYPES } from './constraints';

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

/** Is this wire node a layout container that OWNS its structural children — a portal `Container` or a
 *  composite widget (ButtonContainer/ButtonGroup/InputSet/TagList/ListPropertySet)? Such a parent
 *  claims its children even when BMP reports their portal `container` as the phantom RESULT placement. */
function isStructuralParent(wire: WireNode | undefined): boolean {
  return !!wire && (wire.type === 'Container' || COMPOSITE_TYPES.has(wire.type));
}

/** Layout owner of a node.
 *
 *  A node whose STRUCTURAL parent is itself a layout container/composite nests under that parent — even
 *  though BMP reports the child's portal `container` as the phantom RESULT placement. This covers two
 *  cases that otherwise leaked onto the Result tab (verified live on demo scorecard 4957):
 *   - a composite child (an ActionButton under its ButtonContainer 5919, reported container=RESULT)
 *   - a model `Container`'s children (table + create-object under Container 455, reported container=RESULT)
 *  Both belong to their parent, not the Result tab.
 *
 *  Otherwise the universal rule holds: a portal placement (`containerRid`) wins, else the structural
 *  parent (`parentRid`):
 *   - widget bound to a portal cell      → containerRid (the cell)
 *   - portal Tab/Container               → containerRid empty → parentRid (tabset / parent tab)
 *   - org Container placed in a tab       → containerRid (the tab it was assigned to)
 *   - top-level Result widget            → containerRid (the Result tab), parent is the page (not in set) */
function ownerOf(n: WireNode, byRid: Map<string, WireNode>): string | undefined {
  if (n.parentRid && isStructuralParent(byRid.get(n.parentRid))) return n.parentRid;
  return n.containerRid ?? n.parentRid;
}

export interface ReconstructCtx {
  pageId: string;
  pageRid?: string;
  pageClass?: string;
  tabsetId: string;
  target?: 'instance' | 'template';
  hasTemplate?: boolean;
  /** When this page is an instance reusing a linkedTo template (SharedWebItems), the template's rid + id.
   *  Lets the UI toggle to — and default to — editing the shared template. Absent for the template itself,
   *  enterprise pages, and plain pages with no template. */
  templateRid?: string;
  templateId?: string;
  /** Toggle runtime state (filled by layout-service.loadPage for a templated instance, so the chrome
   *  can render the [Template | This instance] toggle + labels). `editingTemplate` = the loaded layout
   *  is the shared template; `instanceId` = the instance's businessId (for the label). */
  editingTemplate?: boolean;
  instanceId?: string;
  /** True when the page has no dedicated tabset — its widgets sit on the shared Result tab. The page
   *  still loads (showing the Result tab + its widgets, via default_tabset + withContent); the UI then
   *  offers a "+ Create tabset" affordance in the tab bar instead of a blocking modal. */
  resultOnly?: boolean;
  /** How to derive the page's tab list from the tabset:
   *   - 'all' (default): every tab the tabset owns — correct for a DEDICATED tabset (Scorecard /
   *     ModelPage), where the tabset belongs to this page.
   *   - 'withContent': only tabs that actually hold one of this page's widgets — required for the
   *     SHARED `default_tabset` used by enterprise objects, which carries 20+ system tabs that
   *     aren't this page's. Matches BMP's real "tab strip = union of tabs widgets resolve to". */
  tabScope?: 'all' | 'withContent';
}

export function reconstruct(nodes: readonly WireNode[], ctx: ReconstructCtx, overrides?: Map<string, string[]>, styles?: Map<string, NodeStyle>, flows?: Map<string, FlowProjection>): LModel {
  const byRid = new Map<string, WireNode>();
  for (const n of nodes) byRid.set(n.rid, n);

  // children-by-owner, preserving input (sortIndex) order
  const childrenOf = new Map<string, WireNode[]>();
  for (const n of nodes) {
    const owner = ownerOf(n, byRid);
    if (!owner || !byRid.has(owner)) continue;
    (childrenOf.get(owner) ?? childrenOf.set(owner, []).get(owner)!).push(n);
  }

  const build = (wire: WireNode): LNode => {
    const kids = (childrenOf.get(wire.rid) ?? []).map(build);
    const id = wire.businessId ?? wire.rid;
    const ovr = overrides?.get(id);
    const sty = styles?.get(id);
    return {
      id,
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
      ...(ovr && ovr.length ? { overrides: ovr } : {}),
      ...(sty ? { style: sty } : {}),
      children: orderChildren(kids),
    };
  };

  // tabs = every emitted Tab node, in emit order. Not just the page tabset's children: a page can show
  // tabs from more than one tabset (the shared "Result" tab lives in default_tabset, not the page's own
  // tabset, yet renders in the same strip). Tabs never nest, so each Tab node is a root here.
  let tabs = nodes.filter(n => kindOf(n.type) === 'tab').map(build);
  // shared-tabset pages keep only tabs that hold one of THIS page's widgets (see tabScope doc)
  if (ctx.tabScope === 'withContent') tabs = tabs.filter(t => descendantWidgets(t).length > 0);
  // The Result tab is a system tab (where unplaced widgets land). Show it only when it actually holds
  // one of this page's widgets — like any other tab — not as an empty placeholder on every page.
  tabs = tabs.filter(t => !isResultTab(t) || descendantWidgets(t).length > 0);

  return {
    pageId: ctx.pageId,
    pageRid: ctx.pageRid,
    pageClass: ctx.pageClass ?? 'Scorecard',
    tabsetId: ctx.tabsetId,
    tabs,
    target: ctx.target ?? 'template',
    hasTemplate: ctx.hasTemplate ?? false,
    ...(ctx.resultOnly ? { resultOnly: true } : {}),
    // Flow projections ride alongside as a read-only map (never diffed). Empty when the fetch found no
    // flow-bearing widgets — the model then behaves exactly as before flow editing existed.
    ...(flows && flows.size ? { flows: Object.fromEntries(flows) } : {}),
  };
}

/** Containers before tab-bound widgets, stable within each band (= verified BMP render order). */
export function orderChildren(children: LNode[]): LNode[] {
  return [
    ...children.filter(c => c.kind === 'container'),
    ...children.filter(c => c.kind !== 'container'),
  ];
}

/** Enforce canonical band order (orderChildren) on every children array, in place. The edit
 *  engine runs this after every mutation so the model's raw array order can never drift from
 *  BMP's rendered order — the drift is what made "insert after X" land somewhere else once the
 *  renderer re-banded. Stable: a band-legal splice is untouched; a cross-band splice snaps to
 *  its band (the resolver should have prevented it — this is the safety net, not the fix). */
export function normalizeModel(m: LModel): LModel {
  const rec = (list: LNode[]): void => {
    const sorted = orderChildren(list);
    for (let i = 0; i < list.length; i++) list[i] = sorted[i];
    for (const n of list) rec(n.children);
  };
  for (const t of m.tabs) rec(t.children);
  return m;
}

// ── tree helpers ───────────────────────────────────────────────────────────

export function cloneModel(m: LModel): LModel {
  return {
    ...m,
    tabs: m.tabs.map(cloneNode),
    // `flows` is read-only (never mutated after load), so the projection objects can be shared; the
    // record is spread so it's a distinct container. `flowEdits` IS mutated per edit, so it's deep-cloned
    // (structuredClone-free: staged flow state must survive undo/redo without aliasing the baseline).
    ...(m.flows ? { flows: { ...m.flows } } : {}),
    ...(m.flowEdits ? { flowEdits: cloneFlowEdits(m.flowEdits) } : {}),
    // read-only, like `flows` — the on-demand cache of a wired existing off-page reference's children,
    // so it survives edits/undo without deep-cloning (a session cache, keyed by ref businessId).
    ...(m.flowRefChildren ? { flowRefChildren: { ...m.flowRefChildren } } : {}),
  };
}

/** Deep-clone the staged flow-edit map (arrays + nested FlowNode subtrees) so an edit on the working
 *  model never reaches back into a history snapshot or the baseline. */
export function cloneFlowEdits(fe: Record<string, FlowEdit>): Record<string, FlowEdit> {
  const cloneFlowNode = (n: import('./types').FlowNode): import('./types').FlowNode => ({
    ...n,
    ...(n.dots ? { dots: n.dots.map(d => ({ ...d })) } : {}),
    ...(n.children ? { children: n.children.map(cloneFlowNode) } : {}),
  });
  const out: Record<string, FlowEdit> = {};
  for (const [k, e] of Object.entries(fe)) {
    out[k] = {
      ...(e.adds ? { adds: e.adds.map(cloneFlowNode) } : {}),
      ...(e.order ? { order: [...e.order] } : {}),
      ...(e.displayOnActionMenu !== undefined ? { displayOnActionMenu: e.displayOnActionMenu } : {}),
      ...(e.displayOnAllTabs !== undefined ? { displayOnAllTabs: e.displayOnAllTabs } : {}),
      // staged-new container + reference wire — dropping these on clone silently un-staged them
      // (every mutation path clones, so a second edit erased the first; caught by the flow tests)
      ...(e.newContainer ? { newContainer: { ...e.newContainer } } : {}),
      ...(e.wireRef ? { wireRef: { ...e.wireRef } } : {}),
      // rename is set AFTER a clone by renameFlowObject, so a single rename survives — but ANY later
      // edit clones again, and dropping it here silently reverted the rename (and left a phantom empty
      // entry inflating the pending count). Every FlowEdit field must be carried, no exceptions.
      ...(e.rename !== undefined ? { rename: e.rename } : {}),
    };
  }
  return out;
}
export function cloneNode(n: LNode): LNode {
  return {
    ...n, cols: { ...n.cols },
    ...(n.overrides ? { overrides: [...n.overrides] } : {}),
    ...(n.resets ? { resets: [...n.resets] } : {}),
    ...(n.style ? { style: { ...n.style } } : {}), // fresh object so style edits don't mutate the baseline
    children: n.children.map(cloneNode),
  };
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

/** Visit `node` and all its descendants, pre-order. The single-subtree counterpart to `walk` (which
 *  covers the whole model) — use instead of hand-rolling `const rec = n => { …; n.children.forEach(rec) }`. */
export function eachInSubtree(node: LNode, fn: (n: LNode) => void): void {
  fn(node);
  for (const c of node.children) eachInSubtree(c, fn);
}

/** Do a node's editable scalar fields (column span, name, height) differ? The shared field-compare
 *  behind the result canvas's `cellState` and the live view's `nodeState` "changed" classification. */
export function fieldsChanged(a: LNode, b: LNode): boolean {
  return a.cols.L !== b.cols.L || a.name !== b.name || a.height !== b.height;
}

/** All widget leaves reachable from a node (for container delete re-home). */
export function descendantWidgets(n: LNode): LNode[] {
  const out: LNode[] = [];
  const rec = (x: LNode) => x.children.forEach(c => (c.kind === 'widget' ? out.push(c) : rec(c)));
  rec(n);
  return out;
}

/** Widgets that actually render for a viewer — full ghosts (noVisible, or hidden on
 *  every display size) excluded. A tab whose widgets are ALL ghosts is hidden by BMP
 *  exactly like an empty tab (verified live 2026-07-06), so "does this tab appear on
 *  the page" must count these, not raw `descendantWidgets`. NOT a global swap: the
 *  ghost tray + other counts still need every widget. */
export function descendantVisibleWidgets(n: LNode): LNode[] {
  return descendantWidgets(n).filter(w => !isFullGhost(w));
}

let tmpSeq = 0;
/** Fresh temp id for a staged add (resolved to a real id by the post-apply re-fetch). */
export function tempId(prefix = 'new'): string {
  tmpSeq += 1;
  return `${prefix}:${tmpSeq}`;
}
export const isTempId = (id: string): boolean => id.includes(':');

/** A FULL ghost never renders for anyone: `visibility = NOVISIBLE`, or every
 *  ScreenSizeVisibility flag off. BMP's packing reflows around it (verified
 *  live 2026-07-06: A|B|C 2+2+2 row; hiding B slid C into its slot) — so the
 *  blueprint grid must exclude ghosts or the layout it shows is false. NOTE
 *  adminVisibleOnly / visibleAsParentOnly are NOT ghosts here (they render
 *  for the configurator); they get a cell marker instead. */
export function isFullGhost(n: LNode): boolean {
  const s = n.style;
  if (!s) return false;
  if (s.visibility === 'NOVISIBLE') return true;
  return s.shownOnLargeDisplay === false && s.shownOnMediumDisplay === false && s.shownOnSmallDisplay === false;
}
