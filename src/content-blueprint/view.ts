/**
 * Blueprint view — `render()` rebuilds the overlay from `bp` state, plus the per-element builders
 * (boxes, toolbar, pickers, tab bar, preview modal). Geometry from the DOM, everything else from the
 * model. Handlers call into the controller (actions.ts) — see the cycle note there.
 *
 * Render strategy: boxes are anchored to the BASELINE widgets (each has a live DOM element), then
 * styled by their state in the edited model — unchanged / changed (badge) / will-delete (strike) /
 * moved (→ dest). Deletions stay visible (the DOM widget is still there until apply). Staged adds
 * have no DOM, so they draw as dashed placeholders in their host's area.
 */
import type { LModel, LNode } from '../lib/layout/types';
import { findNode, walk, hasHeight, isChart, orderChildren, isResultTab, fieldsChanged } from '../lib/layout/model';
import { COMPOSITE_TYPES, COMPOSITE_CHILDREN } from '../lib/layout/constraints';
import { isAncestorOf } from '../lib/layout/edit';
import { diff, summarizeChanges } from '../lib/layout/diff';
import { ICON_PLUS, ICON_MINUS, ICON_PENCIL, ICON_TRASH, ICON_ARROW_RIGHT, ICON_X, ICON_LAYOUT, ICON_LINK } from '../lib/icons';
import { bp, model, PALETTE, MOST_USED } from './state';
import { type Rect, ridElementMap, unionRect, anchorRect, setIcon, mkBtn, mkIconBtn, delta, placeDoc, docX, docY } from './geometry';
import {
  select, beginRename, viewTab, addTabAction, setWidth, setH, doDelete, doRename, openPicker, addFromPicker, closePicker, addContainerTo,
  openMovePicker, closeMovePicker, moveTo,
} from './actions';
import { armBox, armResize } from './gestures';
import { renderChip, previewModal, trayPanel, hintBar, createTabsetModal } from './view-panels';
import { renderResult, typeIcon } from './result';

const STACKED_ADD_STEP = 42; // px each staged-add placeholder is offset below the previous, in the live fallback

// The pending-change count is recomputed on every render, but a pure scroll/observer render leaves the
// model unchanged — and diff() builds two index maps and is ~O(n²) in its reorder phase. Memoise the count
// by (baseline identity, history revision): both invalidate it on a real edit/load. (present() clones, so
// we key on the revision counter, not the model object.)
let pendCache: { base: LModel; rev: number; changes: number } | null = null;
function pendingCount(base: LModel, m: LModel): number {
  const rev = bp.history?.revision() ?? -1;
  if (pendCache && pendCache.base === base && pendCache.rev === rev) return pendCache.changes;
  const changes = summarizeChanges(diff(base, m), m).changes;
  pendCache = { base, rev, changes };
  return changes;
}

/** The model tab BMP is actually showing. Prefer BMP's OWN selected tab (matched by name) over the
 *  "first model tab with visible widgets" heuristic — the shared Result tab's widgets render on every
 *  tab (a persistent action bar), so once Result leads the list the heuristic would always pick it. */
function liveModelTabId(base: LModel, byRid: Map<string, Element>): string | null {
  const sel = document.querySelector('.corpo-tabSet__tab--selected, .corpo-tabSet__tab[aria-selected="true"]');
  const name = sel?.textContent?.trim();
  if (name) { const t = base.tabs.find((t) => t.name === name); if (t) return t.id; }
  return base.tabs.find((t) => unionRect(t, byRid))?.id ?? null;
}

export function render(): void {
  const layer = bp.layer;
  if (!layer) return;
  // An inline-rename field is open — a rebuild here would textContent='' the layer and destroy the
  // contenteditable span mid-edit (focus() scrolling it into view fires a scroll→render that otherwise
  // wipes the field the instant it appears). Freeze until blur commits and clears the flag.
  if (bp.renaming) return;
  if (bp.peek) layer.classList.add('bp-peek'); // keep a sticky peek across re-renders (add-only: don't kill a transient hover)
  // No-tabset page: show the create-tabset prompt (there's no model to edit until one exists).
  if (bp.needsTabset) {
    layer.textContent = '';
    layer.appendChild(createTabsetModal(bp.needsTabset));
    neutralizeScrollRoom();
    return;
  }
  const base = bp.baseline, m = model(), ctx = bp.ctx;
  if (!base || !m || !ctx) return;
  // FLIP: record cell positions BEFORE the clear when this render follows an edit (bp.flipNext), so we
  // can animate them to their new spots after. Not on scroll/observer renders (cells would slide on
  // every scroll). Captured by bpid so a cell that re-parents (moved into another container) still flips.
  const flip = bp.flipNext; bp.flipNext = false;
  const oldRects = flip ? cellRects(layer) : null;
  layer.textContent = '';
  const byRid = ridElementMap();
  const pending = pendingCount(base, m); // headline = logical changes; memoised so pure scroll/observer renders skip diff()
  // Command chip + the tab bar (tab manager AND canvas switcher — the canvas shows one tab at a time,
  // these pills pick which). BMP's live tab is marked so you can tell the on-screen tab from a peeked one.
  const liveId = liveModelTabId(base, byRid);
  // One resolved viewed-tab id for BOTH the canvas and the highlighted pill, so they never disagree:
  // an explicit pick, else BMP's live model tab, else the first model tab (when BMP sits on the
  // non-model Result tab). Without this the canvas showed the first tab while no pill was highlighted.
  const viewedId = bp.viewTabId ?? liveId ?? m.tabs[0]?.id ?? null;
  const header = document.createElement('div');
  header.className = 'bp-header' + (ctx.target === 'template' ? ' tmpl' : '');
  header.append(renderChip(ctx, pending), tabBar(base, m, liveId, viewedId));
  layer.appendChild(header);

  // The result canvas IS the editor: the edited model laid out as a CSS-grid wireframe (final
  // positions, real heights, all tabs, honest drop targets). It's always the primary surface; the
  // live diff-over-frozen-grid path below is only a fallback for a page the result view can't anchor
  // to (no active tab with live widgets). (The live "real page" view is slated to move into inspect
  // mode — see docs/blueprint.md.) Selection toolbar + pickers + tray + modal render at the foot.
  if (renderResult(base, m, byRid, layer, viewedId)) {
    bp.resultMode = true;
    renderFloatingChrome(byRid, m);
    if (oldRects) flipFrom(layer, oldRects); // animate moved/reordered cells to their new positions
    ensureScrollRoom(layer.querySelector('.bp-result')); // let the page scroll to a panel taller than BMP's content
    return;
  }
  bp.resultMode = false;
  renderLiveFallback(base, m, byRid, layer);
  renderFloatingChrome(byRid, m);
}

