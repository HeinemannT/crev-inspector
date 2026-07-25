/**
 * Blueprint direct-manipulation gestures — pointer-driven drag-to-move/swap/reorder.
 *
 * Transient drag/resize state lives in module vars (not `bp`): it only drives a body-level ghost +
 * insertion line and the layer's drop-target highlight between mousedown and mouseup, and nothing
 * here needs to survive a render. Every gesture ends by staging a PURE edit op (edit.ts) through the
 * controller — the live BMP grid never reflows, so the result shows as a delta badge, same as the
 * menu-driven edits. `bp.dragging` suppresses the scroll re-render for the duration of a gesture.
 */
import { findNode } from '../lib/layout/model';
import { resolveGapPlacement } from '../lib/layout/placement';
import type { LModel, LNode } from '../lib/layout/types';
import { ICON_ARROW_RIGHT } from '../lib/icons';
import { bp, model } from './state';
import { mutate, select, setHint, doSwap, doInsert, doMoveInto, doFlowReorder, brushOnCell, viewEditPage } from './actions';
import { insertRelative } from '../lib/layout/edit';
import { render } from './view';

const isDescendant = (node: LNode, id: string): boolean => node.children.some(c => c.id === id || isDescendant(c, id));

const DRAG_THRESHOLD = 6;      // px of movement before a press becomes a drag rather than a click
/** Has the pointer moved past the drag threshold from the press origin? The gate that turns a press into
 *  a drag rather than a click — shared by the box drag and the flow-row drag. */
const passedThreshold = (ev: MouseEvent, sx: number, sy: number): boolean =>
  Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) >= DRAG_THRESHOLD;
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
  // gesture (box drag, flow-row drag) funnels through here, so it's the single choke point.
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
  dragId = null; dragModel = null; action = null; ghost = null; dropline = null;
  bp.dragging = false;
}

// ── drag to move / swap / reorder ──────────────────────────────────────────────

type DragAction =
  | { type: 'swap'; targetId: string }
  | { type: 'insert'; targetId: string; before: boolean; fitCols?: number } // fitCols: resize to fill a sized empty slot
  | { type: 'into'; targetId: string; fitCols?: number }; // fitCols: resize to fill a sized empty slot

let dragId: string | null = null;
/** One immutable history snapshot per gesture. `model()` clones the full tree,
 *  so rebuilding it on every mousemove made drag cost scale with both pointer
 *  frequency and page size. */
let dragModel: LModel | null = null;
let ghost: HTMLElement | null = null;
let dropline: HTMLElement | null = null;
let action: DragAction | null = null;

