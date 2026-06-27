/**
 * Result view — the model-driven "what the page becomes after Apply" wireframe.
 *
 * The LIVE view (view.ts) anchors boxes to BMP's frozen DOM and shows edits as badges, because the
 * real grid can't reflow client-side. This view takes the opposite tack: it renders the EDITED model
 * as a real CSS-grid mirror of BMP's column model, so a move/resize/add/delete shows in its FINAL
 * position. It touches none of BMP's DOM — it's an overlay wireframe — so there's no iframe reload,
 * no chart breakage, no fight with BMP's renderer, and it works for staged adds (which have no DOM).
 *
 * Fidelity: BMP wraps children left-to-right into 6 columns by `cols.L`, containers before tab-bound
 * widgets (encoded in `orderChildren`). `grid-template-columns: repeat(6, 1fr)` + `grid-column: span
 * cols.L` reproduces exactly that wrap via the browser's own auto-placement — a too-wide item leaves
 * the trailing gap and wraps, same as BMP. The grid is anchored to the live content box (origin +
 * width measured from the active tab's widget rects) so columns line up pixel-wise with the real page.
 *
 * Spike scope: renders the ACTIVE tab (the one whose widgets are in the live DOM, so we can measure
 * the content box). Cells are selectable + draggable (they carry data-bpid/data-bpkind, so the
 * existing gesture machinery treats them as honest, final-position drop targets). Cross-tab result
 * rendering (no live anchor for inactive tabs) is a follow-up.
 */
import type { LModel, LNode } from '../lib/layout/types';
import { findNode, orderChildren, isTempId, isChart } from '../lib/layout/model';
import { ICON_PLUS } from '../lib/icons';
import type { Rect } from './geometry';
import { unionRect, setIcon } from './geometry';
import { armBox } from './gestures';
import { openPicker } from './actions';
import { bp } from './state';

/** A small "+" add button for a result container/tab cell. armBox already ignores mousedowns that
 *  land on a <button>, so this never starts a drag/select — it just opens the add picker for `id`. */
function addBtn(id: string, title: string): HTMLButtonElement {
  const b = document.createElement('button'); b.className = 'bp-radd'; setIcon(b, ICON_PLUS); b.title = title;
  b.addEventListener('mousedown', (e) => { e.stopPropagation(); openPicker(id); });
  return b;
}

export type CellState = 'same' | 'new' | 'moved' | 'changed';

/** Classify a model node against the baseline for result-view colouring. */
export function cellState(base: LModel, node: LNode, modelParentId: string | null): CellState {
  if (isTempId(node.id)) return 'new';
  const b = findNode(base, node.id);
  if (!b) return 'new';
  const baseParentId = b.parent?.id ?? null;
  if (baseParentId !== modelParentId) return 'moved';
  const bn = b.node;
  if (bn.cols.L !== node.cols.L || bn.name !== node.name || bn.height !== node.height) return 'changed';
  return 'same';
}

/** The active tab = the model tab whose baseline widgets are currently in the live DOM. */
function activeModelTab(base: LModel, m: LModel, byRid: Map<string, Element>): { tab: LNode; frame: Rect } | null {
  for (const bt of base.tabs) {
    const frame = unionRect(bt, byRid);
    if (!frame) continue;
    const mt = m.tabs.find(t => t.id === bt.id);
    if (mt) return { tab: mt, frame };
  }
  return null;
}

/** One widget/container cell. Containers recurse into a nested 6-col sub-grid. */
function cell(base: LModel, node: LNode, parentId: string | null): HTMLElement {
  const el = document.createElement('div');
  el.dataset.bpid = node.id;
  el.dataset.bpkind = node.kind === 'container' ? 'container' : 'widget';
  el.style.gridColumn = `span ${Math.max(1, Math.min(6, node.cols.L))}`;
  const state = cellState(base, node, parentId);
  el.className = `bp-rcell st-${state}` + (node.kind === 'container' ? ' bp-rcont' : '')
    + (isChart(node.className) ? ' bp-rchart' : '') + (bp.selectedId === node.id ? ' sel' : '');

  const lab = document.createElement('div'); lab.className = 'bp-rlab';
  const nm = document.createElement('span'); nm.className = 'bp-rnm'; nm.textContent = node.name;
  const ty = document.createElement('span'); ty.className = 'bp-rty'; ty.textContent = node.className.toUpperCase();
  lab.append(nm, ty);
  const wd = document.createElement('span'); wd.className = 'bp-rwd'; wd.textContent = `${node.cols.L}/6`; lab.appendChild(wd);
  if (state !== 'same') {
    const tag = document.createElement('span'); tag.className = `bp-rtag st-${state}`;
    tag.textContent = state === 'moved' ? 'MOVED' : state === 'new' ? 'NEW' : 'CHANGED';
    lab.appendChild(tag);
  }
  if (node.kind === 'container') lab.appendChild(addBtn(node.id, `Add a widget to ${node.name}`));
  el.appendChild(lab);

  if (node.kind === 'container') {
    const grid = document.createElement('div'); grid.className = 'bp-rgrid';
    for (const child of orderChildren(node.children)) grid.appendChild(cell(base, child, node.id));
    if (!node.children.length) { const e = document.createElement('div'); e.className = 'bp-rempty'; e.textContent = 'empty'; grid.appendChild(e); }
    el.appendChild(grid);
  }

  armBox(el, node.id); // select on click, drag to move — drop targets are now final positions
  return el;
}