/** The LIVE-fallback render path (for a page the result canvas can't anchor to): boxes anchored to
 *  BMP's frozen DOM with edits shown as badges, plus staged-add placeholders and empty-space add zones.
 *  Slated to move into inspect mode (see docs/blueprint.md) — kept out of render() so the primary path
 *  reads as "chrome → result-or-fallback → floating chrome". */
function renderLiveFallback(base: LModel, m: LModel, byRid: Map<string, Element>, layer: HTMLElement): void {
  neutralizeScrollRoom(); // live-fallback boxes anchor within the page's own scroll — no extra room needed

  // container boxes first (behind), sized to the union of their live child-widget rects
  walk(base, (node) => {
    if (node.kind !== 'container') return;
    const rect = unionRect(node, byRid);
    if (!rect) return;
    if (nodeState(node, m) === 'gone') return; // deleted container → its widgets re-home; skip the box
    layer.appendChild(containerBox(node, rect, m));
  });

  // widget boxes, anchored to live DOM
  walk(base, (node, parent) => {
    if (node.kind !== 'widget' || !node.rid) return;
    const el = byRid.get(node.rid);
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return;
    layer.appendChild(widgetBox(node, r, m, parent?.id ?? null));
  });

  // NEW widgets (staged adds) have no DOM — draw dashed placeholders stacked at the bottom of their
  // host's live area, so you can see what will be created and where.
  const stackY = new Map<string, number>();
  walk(m, (node, parent) => {
    if (node.kind !== 'widget' || !parent) return;
    const isAdd = !node.rid; // rid-less ⇒ staged add
    // A MOVED widget keeps its rid but now lives under a different parent — show a placeholder in the
    // destination so the move is visible (the live original stays dimmed in place; the grid can't reflow).
    const moved = !isAdd && (() => { const b = findNode(base, node.id); return !!b && (b.parent?.id ?? null) !== parent.id; })();
    if (!isAdd && !moved) return;
    const host = findNode(base, parent.id)?.node;
    const rect = host ? anchorRect(host, byRid) : null; // union for a container, own box for a composite
    if (!rect) return;
    const offset = stackY.get(parent.id) ?? 0;
    stackY.set(parent.id, offset + STACKED_ADD_STEP);
    layer.appendChild(newWidgetBox(node, { left: rect.left, top: rect.top + rect.height + 4 + offset, width: rect.width, height: 38 }, moved ? 'moved' : 'new'));
  });

  // Empty-space "add widget" drop zones. The active tab is the one whose widgets are in the live DOM.
  // Free columns are computed EXACTLY from the model (pack children by cols.L into 6-wide rows) and
  // positioned from the live rects: a partially-filled row gets a hatched slot in its trailing gap,
  // and the tab root gets a full-width "new row" zone below all content. Clicking a zone adds to that
  // level (tab or container). Recurses into containers so nested gaps are fillable too.
  const activeTab = base.tabs.find((t) => unionRect(t, byRid));
  if (activeTab) {
    addGapZones(activeTab, byRid, layer);      // horizontal: free columns in a partly-filled row
    addColumnGaps(activeTab, byRid, layer);    // vertical: whitespace below a short container in a row
    const lr = unionRect(activeTab, byRid)!;
    const extra = stackY.size ? Math.max(...stackY.values()) : 0;
    layer.appendChild(availZone(activeTab.id, activeTab.name, { left: lr.left, top: lr.top + lr.height + 8 + extra, width: lr.width, height: 40 }));
  }
}

/** Selection toolbar + move-menu + add-picker + tray + hint + apply modal. These anchor to a node's
 *  box (resolved via `anchorRect`, which works in either view) and otherwise float, so both the live
 *  and result views share them verbatim. */
