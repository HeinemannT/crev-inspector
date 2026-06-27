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
import { findNode, walk, hasHeight, isChart, orderChildren } from '../lib/layout/model';
import { COMPOSITE_TYPES, COMPOSITE_CHILDREN } from '../lib/layout/constraints';
import { isAncestorOf } from '../lib/layout/edit';
import { diff } from '../lib/layout/diff';
import { ICON_PLUS, ICON_X, ICON_MINUS, ICON_PENCIL, ICON_TRASH, ICON_ARROW_RIGHT, ICON_REFRESH } from '../lib/icons';
import { bp, model, PALETTE } from './state';
import { type Rect, ridElementMap, unionRect, anchorRect, setIcon, mkIconBtn, delta } from './geometry';
import {
  select, setWidth, setH, doDelete, doRename, openPicker, addFromPicker, closePicker, addContainerTo,
  openMovePicker, closeMovePicker, moveTo, addTabAction,
} from './actions';
import { armBox, armResize } from './gestures';
import { renderChip, previewModal, trayPanel, hintBar, createTabsetModal } from './view-panels';
import { renderResult } from './result';

export function render(): void {
  const layer = bp.layer;
  if (!layer) return;
  // No-tabset page: show the create-tabset prompt (there's no model to edit until one exists).
  if (bp.needsTabset) {
    layer.textContent = '';
    layer.appendChild(createTabsetModal(bp.needsTabset));
    return;
  }
  const base = bp.baseline, m = model(), ctx = bp.ctx;
  if (!base || !m || !ctx) return;
  layer.textContent = '';
  const byRid = ridElementMap();
  const pending = diff(base, m).length;
  // chip + tab strip are one card (single border/width), not two stacked pills of different sizes
  const header = document.createElement('div');
  header.className = 'bp-header' + (ctx.target === 'template' ? ' tmpl' : '');
  header.append(renderChip(ctx, pending), tabBar(base, m));
  layer.appendChild(header);

  // RESULT view: render the edited model as a CSS-grid wireframe (final positions) instead of badges
  // over the frozen grid. Falls back to the live view if it can't anchor (no active tab in the DOM).
  // The selection toolbar + pickers + tray + preview modal still apply (rendered at the foot below).
  if (bp.resultView && renderResult(base, m, byRid, layer)) {
    renderFloatingChrome(byRid, m);
    return;
  }

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
    stackY.set(parent.id, offset + 42);
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

  renderFloatingChrome(byRid, m);
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
      const anchor = anchorRect(selBox.node, byRid) ?? resultAnchor(selBox.node.id);
      if (anchor) layer.appendChild(toolbar(selBox.node, anchor));
    }
  }

  if (bp.movePicker) {
    const f = findNode(m, bp.movePicker);
    const anchor = (f ? anchorRect(f.node, byRid) : null) ?? resultAnchor(bp.movePicker);
    layer.appendChild(moveMenu(bp.movePicker, anchor ?? { left: 80, top: 80, width: 0, height: 0 }));
  }
  if (bp.picker) layer.appendChild(pickerPanel(byRid));
  if (bp.trayOpen) layer.appendChild(trayPanel(base, m));
  if (bp.hint) layer.appendChild(hintBar(bp.hint));
  if (bp.preview) layer.appendChild(previewModal(bp.preview, ctx));
}

/** Anchor a floating panel to a node's result-view cell (the result wireframe has no live DOM rect,
 *  so anchorRect returns null there). Reads the rendered cell's on-screen box. */
