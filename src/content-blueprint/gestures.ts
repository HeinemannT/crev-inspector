/**
 * Blueprint direct-manipulation gestures — pointer-driven edge-resize and drag-to-move/swap/reorder.
 *
 * Transient drag/resize state lives in module vars (not `bp`): it only drives a body-level ghost +
 * insertion line and the layer's drop-target highlight between mousedown and mouseup, and nothing
 * here needs to survive a render. Every gesture ends by staging a PURE edit op (edit.ts) through the
 * controller — the live BMP grid never reflows, so the result shows as a delta badge, same as the
 * menu-driven edits. `bp.dragging` suppresses the scroll re-render for the duration of a gesture.
 */
import { findNode } from '../lib/layout/model';
import { resolveGapPlacement } from '../lib/layout/placement';
import type { LNode } from '../lib/layout/types';
import { ICON_ARROW_RIGHT } from '../lib/icons';
import { bp, model } from './state';
import { mutate, select, setHint, doSwap, doInsert, doMoveInto, doFlowReorder, brushOnCell } from './actions';
import { resize, setHeight, insertRelative } from '../lib/layout/edit';
import { render } from './view';

const isDescendant = (node: LNode, id: string): boolean => node.children.some(c => c.id === id || isDescendant(c, id));

const clampL = (n: number): number => Math.max(1, Math.min(6, n));
const DRAG_THRESHOLD = 6;      // px of movement before a press becomes a drag rather than a click
const SWAP_ZONE = 0.26;        // centre fraction of a widget target that means "swap" (vs edge = insert)
const CONTAINER_NEST_ZONE = 0.3; // centre fraction of a container target that means "nest into" (vs edge = reorder)

// The document-level pointer listeners of the in-flight gesture, tracked so teardown (cancelGesture)
// can rip them out even if it lands mid-drag — otherwise they'd outlive the overlay session.
let activeMove: ((e: MouseEvent) => void) | null = null;
let activeUp: (() => void) | null = null;
let prevBodyUserSelect: string | null = null;
function bindGesture(mv: (e: MouseEvent) => void, up: () => void): void {
  activeMove = mv; activeUp = up;
  // Suppress native text selection for the gesture's lifetime: without this, a drag/resize sweep across
  // the BMP page selects whatever text it passes over (the mid-drag preventDefault only kicks in AFTER
  // the 6px threshold, so the press + first pixels still select). Set on <body> — covers the whole page —
  // and restore the prior inline value on release so a page-set user-select isn't clobbered. Every
  // gesture (box drag, resize handle) funnels through here, so it's the single choke point.
  prevBodyUserSelect = document.body.style.userSelect;
  document.body.style.userSelect = 'none';
  document.addEventListener('mousemove', mv); document.addEventListener('mouseup', up);
}
function unbindGesture(): void {
  if (activeMove) document.removeEventListener('mousemove', activeMove);
  if (activeUp) document.removeEventListener('mouseup', activeUp);
  activeMove = null; activeUp = null;
  if (prevBodyUserSelect !== null) { document.body.style.userSelect = prevBodyUserSelect; prevBodyUserSelect = null; }
}

/** Abort any in-flight gesture and remove its body-level artefacts. Called by disableBlueprint so a
 *  drag/resize interrupted by teardown doesn't leak document listeners or orphan ghost/line elements. */
export function cancelGesture(): void {
  unbindGesture();
  document.querySelectorAll('.bp-ghost,.bp-dropline,.bp-rzghost').forEach(el => el.remove());
  dragId = null; action = null; ghost = null; dropline = null;
  bp.dragging = false;
}

// ── edge resize ──────────────────────────────────────────────────────────────

/** Wire a resize handle (right = width, bottom = height) onto the selected box. */
export function armResize(handle: HTMLElement, id: string, dir: 'r' | 'b'): void {
  handle.addEventListener('mousedown', (e) => startResize(e, id, dir));
}