function renderFloatingChrome(byRid: Map<string, Element>, m: LModel): void {
  const layer = bp.layer!, base = bp.baseline!, ctx = bp.ctx!;
  // selection toolbar (hidden while a modal/picker is up)
  if (!bp.preview && !bp.picker && !bp.movePicker) {
    const selBox = bp.selectedId ? findNode(m, bp.selectedId) : null;
    // Tabs own their rename/add/delete on the pill itself — the generic toolbar's Rename targets
    // a `.bp-box .bp-nm` a pill doesn't have, and its W/Delete just duplicate the pill. Skip it.
    if (selBox && selBox.node.kind !== 'tab') {
      // Prefer the RESULT CELL's box — that's the surface the user sees and edits. anchorRect (the live
      // widget's real-page position) is only the fallback for the no-result live view; using it first
      // anchored the toolbar to where the widget sits on the real page, not its result cell.
      const anchor = resultAnchor(selBox.node.id) ?? anchorRect(selBox.node, byRid);
      if (anchor) layer.appendChild(toolbar(selBox.node, anchor));
    }
  }

  if (bp.movePicker) {
    const f = findNode(m, bp.movePicker);
    const anchor = resultAnchor(bp.movePicker) ?? (f ? anchorRect(f.node, byRid) : null);
    layer.appendChild(moveMenu(bp.movePicker, anchor ?? { left: 80, top: 80, width: 0, height: 0 }));
  }
  if (bp.picker) layer.appendChild(pickerPanel(byRid));
  if (bp.trayOpen) layer.appendChild(trayPanel(base, m));
  if (bp.hint) layer.appendChild(hintBar(bp.hint));
  if (bp.preview) layer.appendChild(previewModal(bp.preview, ctx));
  openPendingRename(); // the cell is freshly rendered + selected — safe to make its name editable now
}

/** Snapshot each result cell's on-screen box, keyed by bpid — the "First" of a FLIP. */
function cellRects(layer: HTMLElement): Map<string, DOMRect> {
  const m = new Map<string, DOMRect>();
  layer.querySelectorAll('.bp-rcell[data-bpid]').forEach(el => m.set((el as HTMLElement).dataset.bpid!, el.getBoundingClientRect()));
  return m;
}

/** FLIP: for each freshly-rendered cell that existed before, translate it back to its OLD position and
 *  transition to 0 — so a moved/reordered cell slides to its new home instead of jumping. */
function flipFrom(layer: HTMLElement, old: Map<string, DOMRect>): void {
  const moved: HTMLElement[] = [];
  for (const el of layer.querySelectorAll('.bp-rcell[data-bpid]') as NodeListOf<HTMLElement>) {
    const o = old.get(el.dataset.bpid!); if (!o) continue;
    const n = el.getBoundingClientRect();
    const dx = o.left - n.left, dy = o.top - n.top;
    if (Math.abs(dx) < 2 && Math.abs(dy) < 2) continue;
    el.style.transition = 'none';
    el.style.transform = `translate(${dx}px, ${dy}px)`;
    moved.push(el);
  }
  if (!moved.length) return;
  // Two rAFs: the first lets the inverted (old-position) transform paint, the second animates it to 0.
  requestAnimationFrame(() => requestAnimationFrame(() => {
    for (const el of moved) {
      el.style.transition = 'transform .24s cubic-bezier(.2,.7,.3,1)';
      el.style.transform = '';
      el.addEventListener('transitionend', () => { el.style.transition = ''; }, { once: true });
    }
  }));
}

/** The wireframe panel can be TALLER than BMP's live content — a staged add below the last row, a
 *  height-bumped cell, or just the bottom "Add a row" zone — but the page's scroll height is sized to
 *  BMP's content, leaving that overflow in an unreachable dead zone (no scrollbar reaches it). BMP scrolls
 *  the document itself (no inner scroll container), so a hidden body-level spacer extends the document's
 *  scrollHeight to cover the overflow.
 *
 *  We pin the spacer at the panel's DOCUMENT-space bottom (`rect.bottom + scrollY`). That's scroll-
 *  invariant: the panel follows the content (panel.top = frame.top = top0 − scrollY), so bottom + scrollY
 *  collapses to a constant. (It only looped before because the sticky-strip clamp froze the panel in the
 *  viewport, so bottom + scrollY grew with every scroll — fixed by clamping only at the top of the page.) */
function ensureScrollRoom(panel: Element | null): void {
  if (!panel) return;
  let sp = bp.scrollSpacer;
  if (!sp) {
    sp = document.createElement('div'); sp.id = 'crev-blueprint-scroll-spacer';
    sp.style.cssText = 'position:absolute;left:0;top:0;width:1px;height:1px;margin:0;padding:0;border:0;pointer-events:none;visibility:hidden';
    document.body.appendChild(sp); bp.scrollSpacer = sp;
  }
  const r = panel.getBoundingClientRect();
  sp.style.top = `${Math.round(r.bottom + window.scrollY + 24)}px`; // panel bottom in document space + a little margin
}

/** Collapse the scroll spacer (top:0) so it adds no room — for the live-fallback / no-tabset renders that
 *  don't have a tall panel. NOT done on every result render: removing it while scrolled to the bottom
 *  shrinks scrollHeight, the browser clamps scrollY, and the re-measure under-extends (a scroll jump). */
function neutralizeScrollRoom(): void {
  if (bp.scrollSpacer) bp.scrollSpacer.style.top = '0px';
}

/** Anchor a floating panel to a node's result-view cell (the result wireframe has no live DOM rect,
 *  so anchorRect returns null there). Reads the rendered cell's on-screen box. */
function resultAnchor(id: string): Rect | null {
  if (!bp.layer) return null;
  const el = bp.layer.querySelector(`.bp-rcell[data-bpid="${CSS.escape(id)}"]`) as HTMLElement | null;
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { left: r.left, top: r.top, width: r.width, height: r.height };
}

// ── per-element builders ─────────────────────────────────────────────────────

type NodeState = 'same' | 'changed' | 'gone';
function nodeState(baseNode: LNode, m: LModel): NodeState {
  const cur = findNode(m, baseNode.id);
  if (!cur) return 'gone';
  return fieldsChanged(baseNode, cur.node) ? 'changed' : 'same';
}