/** One tab's section: a header (label + active marker, also a move-to-tab drop target) followed by
 *  its 6-col grid + a full-width add/drop zone. Rendered from the MODEL, so inactive tabs (no live
 *  DOM) render identically to the active one. */
function tabSection(base: LModel, tab: LNode, isActive: boolean): HTMLElement {
  const sec = document.createElement('div'); sec.className = 'bp-rtab-sec';
  const head = document.createElement('div');
  head.className = 'bp-rtab-h' + (isActive ? ' active' : '');
  head.dataset.bpid = tab.id; head.dataset.bpkind = 'avail'; // drop here = move to this tab's root
  const tk = document.createElement('span'); tk.className = 'bp-rtab-k'; tk.textContent = 'TAB';
  const tn = document.createElement('span'); tn.className = 'bp-rtab-nm'; tn.textContent = tab.name;
  head.append(tk, tn);
  if (isActive) { const b = document.createElement('span'); b.className = 'bp-rtab-badge'; b.textContent = 'ON SCREEN'; head.appendChild(b); }
  head.appendChild(addBtn(tab.id, `Add a widget to ${tab.name}`));
  sec.appendChild(head);

  const grid = document.createElement('div'); grid.className = 'bp-rgrid bp-rroot';
  for (const child of orderChildren(tab.children)) grid.appendChild(cell(base, child, tab.id));
  if (!tab.children.length) { const e = document.createElement('div'); e.className = 'bp-rempty'; e.textContent = `Tab "${tab.name}" is empty`; e.style.gridColumn = 'span 6'; grid.appendChild(e); }
  // Full-width add zone — drops a new widget at the tab's top level (also a click target for the picker).
  const add = document.createElement('div'); add.className = 'bp-radd-zone'; add.style.gridColumn = 'span 6';
  add.dataset.bpid = tab.id; add.dataset.bpkind = 'avail';
  const ai = document.createElement('span'); ai.className = 'bp-radd-ic'; setIcon(ai, ICON_PLUS);
  const at = document.createElement('span'); at.textContent = `Add to "${tab.name}"`;
  add.append(ai, at);
  add.addEventListener('mousedown', (e) => { e.stopPropagation(); openPicker(tab.id); });
  grid.appendChild(add);
  sec.appendChild(grid);
  return sec;
}

/**
 * Render the result wireframe into `layer`. Renders EVERY tab stacked (the model carries all tabs'
 * structure; only the active tab has live DOM, which we use to anchor the panel's origin + width).
 * Returns false when it can't anchor (no active tab with live widgets) so the caller falls back to
 * the live view.
 */
export function renderResult(base: LModel, m: LModel, byRid: Map<string, Element>, layer: HTMLElement): boolean {
  const active = activeModelTab(base, m, byRid);
  if (!active) return false;
  const { tab: activeTab, frame } = active;

  // Anchor to the live content box (origin + width line up with BMP's real columns) and cover at
  // least its full height, so the opaque panel masks the busy page beneath rather than floating over it.
  const wrap = document.createElement('div'); wrap.className = 'bp-result';
  Object.assign(wrap.style, { left: `${frame.left}px`, top: `${frame.top}px`, width: `${frame.width}px`, minHeight: `${frame.height}px` });

  // Active tab first (it's where the user is), then the rest — so you can move ACROSS tabs by dragging
  // between sections, not just within the one BMP happens to be showing.
  const ordered = [activeTab, ...m.tabs.filter(t => t.id !== activeTab.id)];
  for (const tab of ordered) wrap.appendChild(tabSection(base, tab, tab.id === activeTab.id));
  layer.appendChild(wrap);
  return true;
}