function startResize(e: MouseEvent, id: string, dir: 'r' | 'b'): void {
  e.preventDefault(); e.stopPropagation();
  const m = model(); if (!m) return;
  const f = findNode(m, id); if (!f) return;
  const node = f.node;
  const boxEl = (e.currentTarget as HTMLElement).parentElement; if (!boxEl) return;
  const rect = boxEl.getBoundingClientRect();
  const unit = rect.width / Math.max(1, node.cols.L); // px per grid column, from the node's own box
  const startX = e.clientX, startY = e.clientY;
  const startH = node.height ?? rect.height;
  let nextL = node.cols.L, nextH = node.height ?? Math.round(rect.height);
  bp.dragging = true;
  const ghost = mkGhostRect();

  const mv = (ev: MouseEvent): void => {
    if (dir === 'r') {
      nextL = clampL(Math.round((rect.width + (ev.clientX - startX)) / unit));
      sizeGhost(ghost, rect.left, rect.top, nextL * unit, rect.height, `${nextL}/6`);
    } else {
      nextH = Math.max(20, Math.round(startH + (ev.clientY - startY)));
      sizeGhost(ghost, rect.left, rect.top, rect.width, nextH, `${nextH}px`);
    }
  };
  const up = (): void => {
    unbindGesture();
    ghost.remove(); bp.dragging = false;
    if (dir === 'r' && nextL !== node.cols.L) mutate(resize(m, id, 'L', nextL));
    else if (dir === 'b' && nextH !== node.height) mutate(setHeight(m, id, nextH));
    else render();
  };
  bindGesture(mv, up);
}

function mkGhostRect(): HTMLElement {
  const g = document.createElement('div'); g.className = 'bp-rzghost';
  const lbl = document.createElement('span'); g.appendChild(lbl);
  document.body.appendChild(g);
  return g;
}
function sizeGhost(g: HTMLElement, left: number, top: number, w: number, h: number, label: string): void {
  Object.assign(g.style, { left: `${left}px`, top: `${top}px`, width: `${w}px`, height: `${h}px` });
  (g.firstChild as HTMLElement).textContent = label;
}

// ── drag to move / swap / reorder ──────────────────────────────────────────────

type DragAction =
  | { type: 'swap'; targetId: string }
  | { type: 'insert'; targetId: string; before: boolean; fitCols?: number } // fitCols: resize to fill a sized empty slot
  | { type: 'into'; targetId: string; fitCols?: number }; // fitCols: resize to fill a sized empty slot

let dragId: string | null = null;
let ghost: HTMLElement | null = null;
let dropline: HTMLElement | null = null;
let action: DragAction | null = null;

/** Wire drag-or-select onto a box: a small move starts a drag; a plain press selects. */
export function armBox(el: HTMLElement, id: string): void {
  el.addEventListener('mousedown', (e) => {
    const tgt = e.target as HTMLElement;
    if (tgt.closest('.bp-h') || tgt.isContentEditable || tgt.closest('button')) return; // handle/rename/buttons own their gesture
    e.stopPropagation();
    dragOrSelect(e, id);
  });
}

function dragOrSelect(e: MouseEvent, id: string): void {
  // Style mode edits appearance, not layout — a drag here would silently stage a move/reorder. Select only.
  if (bp.mode === 'style') {
    if (bp.brush.mode !== 'off') { brushOnCell(id); return; } // armed paintbrush: pick a source or paint a target
    select(id);
    return;
  }
  const sx = e.clientX, sy = e.clientY;
  let started = false;
  const mv = (ev: MouseEvent): void => {
    if (!started) {
      if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < DRAG_THRESHOLD) return;
      started = true; beginDrag(id);
    }
    ev.preventDefault(); // suppress native text selection over the BMP page while dragging
    if (ghost) { ghost.style.left = `${ev.clientX + 14}px`; ghost.style.top = `${ev.clientY + 14}px`; }
    markTarget(ev);
  };
  const up = (): void => {
    unbindGesture();
    if (!started) { select(id); return; }
    endDrag();
  };
  bindGesture(mv, up);
}