function widgetBox(baseNode: LNode, r: DOMRect, m: LModel, baseParentId: string | null): HTMLElement {
  const found = findNode(m, baseNode.id);
  const cur = found?.node;
  const state = nodeState(baseNode, m);
  const moved = state !== 'gone' && found != null && (found.parent?.id ?? null) !== baseParentId;
  const sel = bp.selectedId === baseNode.id;
  const box = document.createElement('div');
  box.dataset.bpid = baseNode.id; box.dataset.bpkind = 'widget';
  box.className = 'bp-box'
    + (isChart(baseNode.className) ? ' bp-chart' : '')
    + (state === 'changed' || moved ? ' changed' : '')
    + (state === 'gone' ? ' del' : '')
    + (moved ? ' moved' : '')
    + (sel ? ' sel' : '');
  placeDoc(box, r);
  if (state !== 'gone') armBox(box, baseNode.id);
  else box.addEventListener('mousedown', (e) => { e.stopPropagation(); select(baseNode.id); });

  const lab = document.createElement('div'); lab.className = 'bp-lab';
  const nm = document.createElement('span'); nm.className = 'bp-nm'; nm.textContent = cur?.name ?? baseNode.name;
  const ty = document.createElement('span'); ty.className = 'ty'; ty.textContent = baseNode.className.toUpperCase();
  lab.append(nm, ty);
  if (cur && state !== 'gone') {
    if (cur.cols.L !== baseNode.cols.L) lab.appendChild(delta(`${baseNode.cols.L}→${cur.cols.L}/6`));
    else { const wd = document.createElement('span'); wd.className = 'wd'; wd.textContent = `${cur.cols.L}/6`; lab.appendChild(wd); }
    if (cur.height !== baseNode.height && cur.height != null) lab.appendChild(delta(`h${cur.height}`));
    if (moved) lab.appendChild(delta(`→ ${found?.parent?.name ?? 'tab'}`));
  }
  box.appendChild(lab);
  if (sel && cur && state !== 'gone') addHandles(box, cur);
  return box;
}

/** Dashed placeholder for a staged widget: a new add ('new', interactive + green) or the destination
 *  preview of a moved widget ('moved', non-interactive + blue, the live original stays dimmed). */
function newWidgetBox(node: LNode, r: Rect, variant: 'new' | 'moved' = 'new'): HTMLElement {
  const box = document.createElement('div');
  box.className = 'bp-box bp-new' + (variant === 'moved' ? ' bp-moveghost' : '') + (isChart(node.className) ? ' bp-chart' : '');
  placeDoc(box, r);
  if (variant === 'new') {
    box.dataset.bpid = node.id; box.dataset.bpkind = 'new';
    if (bp.selectedId === node.id) box.classList.add('sel');
    armBox(box, node.id);
  }
  const lab = document.createElement('div'); lab.className = 'bp-lab';
  const tag = document.createElement('span'); tag.className = 'newtag'; tag.textContent = variant === 'moved' ? 'MOVED HERE' : 'NEW';
  const nm = document.createElement('span'); nm.className = 'bp-nm'; nm.textContent = node.name;
  const ty = document.createElement('span'); ty.className = 'ty'; ty.textContent = node.className.toUpperCase();
  lab.append(tag, nm, ty);
  box.appendChild(lab);
  if (variant === 'new' && bp.selectedId === node.id) addHandles(box, node);
  return box;
}

/** Edge resize handles on the selected box: right = width (always), bottom = height (charts/URLView
 *  only), plus a centred dimension readout. Drag stages resize/setHeight (see gestures.ts). */
function addHandles(box: HTMLElement, node: LNode): void {
  const hr = document.createElement('div'); hr.className = 'bp-h r'; armResize(hr, node.id, 'r'); box.appendChild(hr);
  if (node.kind === 'widget' && hasHeight(node.className)) {
    const hb = document.createElement('div'); hb.className = 'bp-h b'; armResize(hb, node.id, 'b'); box.appendChild(hb);
  }
  const dim = document.createElement('div'); dim.className = 'bp-dim'; dim.textContent = `${node.cols.L} / 6`; box.appendChild(dim);
}

/** Dashed "add widget" drop zone. A drop target for drags (data-bpid/kind) and a click target that
 *  opens the picker for that level (tab or container). `opts` threads a positional + sized insert
 *  (place after a sibling, sized to a detected free-column gap). */
function availZone(parentId: string, parentName: string, r: Rect, opts?: { afterId?: string; cols?: number }): HTMLElement {
  const z = document.createElement('div'); z.className = 'bp-avail';
  z.dataset.bpid = parentId; z.dataset.bpkind = 'avail';
  placeDoc(z, r);
  z.title = `Add a widget to ${parentName}`;
  const ic = document.createElement('span'); ic.className = 'ic'; setIcon(ic, ICON_PLUS);
  const tx = document.createElement('span'); tx.textContent = 'Add widget';
  z.append(ic, tx);
  z.addEventListener('mousedown', (e) => { e.stopPropagation(); openPicker(parentId, { ...opts, at: { x: e.clientX, y: e.clientY } }); });
  return z;
}

/** Pack ordered children into 6-column rows by cols.L — the same left-to-right wrap BMP renders. */
function packRows(children: LNode[]): { cells: LNode[]; used: number }[] {
  const rows: { cells: LNode[]; used: number }[] = [];
  let row: LNode[] = [], used = 0;
  for (const c of children) {
    const sp = Math.max(1, Math.min(6, c.cols.L));
    if (used + sp > 6 && row.length) { rows.push({ cells: row, used }); row = []; used = 0; }
    row.push(c); used += sp;
  }
  if (row.length) rows.push({ cells: row, used });
  return rows;
}

/** Hatched "add" slot in the trailing free columns of EACH row. Gap detection is from the MODEL —
 *  pack children into 6-wide rows by cols.L, free = 6 − used (exact, no pixel inference). Rects + the
 *  column unit (a cell's width ÷ its cols) only POSITION/size the zone. Clicking inserts a widget
 *  after the row's last cell, sized to the gap, so BMP lands it in that free space. Recurses into
 *  containers (their own sub-grid). */