function resultAnchor(id: string): Rect | null {
  if (!bp.resultView || !bp.layer) return null;
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
  const c = cur.node;
  if (c.cols.L !== baseNode.cols.L || c.name !== baseNode.name || c.height !== baseNode.height) return 'changed';
  return 'same';
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
  Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
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
  Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
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
  Object.assign(z.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  z.title = `Add a widget to ${parentName}`;
  const ic = document.createElement('span'); ic.className = 'ic'; setIcon(ic, ICON_PLUS);
  const tx = document.createElement('span'); tx.textContent = 'Add widget';
  z.append(ic, tx);
  z.addEventListener('mousedown', (e) => { e.stopPropagation(); openPicker(parentId, opts); });
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
  Object.assign(box.style, { left: `${rect.left - 3}px`, top: `${rect.top - 3}px`, width: `${rect.width + 6}px`, height: `${rect.height + 6}px` });
  armBox(box, baseNode.id);
  // A handle ABOVE the container's top-left, always visible: it marks where each container is (so they
  // read clearly) and hosts the add "+". It sits above the row, so it never collides with the top-left
  // widget label inside. On selection it expands with the name + width (+ handles on the box).
  const tab = document.createElement('div'); tab.className = 'bp-ctab' + (sel ? ' sel' : '');
  const add = document.createElement('button');
  add.className = 'bp-cadd'; setIcon(add, ICON_PLUS); add.title = `Add a widget to ${baseNode.name}`;
  add.addEventListener('mousedown', (e) => { e.stopPropagation(); openPicker(baseNode.id); });
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
  const lift = node.kind === 'container' ? 60 : 32;
  t.style.left = `${Math.max(4, r.left)}px`;
  t.style.top = `${Math.max(40, r.top - lift)}px`;

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
    t.append(mkIconBtn(ICON_MINUS, () => setH(node.id, (node.height ?? 200) - 40)), mkIconBtn(ICON_PLUS, () => setH(node.id, (node.height ?? 200) + 40)));
  }
  if (node.kind === 'widget' && COMPOSITE_TYPES.has(node.className)) t.appendChild(mkIconBtn(ICON_PLUS, () => openPicker(node.id), 'Child'));
  if (node.kind === 'widget') t.appendChild(mkIconBtn(ICON_ARROW_RIGHT, () => openMovePicker(node.id), 'Move'));
  t.appendChild(mkIconBtn(ICON_PENCIL, () => startRename(node.id), 'Rename'));
  const del = mkIconBtn(ICON_TRASH, () => doDelete(node.id), 'Delete'); del.classList.add('del');
  t.appendChild(del);
  return t;
}

/** The add picker — searchable. A composite target offers only its valid children; else the palette. */
function pickerPanel(byRid: Map<string, Element>): HTMLElement {
  const cid = bp.picker!;
  const host = bp.baseline ? findNode(bp.baseline, cid)?.node : null;
  const rect = host ? unionRect(host, byRid) : null;
  const back = document.createElement('div'); back.className = 'bp-pick-back';
  back.addEventListener('mousedown', (e) => { if (e.target === back) closePicker(); });
  const panel = document.createElement('div'); panel.className = 'bp-pick';
  if (rect) { panel.style.left = `${Math.min(rect.left, window.innerWidth - 320)}px`; panel.style.top = `${Math.min(rect.top + 24, window.innerHeight - 420)}px`; }
  else { panel.style.left = '50%'; panel.style.top = '80px'; panel.style.transform = 'translateX(-50%)'; }
  const composite = host && host.kind === 'widget' && COMPOSITE_TYPES.has(host.className) ? host.className : null;
  const groups = composite ? [{ group: `${composite} children`, items: COMPOSITE_CHILDREN[composite] ?? [] }] : PALETTE;
  const head = document.createElement('div'); head.className = 'bp-pick-h';
  head.textContent = composite ? `Add to ${host?.name}` : `Add widget to ${host?.name ?? 'container'}`;
  const search = document.createElement('input'); search.className = 'bp-pick-s'; search.placeholder = 'Search…';
  const list = document.createElement('div'); list.className = 'bp-pick-list';
  const fill = (q: string): void => {
    list.textContent = '';
    const ql = q.trim().toLowerCase();
    for (const grp of groups) {
      const items = grp.items.filter(it => !ql || it.name.toLowerCase().includes(ql) || it.key.toLowerCase().includes(ql));
      if (!items.length) continue;
      const gh = document.createElement('div'); gh.className = 'bp-pick-grp'; gh.textContent = grp.group; list.appendChild(gh);
      for (const it of items) list.appendChild(pickRow(it.name, it.key, () => addFromPicker(it.key)));
    }
    if (!list.children.length) { const e = document.createElement('div'); e.className = 'bp-pick-grp'; e.textContent = 'no match'; list.appendChild(e); }
    // structural option: a new empty container (not for composite hosts, which only take fixed children)
    if (!composite && !ql) {
      const boxRow = pickRow('New container (empty box)', 'box', () => addContainerTo(cid));
      boxRow.classList.add('bp-pick-box');
      list.appendChild(boxRow);
    }
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
    addDest(list, tab, tab.name, widgetId, curParentId, dragged);
    const rec = (n: LNode, path: string): void => {
      for (const c of n.children) {
        if (c.kind === 'container') { addDest(list, c, `${path} / ${c.name}`, widgetId, curParentId, dragged); rec(c, `${path} / ${c.name}`); }
      }
    };
    rec(tab, tab.name);
  }
  if (!list.children.length) { const e = document.createElement('div'); e.className = 'bp-pick-grp'; e.textContent = 'nowhere else to move'; list.appendChild(e); }
  panel.append(head, list);
  back.appendChild(panel);
  return back;
}
function addDest(list: HTMLElement, dest: LNode, label: string, widgetId: string, curParentId: string | null, dragged: LNode | null): void {
  if (dest.id === curParentId || dest.id === widgetId) return;
  // Never offer a destination inside the dragged node's own subtree — moving a node into its own
  // descendant would orphan that subtree. (Latent today since the menu is widget-only and lists
  // containers/tabs, but correct by construction for when containers gain a move menu.)
  if (dragged && isAncestorOf(dragged, dest.id)) return;
  list.appendChild(pickRow(label, dest.kind === 'tab' ? 'tab' : 'container', () => moveTo(widgetId, dest.id)));
}