function beginDrag(id: string): void {
  dragId = id; action = null; bp.dragging = true;
  const m = model(); const name = m ? findNode(m, id)?.node.name ?? id : id;
  ghost = document.createElement('div'); ghost.className = 'bp-ghost';
  const nm = document.createElement('span'); nm.className = 'nm';
  const ic = document.createElement('span'); ic.className = 'bp-ic'; ic.innerHTML = ICON_ARROW_RIGHT; // trusted icon constant
  const txt = document.createElement('span'); txt.textContent = name;
  nm.append(ic, txt);
  const act = document.createElement('span'); act.className = 'act';
  ghost.append(nm, act); document.body.appendChild(ghost);
  // setHint renders (showing the hint bar), so add the source highlight to the FRESH box afterwards —
  // adding it first would be wiped by that render.
  setHint('Drop on a widget centre to SWAP · its edge to PLACE before/after (moves between boxes too) · a box, empty slot, or tab to MOVE INTO');
  bp.layer?.querySelector(`[data-bpid="${cssEsc(id)}"]`)?.classList.add('bp-dragsrc');
}

function setAct(text: string): void { const a = ghost?.querySelector('.act'); if (a) a.textContent = text; }

function clearTargets(): void {
  bp.layer?.querySelectorAll('.bp-drop,.bp-swap,.bp-tabdrop,.bp-drop-no').forEach(el => el.classList.remove('bp-drop', 'bp-swap', 'bp-tabdrop', 'bp-drop-no'));
  if (dropline) dropline.style.display = 'none';
}

function markTarget(ev: MouseEvent): void {
  clearTargets(); action = null;
  const m = model(); if (!m || !dragId) return;
  if (ghost) ghost.style.display = 'none';
  const under = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
  if (ghost) ghost.style.display = '';
  const hit = under?.closest('[data-bpid]') as HTMLElement | null;
  if (!hit) { setAct(''); return; }
  const targetId = hit.dataset.bpid!;
  const kind = hit.dataset.bpkind;
  if (targetId === dragId) { setAct(''); return; }
  const src = findNode(m, dragId);
  if (src && isDescendant(src.node, targetId)) { setAct(''); return; } // never drop a node into its own subtree

  if (kind === 'tab') {
    hit.classList.add('bp-tabdrop'); action = { type: 'into', targetId };
    setAct(`move to tab "${nameOf(m, targetId)}"`); return;
  }
  if (kind === 'avail') {
    // A trailing gap carries `bpafter` (the row's last cell) and `bpfree` (whole columns that fit).
    // resolveGapPlacement — the same band engine the renderer's rows come from — decides whether the
    // dragged node can actually RENDER in this slot: same band inserts after the anchor; a widget on
    // the LAST container's gap leads the widget band (the flow continues on that row); anything else
    // is a slot BMP can't produce — refuse it visibly instead of silently landing elsewhere.
    const after = hit.dataset.bpafter;
    const kids = findNode(m, targetId)?.node.children ?? [];
    const place = src ? resolveGapPlacement(kids, after && after !== dragId ? after : undefined, src.node.kind) : null;
    if (!place) { setAct(''); return; }
    if (!place.ok) { hit.classList.add('bp-drop-no'); setAct(`✕ ${place.reason}`); return; } // action stays null → drop is a no-op
    hit.classList.add('bp-drop');
    const free = Number(hit.dataset.bpfree) || undefined;
    const fit = free != null && src != null && src.node.cols.L > free ? free : undefined;
    action = place.mode === 'after'
      ? { type: 'insert', targetId: place.targetId, before: false, fitCols: fit }
      : { type: 'into', targetId, fitCols: fit };
    setAct(fit != null ? `place in empty slot (resize to ${fit} col)` : `place in empty slot`); return;
  }
  if (kind === 'container') {
    // A container dropped on a container: its EDGES insert it before/after at the same level (reorder —
    // "connect to the upper/lower edge"), the CENTRE (within CONTAINER_NEST_ZONE) nests it inside. A
    // widget always drops INTO.
    if (src && src.node.kind === 'container') {
      const r = hit.getBoundingClientRect();
      if (edgeness(r, ev) < CONTAINER_NEST_ZONE) {
        hit.classList.add('bp-drop'); action = { type: 'into', targetId };
        setAct(`nest inside "${nameOf(m, targetId)}"`);
      } else {
        const { side, before } = nearestEdge(r, ev);
        showLine(r, side); action = { type: 'insert', targetId, before };
        setAct(`place ${before ? 'before' : 'after'} "${nameOf(m, targetId)}"`);
      }
      return;
    }
    hit.classList.add('bp-drop'); action = { type: 'into', targetId };
    setAct(`add into "${nameOf(m, targetId)}"`); return;
  }
  // widget target: centre (within SWAP_ZONE) = swap, edge = insert before/after — but ONLY widget-on-
  // widget. A container dropped on a widget is cross-band (containers render before tab-bound widgets, so
  // a swap there just reorders containers and an insert reparents oddly); ignore it.
  if (src && src.node.kind !== 'widget') { setAct(''); return; }
  const r = hit.getBoundingClientRect();
  if (edgeness(r, ev) < SWAP_ZONE) {
    hit.classList.add('bp-swap'); action = { type: 'swap', targetId };
    setAct(`swap with "${nameOf(m, targetId)}"`);
  } else {
    const { side, before } = nearestEdge(r, ev);
    showLine(r, side); action = { type: 'insert', targetId, before };
    // When the target sits in a different parent than the dragged node, this edge-drop also REPARENTS
    // (places it there) — call that out so "place after X" doesn't read as a pure same-box reorder.
    const tParent = findNode(m, targetId)?.parent;
    const crossing = !!tParent && (src?.parent?.id ?? null) !== tParent.id;
    setAct(`place ${before ? 'before' : 'after'} "${nameOf(m, targetId)}"${crossing ? ` (into ${tParent!.name})` : ''}`);
  }
}