function addGapZones(level: LNode, byRid: Map<string, Element>, layer: HTMLElement): void {
  for (const row of packRows(orderChildren(level.children))) {
    const free = 6 - row.used;
    if (free < 1) continue;
    const positioned = row.cells.map((c) => ({ c, r: anchorRect(c, byRid) })).filter((x): x is { c: LNode; r: Rect } => !!x.r);
    if (!positioned.length) continue;
    const unit = positioned[0].r.width / Math.max(1, positioned[0].c.cols.L); // px per column
    const lastPos = positioned[positioned.length - 1];
    const top = Math.min(...positioned.map((p) => p.r.top));
    const height = Math.max(...positioned.map((p) => p.r.top + p.r.height)) - top;
    const left = lastPos.r.left + lastPos.r.width + 8;
    const width = free * unit - 8;
    if (width > 24) layer.appendChild(availZone(level.id, level.name, { left, top, width, height }, { afterId: lastPos.c.id, cols: free }));
  }
  for (const c of level.children) if (c.kind === 'container') addGapZones(c, byRid, layer);
}

/** Vertical free space: when a row's columns have uneven height (a short container beside a tall one),
 *  the short CONTAINER has whitespace below it down to the row's bottom. Adding into that container
 *  extends it into exactly that space, so place an "add" slot there. (A short tab-level *widget* is
 *  skipped — appending to the tab wouldn't land in its gap, so a zone there would mislead.) */
function addColumnGaps(level: LNode, byRid: Map<string, Element>, layer: HTMLElement): void {
  const kids = orderChildren(level.children)
    .map((node) => ({ node, rect: anchorRect(node, byRid) }))
    .filter((k): k is { node: LNode; rect: Rect } => !!k.rect)
    .sort((a, b) => a.rect.top - b.rect.top);
  const rows: { top: number; bottom: number; items: { node: LNode; rect: Rect }[] }[] = [];
  for (const k of kids) {
    const row = rows.find((rr) => Math.abs(rr.top - k.rect.top) < 24);
    if (row) { row.items.push(k); row.bottom = Math.max(row.bottom, k.rect.top + k.rect.height); }
    else rows.push({ top: k.rect.top, bottom: k.rect.top + k.rect.height, items: [k] });
  }
  for (const row of rows) {
    if (row.items.length < 2) continue; // no side-by-side neighbour ⇒ no ragged-column gap
    for (const k of row.items) {
      if (k.node.kind !== 'container') continue;
      const gap = row.bottom - (k.rect.top + k.rect.height);
      if (gap > 36) layer.appendChild(availZone(k.node.id, k.node.name, { left: k.rect.left, top: k.rect.top + k.rect.height + 6, width: k.rect.width, height: gap - 10 }));
    }
  }
  for (const c of level.children) if (c.kind === 'container') addColumnGaps(c, byRid, layer);
}

function containerBox(baseNode: LNode, rect: Rect, m: LModel): HTMLElement {
  const cur = findNode(m, baseNode.id)?.node;
  const sel = bp.selectedId === baseNode.id;
  const changed = !!cur && cur.cols.L !== baseNode.cols.L;
  const box = document.createElement('div');
  box.dataset.bpid = baseNode.id; box.dataset.bpkind = 'container';
  box.className = 'bp-cont' + (sel ? ' sel' : '') + (changed ? ' changed' : '');
  placeDoc(box, rect, 3); // a container frame draws 3px outside its child union
  armBox(box, baseNode.id);
  // A handle ABOVE the container's top-left, always visible: it marks where each container is (so they
  // read clearly) and hosts the add "+". It sits above the row, so it never collides with the top-left
  // widget label inside. On selection it expands with the name + width (+ handles on the box).
  const tab = document.createElement('div'); tab.className = 'bp-ctab' + (sel ? ' sel' : '');
  const add = document.createElement('button');
  add.className = 'bp-cadd'; setIcon(add, ICON_PLUS); add.title = `Add a widget to ${baseNode.name}`;
  add.addEventListener('mousedown', (e) => { e.stopPropagation(); openPicker(baseNode.id, { at: { x: e.clientX, y: e.clientY } }); });
  tab.appendChild(add);
  if (sel) {
    const cn = document.createElement('span'); cn.className = 'cname'; cn.textContent = cur?.name ?? baseNode.name;
    const cw = document.createElement('span'); cw.className = 'cw'; cw.textContent = `${cur?.cols.L ?? baseNode.cols.L}/6`;
    tab.append(cn, cw);
    if (changed && cur) tab.appendChild(delta(`${baseNode.cols.L}→${cur.cols.L}`));
  }
  // Selected-container overlay: a light scrim over the WHOLE container area with a centred
  // "CONTAINER · name" tag, so it's unambiguous you've grabbed the box and not a widget inside it.
  // pointer-events:none keeps it purely visual (drag/handles still work via the box + its controls).
  if (sel) {
    const ov = document.createElement('div'); ov.className = 'bp-cont-ov';
    const tg = document.createElement('span'); tg.className = 'bp-cont-ov-tag'; tg.textContent = 'CONTAINER';
    const nm2 = document.createElement('span'); nm2.className = 'bp-cont-ov-nm'; nm2.textContent = cur?.name ?? baseNode.name;
    ov.append(tg, nm2);
    box.appendChild(ov);
  }
  box.appendChild(tab);
  if (sel && cur) addHandles(box, cur);
  return box;
}