/** A picker/move row: name + a muted kind tag. textContent only — names come from BMP (a container
 *  could be named with HTML), so never innerHTML them. */
function pickRow(label: string, tag: string, on: () => void): HTMLButtonElement {
  const b = document.createElement('button'); b.className = 'bp-pick-it';
  const nm = document.createElement('span'); nm.textContent = label;
  const k = document.createElement('span'); k.className = 'k'; k.textContent = tag;
  b.append(nm, k);
  b.addEventListener('mousedown', (e) => { e.stopPropagation(); on(); });
  return b;
}

/** Tab manager — a strip under the chip listing every tab (rename inline, delete, add widget) + "+ Tab".
 *  Rendered from the BASELINE tabs so deletions stay visible (struck), with staged new tabs appended. */
function tabBar(base: LModel, m: LModel): HTMLElement {
  const bar = document.createElement('div'); bar.className = 'bp-tabs';
  const lbl = document.createElement('span'); lbl.className = 'bp-tabs-l'; lbl.textContent = 'TABS'; bar.appendChild(lbl);
  for (const bt of base.tabs) {
    const cur = findNode(m, bt.id)?.node;
    bar.appendChild(tabPill(bt.id, cur?.name ?? bt.name, !cur ? 'gone' : (cur.name !== bt.name ? 'renamed' : 'same')));
  }
  for (const mt of m.tabs) {
    if (!base.tabs.some(b => b.id === mt.id)) bar.appendChild(tabPill(mt.id, mt.name, 'new'));
  }
  bar.appendChild(mkIconBtn(ICON_PLUS, addTabAction, 'Tab'));
  return bar;
}

function tabPill(id: string, name: string, state: 'same' | 'renamed' | 'gone' | 'new'): HTMLElement {
  const pill = document.createElement('div'); pill.className = `bp-tab st-${state}` + (bp.selectedId === id ? ' sel' : '');
  pill.dataset.bpid = id; pill.dataset.bpkind = 'tab'; // drop target for cross-tab moves
  pill.addEventListener('mousedown', (e) => { e.stopPropagation(); select(id); });
  if (state === 'new') { const t = document.createElement('span'); t.className = 'newtag'; t.textContent = 'NEW'; pill.appendChild(t); }
  const nm = document.createElement('span'); nm.className = 'bp-tnm'; nm.textContent = name;
  nm.addEventListener('mousedown', (e) => { if (state !== 'gone') { e.stopPropagation(); startTabRename(id, nm); } });
  pill.appendChild(nm);
  if (state !== 'gone') {
    const add = document.createElement('button'); add.className = 'bp-tadd'; setIcon(add, ICON_PLUS); add.title = `Add a widget to ${name}`;
    add.addEventListener('mousedown', (e) => { e.stopPropagation(); openPicker(id); });
    pill.appendChild(add);
  }
  const del = document.createElement('button'); del.className = 'bp-tdel';
  setIcon(del, state === 'gone' ? ICON_REFRESH : ICON_X);
  del.title = state === 'gone' ? 'Undo delete (use Undo)' : `Delete tab "${name}" and its contents`;
  if (state !== 'gone') del.addEventListener('mousedown', (e) => { e.stopPropagation(); doDelete(id); });
  pill.appendChild(del);
  return pill;
}

// ── inline rename (view-level: edits the rendered name span in place, then commits) ──────────────
function startRename(id: string): void {
  render();
  inlineRename(id, bp.layer?.querySelector('.bp-box.sel .bp-nm') as HTMLElement | null);
}
function startTabRename(id: string, nm: HTMLElement): void { inlineRename(id, nm); }
function inlineRename(id: string, nm: HTMLElement | null): void {
  if (!nm) return;
  nm.setAttribute('contenteditable', 'true');
  nm.focus();
  bp.renaming = true; // freeze re-render: a render() would textContent='' the layer and destroy this field
  const range = document.createRange(); range.selectNodeContents(nm);
  const sel = getSelection(); sel?.removeAllRanges(); sel?.addRange(range);
  nm.addEventListener('blur', () => { bp.renaming = false; nm.removeAttribute('contenteditable'); doRename(id, nm.textContent ?? ''); }, { once: true });
  nm.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') { e.preventDefault(); nm.blur(); }
    if ((e as KeyboardEvent).key === 'Escape') { nm.textContent = findNode(model()!, id)?.node.name ?? ''; nm.blur(); }
  });
}