/** How close to centre (0 = centre, ~0.5 = edge) the pointer is within a target box — distinguishes a
 *  centre drop (swap / nest) from an edge drop (insert before/after). */
function edgeness(r: DOMRect, ev: MouseEvent): number {
  const relX = (ev.clientX - r.left) / r.width, relY = (ev.clientY - r.top) / r.height;
  return Math.max(Math.abs(relX - 0.5), Math.abs(relY - 0.5));
}

/** The edge of `r` the pointer is nearest, and whether dropping there means "insert before" the target. */
function nearestEdge(r: DOMRect, ev: MouseEvent): { side: 'left' | 'right' | 'top' | 'bottom'; before: boolean } {
  const relX = (ev.clientX - r.left) / r.width, relY = (ev.clientY - r.top) / r.height;
  const dl = relX, dr = 1 - relX, dt = relY, db = 1 - relY, min = Math.min(dl, dr, dt, db);
  const side = min === dl ? 'left' : min === dr ? 'right' : min === dt ? 'top' : 'bottom';
  return { side, before: side === 'left' || side === 'top' };
}

function showLine(r: DOMRect, side: 'left' | 'right' | 'top' | 'bottom'): void {
  if (!dropline) { dropline = document.createElement('div'); dropline.className = 'bp-dropline'; document.body.appendChild(dropline); }
  const vert = side === 'left' || side === 'right', TH = 3;
  dropline.style.display = 'block';
  if (vert) Object.assign(dropline.style, { width: `${TH}px`, height: `${r.height}px`, top: `${r.top}px`, left: `${(side === 'left' ? r.left : r.right) - TH / 2}px` });
  else Object.assign(dropline.style, { height: `${TH}px`, width: `${r.width}px`, left: `${r.left}px`, top: `${(side === 'top' ? r.top : r.bottom) - TH / 2}px` });
}

function endDrag(): void {
  bp.layer?.querySelector('.bp-dragsrc')?.classList.remove('bp-dragsrc');
  ghost?.remove(); ghost = null;
  dropline?.remove(); dropline = null;
  clearTargets(); setHint(null);
  bp.dragging = false;
  const A = action, id = dragId;
  dragId = null; action = null;
  if (A && id) {
    if (A.type === 'swap') doSwap(id, A.targetId);
    else if (A.type === 'insert') doInsert(id, A.targetId, A.before, A.fitCols);
    else doMoveInto(id, A.targetId, A.fitCols);
  } else { render(); }
}