function toolbar(node: LNode, r: Rect): HTMLElement {
  const t = document.createElement('div'); t.className = 'bp-tools';
  // A container carries its own +/name handle (.bp-ctab) just above its box. Lift the toolbar above
  // THAT handle so the two strips stack instead of colliding (the toolbar used to land on the + label).
  // Lift the toolbar above the cell. In the LIVE view a container carries a +/name handle (.bp-ctab)
  // just above its box, so it needs extra clearance; the RESULT view has no such handle, so the big
  // container lift just left the bar floating misaligned far above. Match the cell tightly there.
  const lift = bp.resultMode ? 38 : (node.kind === 'container' ? 60 : 32);
  // document space (the layer is absolute) so the toolbar scrolls with the cell it anchors to.
  t.style.left = `${docX(Math.max(4, r.left))}px`;
  t.style.top = `${docY(Math.max(0, r.top - lift))}px`;

  const lblW = document.createElement('span'); lblW.className = 'lbl'; lblW.textContent = 'W'; t.appendChild(lblW);
  const seg = document.createElement('div'); seg.className = 'bp-seg';
  const cells: HTMLButtonElement[] = [];
  for (let i = 1; i <= 6; i++) {
    const b = document.createElement('button'); b.textContent = String(i);
    if (node.cols.L === i) b.classList.add('on');
    // hover preview: light up every segment up to the hovered one, so you see the target span before committing
    b.addEventListener('mouseenter', () => cells.forEach((c, j) => c.classList.toggle('prev', j < i)));
    b.addEventListener('mouseleave', () => cells.forEach(c => c.classList.remove('prev')));
    b.addEventListener('mousedown', (e) => { e.stopPropagation(); setWidth(node.id, i); });
    seg.appendChild(b); cells.push(b);
  }
  t.appendChild(seg);

  if (node.kind === 'widget' && hasHeight(node.className)) {
    const hl = document.createElement('span'); hl.className = 'lbl'; hl.textContent = 'H'; t.appendChild(hl);
    t.appendChild(heightControl(node, r));
  }
  if (node.kind === 'widget' && COMPOSITE_TYPES.has(node.className)) t.appendChild(mkIconBtn(ICON_PLUS, () => openPicker(node.id), 'Child'));
  if (node.kind === 'widget') t.appendChild(mkIconBtn(ICON_ARROW_RIGHT, () => openMovePicker(node.id), 'Move'));
  t.appendChild(mkIconBtn(ICON_PENCIL, () => beginRename(node.id), 'Rename'));
  const del = mkIconBtn(ICON_TRASH, () => doDelete(node.id), 'Delete'); del.classList.add('del');
  t.appendChild(del);
  return t;
}

/** Height control: small −/+ steppers (10px each) flanking a number input for an EXACT pixel height.
 *  The input seeds from the authored height, falling back to the cell's current rendered height (`r`),
 *  and commits on Enter/blur; the steppers nudge in 10px increments. setH re-renders (rebuilding this). */
function heightControl(node: LNode, r: Rect): HTMLElement {
  const box = document.createElement('div'); box.className = 'bp-hbox';
  const base = (): number => Math.round(node.height ?? r.height);
  const minus = document.createElement('button'); minus.className = 'bp-hstep'; setIcon(minus, ICON_MINUS); minus.title = '−10px';
  minus.addEventListener('mousedown', (e) => { e.stopPropagation(); setH(node.id, Math.max(20, base() - 10)); });
  const inp = document.createElement('input'); inp.className = 'bp-hpx'; inp.type = 'number'; inp.min = '20'; inp.value = String(base()); inp.title = 'Height in pixels';
  inp.addEventListener('mousedown', (e) => e.stopPropagation());
  const commit = (): void => { const v = parseInt(inp.value, 10); if (!isNaN(v) && v >= 20) setH(node.id, v); };
  inp.addEventListener('change', commit);
  inp.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') { e.preventDefault(); commit(); } e.stopPropagation(); });
  const plus = document.createElement('button'); plus.className = 'bp-hstep'; setIcon(plus, ICON_PLUS); plus.title = '+10px';
  plus.addEventListener('mousedown', (e) => { e.stopPropagation(); setH(node.id, base() + 10); });
  box.append(minus, inp, plus);
  return box;
}