/** Wire drag-or-select onto a box: a small move starts a drag; a plain press selects. */
export function armBox(el: HTMLElement, id: string): void {
  el.addEventListener('mousedown', (e) => {
    const tgt = e.target as HTMLElement;
    if (tgt.isContentEditable || tgt.closest('button')) return; // rename/buttons own their gesture
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
      if (!passedThreshold(ev, sx, sy)) return;
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
  dragModel = model();
  const name = dragModel ? findNode(dragModel, id)?.node.name ?? id : id;
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
  const m = dragModel; if (!m || !dragId) return;
  // The ghost is `pointer-events:none`, so elementFromPoint naturally reaches
  // the overlay underneath without a display toggle and forced style work.
  const under = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
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
  dragId = null; dragModel = null; action = null;
  if (A && id) {
    if (A.type === 'swap') doSwap(id, A.targetId);
    else if (A.type === 'insert') doInsert(id, A.targetId, A.before, A.fitCols);
    else doMoveInto(id, A.targetId, A.fitCols);
  } else { render(); }
}

const nameOf = (m: LModel | null, id: string): string => (m ? findNode(m, id)?.node.name ?? id : id);
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
export function armFlowRow(
  handle: HTMLElement,
  row: HTMLElement,
  key: string,
  id: string,
  grid: boolean,
  spatial = false,
): void {
  handle.addEventListener('mousedown', (e) => {
    e.stopPropagation(); e.preventDefault();
    if (bp.mode === 'style') return; // style mode doesn't reorder
    startFlowDrag(e, row, key, id, grid, spatial);
  });
}

function startFlowDrag(
  e: MouseEvent,
  row: HTMLElement,
  key: string,
  id: string,
  grid: boolean,
  spatial: boolean,
): void {
  const sx = e.clientX, sy = e.clientY;
  let started = false;
  // drop target: the row to insert AFTER (null = front). Recomputed on every move.
  let afterId: string | null | undefined; // undefined = no legal drop yet
  let pageDrop: { key: string; afterId: string | null; title: string; offset: number } | null = null;
  const allowPageDrop = spatial && row.classList.contains('bp-ep-field');
  const spatialHint = allowPageDrop ? 'Drag across columns or onto a page' : 'Move the column boundary';
  const rows = (): HTMLElement[] =>
    [...(bp.layer?.querySelectorAll(`[data-flowkey="${cssEsc(key)}"]`) ?? [])] as HTMLElement[];
  const clearPageDrops = (): void => {
    bp.layer?.querySelectorAll('.bp-ep-page-drop').forEach(element =>
      element.classList.remove('bp-ep-page-drop'),
    );
  };
  const mv = (ev: MouseEvent): void => {
    if (!started) {
      if (!passedThreshold(ev, sx, sy)) return;
      started = true; bp.dragging = true;
      row.classList.add('bp-dragsrc');
      setHint(spatial ? spatialHint : 'Drag up/down to reorder within this list');
    }
    ev.preventDefault();
    afterId = undefined;
    pageDrop = null;
    clearPageDrops();
    if (dropline) dropline.style.display = 'none';
    if (allowPageDrop) {
      const pageButtons = [...(bp.layer?.querySelectorAll<HTMLElement>('[data-flowpagekey]') ?? [])];
      const target = pageButtons.find(button => {
        const rect = button.getBoundingClientRect();
        return ev.clientX >= rect.left && ev.clientX <= rect.right
          && ev.clientY >= rect.top && ev.clientY <= rect.bottom;
      });
      if (target) {
        target.classList.add('bp-ep-page-drop');
        pageDrop = {
          key: target.dataset.flowpagekey!,
          afterId: target.dataset.flowpageafter || null,
          title: target.dataset.flowpagetitle || target.textContent?.trim() || 'page',
          offset: Number(target.dataset.flowpageoffset) || 0,
        };
        setHint(`Move to ${target.textContent?.trim() || 'page'}`);
        return;
      }
    }
    if (spatial) setHint(spatialHint);
    // Normal flows are vertical lists. EditPage columns opt into `spatial`,
    // which first locks the candidate set to the column under the pointer;
    // vertical midpoint then decides before/after inside that column.
    const list = rows().filter(r => r.dataset.flowid !== id);
    const lane = spatial
      ? list.filter(candidate => {
          const rect = candidate.getBoundingClientRect();
          return ev.clientX >= rect.left - 8 && ev.clientX <= rect.right + 8;
        })
      : [];
    const candidates = lane.length ? lane : list;
    let best: { el: HTMLElement; before: boolean; dist: number } | null = null;
    for (const r of candidates) {
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
    clearPageDrops();
    row.classList.remove('bp-dragsrc');
    dropline?.remove(); dropline = null;
    setHint(null);
    bp.dragging = false;
    if (!started) return;
    if (pageDrop) {
      // Keep BMP's real form and the overlay on the same destination page.
      // The model mutation below re-renders immediately; native React
      // navigation completes asynchronously and triggers one final measured
      // render through viewEditPage.
      viewEditPage(pageDrop.key, pageDrop.offset);
      doFlowReorder(key, id, pageDrop.afterId);
      return;
    }
    if (afterId === undefined) { render(); return; }
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