const nameOf = (m: ReturnType<typeof model>, id: string): string => (m ? findNode(m, id)?.node.name ?? id : id);
const cssEsc = (s: string): string => CSS.escape(s);

// ── flow-row drag (reorder within ONE flow parent) ─────────────────────────────

/**
 * Arm the drag-dots handle of a flow row: a vertical drag among the SAME container's rows
 * (`[data-flowkey="<key>"]`), with an insertion line above/below the hovered row. No cross-parent
 * drags — rows of a different key are not targets (plan item 4). On drop:
 *  - flow container (`grid` false): stages `reorderFlowChild` → moveBefore/moveAfter on Apply;
 *  - grid composite (`grid` true): the row is an LNode child — `insertRelative` rides the existing
 *    layout pipeline (diff reorder → ec moveAfter).
 */
export function armFlowRow(handle: HTMLElement, row: HTMLElement, key: string, id: string, grid: boolean): void {
  handle.addEventListener('mousedown', (e) => {
    e.stopPropagation(); e.preventDefault();
    if (bp.mode === 'style') return; // style mode doesn't reorder
    startFlowDrag(e, row, key, id, grid);
  });
}

function startFlowDrag(e: MouseEvent, row: HTMLElement, key: string, id: string, grid: boolean): void {
  const sx = e.clientX, sy = e.clientY;
  let started = false;
  // drop target: the row to insert AFTER (null = front). Recomputed on every move.
  let afterId: string | null | undefined; // undefined = no legal drop yet
  const rows = (): HTMLElement[] =>
    [...(bp.layer?.querySelectorAll(`[data-flowkey="${cssEsc(key)}"]`) ?? [])] as HTMLElement[];
  const mv = (ev: MouseEvent): void => {
    if (!started) {
      if (Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < DRAG_THRESHOLD) return;
      started = true; bp.dragging = true;
      row.classList.add('bp-dragsrc');
      setHint('Drag up/down to reorder within this list');
    }
    ev.preventDefault();
    afterId = undefined;
    if (dropline) dropline.style.display = 'none';
    // nearest same-key row by vertical midpoint; above its midpoint = insert before it (after its
    // predecessor), below = insert after it.
    const list = rows().filter(r => r.dataset.flowid !== id);
    let best: { el: HTMLElement; before: boolean; dist: number } | null = null;
    for (const r of list) {
      const rect = r.getBoundingClientRect();
      const mid = rect.top + rect.height / 2;
      const dist = Math.abs(ev.clientY - mid);
      if (!best || dist < best.dist) best = { el: r, before: ev.clientY < mid, dist };
    }
    if (!best) return;
    const r = best.el.getBoundingClientRect();
    showLine(r, best.before ? 'top' : 'bottom');
    if (best.before) {
      // insert before best → after best's predecessor in the filtered list
      const i = list.indexOf(best.el);
      afterId = i > 0 ? list[i - 1].dataset.flowid ?? null : null;
    } else {
      afterId = best.el.dataset.flowid ?? null;
    }
  };
  const up = (): void => {
    unbindGesture();
    row.classList.remove('bp-dragsrc');
    dropline?.remove(); dropline = null;
    setHint(null);
    bp.dragging = false;
    if (!started || afterId === undefined) { if (started) render(); return; }
    if (grid) {
      // layout pipeline: same-parent reorder via insertRelative (before the successor / after afterId)
      const m = model(); if (!m) return;
      if (afterId === null) {
        const first = rows().find(r => r.dataset.flowid !== id)?.dataset.flowid;
        if (first) mutate(insertRelative(m, id, first, true));
      } else {
        mutate(insertRelative(m, id, afterId, false));
      }
    } else {
      doFlowReorder(key, id, afterId);
    }
  };
  bindGesture(mv, up);
}