/** The add picker — searchable. A composite target offers only its valid children; else the palette. */
function pickerPanel(byRid: Map<string, Element>): HTMLElement {
  const cid = bp.picker!;
  const host = bp.baseline ? findNode(bp.baseline, cid)?.node : null;
  const back = document.createElement('div'); back.className = 'bp-pick-back';
  back.addEventListener('mousedown', (e) => { if (e.target === back) closePicker(); });
  const panel = document.createElement('div'); panel.className = 'bp-pick';
  // Anchor at the CLICK point ("where I am") when we have it — a tab-level add zone has no cell to anchor
  // to, which used to dump the picker at the top. Fall back to the clicked cell's box, then the live union.
  const at = bp.pickerOpts?.at;
  const rect = at ? { left: at.x, top: at.y - 8, width: 0, height: 0 } : (resultAnchor(cid) ?? (host ? unionRect(host, byRid) : null));
  if (rect) { panel.style.left = `${Math.max(4, Math.min(rect.left, window.innerWidth - 320))}px`; panel.style.top = `${Math.max(40, Math.min(rect.top + (at ? 0 : 24), window.innerHeight - 420))}px`; }
  else { panel.style.left = '50%'; panel.style.top = '80px'; panel.style.transform = 'translateX(-50%)'; }
  const composite = host && host.kind === 'widget' && COMPOSITE_TYPES.has(host.className) ? host.className : null;
  const groups = composite ? [{ group: `${composite} children`, items: COMPOSITE_CHILDREN[composite] ?? [] }] : PALETTE;
  const head = document.createElement('div'); head.className = 'bp-pick-h';
  head.textContent = composite ? `Add to ${host?.name}` : `Add widget to ${host?.name ?? 'container'}`;
  const search = document.createElement('input'); search.className = 'bp-pick-s'; search.placeholder = 'Search…';
  const list = document.createElement('div'); list.className = 'bp-pick-list';
  const matches = (it: { key: string; name: string }, ql: string): boolean =>
    !ql || it.name.toLowerCase().includes(ql) || it.key.toLowerCase().includes(ql);
  const fill = (q: string): void => {
    list.textContent = '';
    const ql = q.trim().toLowerCase();
    // "New container" FIRST as its own distinct row (no section header): a grouping box you then add
    // widgets into. Icon + cyan so it stands apart from the widget rows. Not for composite hosts.
    if (!composite && (!ql || 'container box group'.includes(ql))) {
      const boxRow = pickRow('New container', 'empty box', () => addContainerTo(cid), ICON_LAYOUT);
      boxRow.classList.add('bp-pick-box');
      list.appendChild(boxRow);
    }
    // "Most used" quick-access section (icons), then the full palette below (redundant by design).
    if (!composite) {
      const mu = MOST_USED.filter(it => matches(it, ql));
      if (mu.length) {
        const gh = document.createElement('div'); gh.className = 'bp-pick-grp'; gh.textContent = 'Most used'; list.appendChild(gh);
        for (const it of mu) list.appendChild(pickRow(it.name, it.key, () => addFromPicker(it.key), typeIcon(it.key)));
      }
    }
    for (const grp of groups) {
      const items = grp.items.filter(it => matches(it, ql));
      if (!items.length) continue;
      const gh = document.createElement('div'); gh.className = 'bp-pick-grp'; gh.textContent = grp.group; list.appendChild(gh);
      for (const it of items) list.appendChild(pickRow(it.name, it.key, () => addFromPicker(it.key)));
    }
    if (!list.children.length) { const e = document.createElement('div'); e.className = 'bp-pick-grp'; e.textContent = 'no match'; list.appendChild(e); }
  };
  search.addEventListener('input', () => fill(search.value));
  fill('');
  panel.append(head, search, list);
  back.appendChild(panel);
  setTimeout(() => search.focus(), 0);
  return back;
}

/** Move-destination menu: every container + tab except the widget's current owner. */
function moveMenu(widgetId: string, r: Rect): HTMLElement {
  const m = model()!;
  const cur = findNode(m, widgetId);
  const curParentId = cur?.parent?.id ?? null;
  const back = document.createElement('div'); back.className = 'bp-pick-back';
  back.addEventListener('mousedown', (e) => { if (e.target === back) closeMovePicker(); });
  const panel = document.createElement('div'); panel.className = 'bp-pick bp-move';
  panel.style.left = `${Math.min(Math.max(4, r.left), window.innerWidth - 280)}px`;
  panel.style.top = `${Math.min(Math.max(40, r.top - 8), window.innerHeight - 360)}px`;
  const head = document.createElement('div'); head.className = 'bp-pick-h'; head.textContent = `Move "${cur?.node.name ?? ''}" to`;
  const list = document.createElement('div'); list.className = 'bp-pick-list';
  const dragged = cur?.node ?? null;
  for (const tab of m.tabs) {
    addDest(list, tab, tab.name, widgetId, curParentId, dragged, 0);
    const rec = (n: LNode, depth: number): void => {
      for (const c of n.children) {
        if (c.kind === 'container') { addDest(list, c, c.name, widgetId, curParentId, dragged, depth); rec(c, depth + 1); }
      }
    };
    rec(tab, 1);
  }
  if (!list.children.length) { const e = document.createElement('div'); e.className = 'bp-pick-grp'; e.textContent = 'nowhere else to move'; list.appendChild(e); }
  panel.append(head, list);
  back.appendChild(panel);
  return back;
}
function addDest(list: HTMLElement, dest: LNode, label: string, widgetId: string, curParentId: string | null, dragged: LNode | null, depth: number): void {
  if (dest.id === curParentId || dest.id === widgetId) return;
  // Never offer a destination inside the dragged node's own subtree — moving a node into its own
  // descendant would orphan that subtree. (Latent today since the menu is widget-only and lists
  // containers/tabs, but correct by construction for when containers gain a move menu.)
  if (dragged && isAncestorOf(dragged, dest.id)) return;
  const isTab = dest.kind === 'tab';
  const row = pickRow(label, isTab ? 'tab' : 'container', () => moveTo(widgetId, dest.id));
  // Hierarchy: tabs are the headers; nested containers are smaller, lighter, and indented under them.
  row.classList.add(isTab ? 'bp-mv-tab' : 'bp-mv-cont');
  if (!isTab) row.style.paddingLeft = `${10 + depth * 13}px`;
  list.appendChild(row);
}

/** A picker/move row: name + a muted kind tag. textContent only — names come from BMP (a container
 *  could be named with HTML), so never innerHTML them. */
function pickRow(label: string, tag: string, on: () => void, icon?: string | null): HTMLButtonElement {
  const b = document.createElement('button'); b.className = 'bp-pick-it';
  const left = document.createElement('span'); left.className = 'bp-pick-l';
  if (icon) { const ic = document.createElement('span'); ic.className = 'bp-pick-ic'; setIcon(ic, icon); left.appendChild(ic); }
  const nm = document.createElement('span'); nm.textContent = label; left.appendChild(nm);
  const k = document.createElement('span'); k.className = 'k'; k.textContent = tag;
  b.append(left, k);
  b.addEventListener('mousedown', (e) => { e.stopPropagation(); on(); });
  return b;
}

// ── header tab bar (manage tabs + switch which one the canvas shows) ──────────────
/** The tab strip under the chip. Each pill switches the canvas to that tab (click), renames (pencil),
 *  and deletes (✕); it's also a cross-tab move drop-target (data-bpkind=tab). Rendered from the
 *  BASELINE tabs so a staged delete stays visible (struck), with staged-new tabs appended. The pill
 *  for BMP's live (on-screen) tab carries a dot; the currently-viewed tab is highlighted. */
function tabBar(base: LModel, m: LModel, liveId: string | null, viewedId: string | null): HTMLElement {
  const bar = document.createElement('div'); bar.className = 'bp-tabs';
  const lbl = document.createElement('span'); lbl.className = 'bp-tabs-l'; lbl.textContent = 'TABS'; bar.appendChild(lbl);
  for (const bt of base.tabs) {
    const cur = findNode(m, bt.id)?.node;
    const state = !cur ? 'gone' : (cur.name !== bt.name ? 'renamed' : 'same');
    bar.appendChild(tabPill(bt.id, cur?.name ?? bt.name, state, bt.id === viewedId, bt.id === liveId));
  }
  for (const mt of m.tabs) {
    if (!base.tabs.some(b => b.id === mt.id)) bar.appendChild(tabPill(mt.id, mt.name, 'new', mt.id === viewedId, mt.id === liveId));
  }
  bar.appendChild(mkBtn('+ Tab', addTabAction)); // plain "+ Tab" text (no icon — the icon mis-aligned)
  return bar;
}

function tabPill(id: string, name: string, state: 'same' | 'renamed' | 'gone' | 'new', viewed: boolean, live: boolean): HTMLElement {
  const gone = state === 'gone';
  const pill = document.createElement('div');
  pill.className = `bp-tab st-${state}` + (viewed ? ' sel' : '') + (live ? ' live' : '');
  const shared = isResultTab({ kind: 'tab', id }); // the shared Result tab — view + edit its widgets, but
  pill.dataset.bpid = id; pill.dataset.bpkind = 'tab'; // drop target for cross-tab moves
  pill.title = gone ? 'Deleted — use Undo to restore'
    : shared ? 'The shared Result tab — its widgets are editable, but the tab itself is shared across scorecards (rename/delete disabled)'
    : 'Show this tab in the canvas';
  if (shared) pill.classList.add('shared');
  // click switches the tab — but NOT when clicking into the open rename field (that would navigate away).
  if (!gone) pill.addEventListener('mousedown', (e) => { if ((e.target as HTMLElement).isContentEditable) return; e.stopPropagation(); viewTab(id); });
  if (live) { const d = document.createElement('span'); d.className = 'bp-tlive'; d.title = 'On screen in BMP'; pill.appendChild(d); }
  if (state === 'new') { const t = document.createElement('span'); t.className = 'newtag'; t.textContent = 'NEW'; pill.appendChild(t); }
  const nm = document.createElement('span'); nm.className = 'bp-tnm'; nm.textContent = name; pill.appendChild(nm);
  if (shared) { const lk = document.createElement('span'); lk.className = 'bp-tshared'; setIcon(lk, ICON_LINK); lk.title = 'Shared across scorecards'; pill.appendChild(lk); }
  // the Result tab can't be renamed or deleted (that edits the shared default_tabset) — omit its controls.
  // preventDefault on these buttons stops the default mousedown focus-grab, which would otherwise steal
  // focus from the rename field inlineRename just opened (the "click Rename, nothing happens" bug).
  if (!gone && !shared) {
    const edit = document.createElement('button'); edit.className = 'bp-tedit'; setIcon(edit, ICON_PENCIL); edit.title = `Rename "${name}"`;
    edit.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); inlineRename(id, nm); });
    pill.appendChild(edit);
    const del = document.createElement('button'); del.className = 'bp-tdel'; setIcon(del, ICON_X); del.title = `Delete tab "${name}" and its contents`;
    del.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); doDelete(id); });
    pill.appendChild(del);
  }
  return pill;
}

// ── inline rename (view-level: edits the rendered name span in place, then commits) ──────────────
/** Open a pending inline-rename (flagged by beginRename) once the cell has been freshly rendered +
 *  selected. Called at the end of every render. The editable span is the selected result-cell `.bp-rnm`
 *  (primary canvas) or the live box `.bp-nm` (fallback). */
function openPendingRename(): void {
  if (!bp.renameId) return;
  const id = bp.renameId; bp.renameId = null;
  inlineRename(id, bp.layer?.querySelector('.bp-rcell.sel .bp-rnm, .bp-box.sel .bp-nm') as HTMLElement | null);
}
function inlineRename(id: string, nm: HTMLElement | null): void {
  if (!nm) return;
  nm.setAttribute('contenteditable', 'true');
  nm.focus();
  bp.renaming = true; // freeze re-render: a render() would textContent='' the layer and destroy this field
  const range = document.createRange(); range.selectNodeContents(nm);
  const sel = getSelection(); sel?.removeAllRanges(); sel?.addRange(range);
  let cancelled = false;
  nm.addEventListener('blur', () => {
    bp.renaming = false; nm.removeAttribute('contenteditable');
    if (cancelled) { render(); return; } // Escape — close the field without committing
    doRename(id, nm.textContent ?? '');
  }, { once: true });
  nm.addEventListener('keydown', (e) => {
    const ke = e as KeyboardEvent;
    if (ke.key === 'Enter') { e.preventDefault(); nm.blur(); }       // commit
    else if (ke.key === 'Escape') { e.preventDefault(); cancelled = true; nm.blur(); } // cancel
  });
}
