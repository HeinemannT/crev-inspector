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
import {
  ICON_PLUS, ICON_X, ICON_CHART, ICON_TABLE, ICON_LIST, ICON_CHECK_CIRCLE, ICON_CODE,
  ICON_LINK, ICON_PLAY, ICON_PENCIL, ICON_BOOK, ICON_LAYOUT,
} from '../lib/icons';

/** Widget-type → Phosphor glyph, so each result cell carries a scannable icon instead of only a mono
 *  type string (and the big empty chart/table cells aren't pure void). First match wins. */
const TYPE_ICONS: [RegExp, string][] = [
  [/Chart$/, ICON_CHART], [/Table$/, ICON_TABLE], [/List$/, ICON_LIST], [/Status/, ICON_CHECK_CIRCLE],
  [/CustomVisualization/, ICON_CODE], [/URLView/, ICON_LINK], [/Button/, ICON_PLAY], [/Input/, ICON_PENCIL],
  [/(Description|Text)/, ICON_BOOK], [/Container/, ICON_LAYOUT],
];
function typeIcon(className: string): string | null {
  for (const [re, ic] of TYPE_ICONS) if (re.test(className)) return ic;
  return null;
}
import type { Rect } from './geometry';
import { unionRect, setIcon } from './geometry';
import { armBox } from './gestures';
import { openPicker, doDelete, doRename, addTabAction } from './actions';
import { thumbFor } from './thumbs';
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

/** Per-type fallback heights (px) for a widget with no live DOM (an inactive tab) and no authored
 *  height. Rough but type-aware, informed by the decompiled layout model + live measurement:
 *   - charts default to a tall box (chartHeight 470 / autoSize cell-grid — live autoSize charts ~466);
 *   - TABLES/LISTS have a fixed MINIMUM (~196px): an ExtendedTable reserves table space and scrolls
 *     internally up to rowPerPage rows, so it renders at that floor whether it holds rows or is empty
 *     (verified live: full + empty tables both ~197px, all at HasHeight height=1) — it does NOT shrink
 *     to content like a text block;
 *   - status/text are short, content-driven (BMP gives them no server height).
 *  Off the active tab these are honest estimates, not ground truth. */
const TABLE_MIN = 196;
const TYPE_EST: [RegExp, number][] = [
  [/Chart$/, 300], [/(Table|List)$/, TABLE_MIN], [/(Description|Text|URLView)/, 130], [/Status/, 110],
];
function estimateHeight(className: string): number {
  for (const [re, h] of TYPE_EST) if (re.test(className)) return h;
  return 90;
}

/** Best height (px) for a widget cell so the wireframe reflects reality, in priority order:
 *   1. its LIVE rendered height (the active tab's widgets are in the DOM — ground truth, all types,
 *      incl. content-driven ones BMP gives no server height for),
 *   2. its authored chartHeight (charts with autoSize off),
 *   3. a per-type estimate (inactive tabs — no DOM to measure).
 *  Capped so one huge table can't make the panel absurd. Containers return null: they size from
 *  their children. */
const HEIGHT_CAP = 520;
function widgetHeight(node: LNode, byRid: Map<string, Element>): { px: number; measured: boolean } | null {
  if (node.kind !== 'widget') return null;
  if (node.rid) {
    const el = byRid.get(node.rid);
    if (el) { const h = el.getBoundingClientRect().height; if (h > 8) return { px: Math.min(Math.round(h), HEIGHT_CAP), measured: true }; }
  }
  if (node.height != null) return { px: Math.min(node.height, HEIGHT_CAP), measured: false };
  return { px: estimateHeight(node.className), measured: false };
}

/** A small "+" zone filling the trailing FREE columns of a row, so the empty right side of a
 *  partly-filled row (e.g. Risk Register) is a real add target. Sized to the gap so the new widget
 *  lands in it; also a move drop-target. */
function gapCell(parentId: string, free: number): HTMLElement {
  const z = document.createElement('div'); z.className = 'bp-rgap'; z.style.gridColumn = `span ${free}`;
  z.dataset.bpid = parentId; z.dataset.bpkind = 'avail';
  const ic = document.createElement('span'); ic.className = 'bp-rgap-ic'; setIcon(ic, ICON_PLUS); z.appendChild(ic);
  z.addEventListener('mousedown', (e) => { e.stopPropagation(); openPicker(parentId, { cols: free }); });
  return z;
}

/** Append a parent's children to `grid`, packed into 6-col rows, dropping a gapCell in each row's
 *  trailing free columns. Mirrors BMP's left-to-right wrap, and makes every empty slot fillable. */
function fillGrid(grid: HTMLElement, base: LModel, children: LNode[], parentId: string, byRid: Map<string, Element>): void {
  let used = 0;
  for (const c of orderChildren(children)) {
    const sp = Math.max(1, Math.min(6, c.cols.L));
    if (used + sp > 6 && used > 0) { grid.appendChild(gapCell(parentId, 6 - used)); used = 0; }
    grid.appendChild(cell(base, c, parentId, byRid));
    used += sp;
    if (used >= 6) used = 0;
  }
  if (used > 0) grid.appendChild(gapCell(parentId, 6 - used));
}

/** One widget/container cell. Containers recurse into a nested 6-col sub-grid. */
function cell(base: LModel, node: LNode, parentId: string | null, byRid: Map<string, Element>): HTMLElement {
  const el = document.createElement('div');
  el.dataset.bpid = node.id;
  el.dataset.bpkind = node.kind === 'container' ? 'container' : 'widget';
  el.style.gridColumn = `span ${Math.max(1, Math.min(6, node.cols.L))}`;
  const h = widgetHeight(node, byRid);
  if (h) el.style.height = `${h.px}px`;
  const state = cellState(base, node, parentId);
  el.className = `bp-rcell st-${state}` + (node.kind === 'container' ? ' bp-rcont' : '')
    + (isChart(node.className) ? ' bp-rchart' : '')
    + (h ? (h.measured ? ' bp-rsized' : ' bp-rest') : '') + (bp.selectedId === node.id ? ' sel' : '');

  const lab = document.createElement('div'); lab.className = 'bp-rlab';
  const icon = typeIcon(node.className);
  if (icon) { const ic = document.createElement('span'); ic.className = 'bp-ric'; setIcon(ic, icon); lab.appendChild(ic); }
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
    if (node.children.length) fillGrid(grid, base, node.children, node.id, byRid);
    else grid.appendChild(gapCell(node.id, 6)); // empty container → a full add slot
    el.appendChild(grid);
  } else {
    // A captured thumbnail of the real widget makes the cell recognisable as the page itself; if we
    // don't have one yet (off-screen, or a blank/iframe crop), fall back to the faint type watermark so
    // a tall empty box still reads as a typed placeholder. Both sit behind the label.
    const thumb = node.rid ? thumbFor(node.rid) : undefined;
    if (thumb) {
      const t = document.createElement('div'); t.className = 'bp-rthumb'; t.style.backgroundImage = `url("${thumb}")`;
      el.appendChild(t);
    } else if (icon) {
      const wm = document.createElement('span'); wm.className = 'bp-rwm'; setIcon(wm, icon);
      el.appendChild(wm);
    }
  }

  armBox(el, node.id); // select on click, drag to move — drop targets are now final positions
  return el;
}

/** Inline-rename a tab from its section header: make the name span editable, commit on blur/Enter.
 *  Self-contained (sets bp.renaming so the re-render doesn't destroy the field mid-edit). */
function editTabName(tabId: string, span: HTMLElement): void {
  span.setAttribute('contenteditable', 'true'); span.focus(); bp.renaming = true;
  const range = document.createRange(); range.selectNodeContents(span);
  const sel = getSelection(); sel?.removeAllRanges(); sel?.addRange(range);
  span.addEventListener('blur', () => { bp.renaming = false; span.removeAttribute('contenteditable'); doRename(tabId, span.textContent ?? ''); }, { once: true });
  span.addEventListener('keydown', (e) => { const k = (e as KeyboardEvent).key; if (k === 'Enter') { e.preventDefault(); span.blur(); } if (k === 'Escape') span.blur(); });
}

/** One tab's section: a header (editable name, active marker, add + delete; also a move-to-tab drop
 *  target) followed by its 6-col grid. Rendered from the MODEL, so inactive tabs render like the
 *  active one. Tab management lives here now — the standalone tab bar was removed as redundant with
 *  BMP's own tab strip. */
function tabSection(base: LModel, tab: LNode, isActive: boolean, byRid: Map<string, Element>): HTMLElement {
  const sec = document.createElement('div'); sec.className = 'bp-rtab-sec';
  const head = document.createElement('div');
  head.className = 'bp-rtab-h' + (isActive ? ' active' : '');
  head.dataset.bpid = tab.id; head.dataset.bpkind = 'avail'; // drop here = move to this tab's root
  const tk = document.createElement('span'); tk.className = 'bp-rtab-k'; tk.textContent = 'TAB';
  const tn = document.createElement('span'); tn.className = 'bp-rtab-nm'; tn.textContent = tab.name;
  tn.title = 'Click to rename';
  tn.addEventListener('mousedown', (e) => { e.stopPropagation(); editTabName(tab.id, tn); });
  head.append(tk, tn);
  if (isActive) { const b = document.createElement('span'); b.className = 'bp-rtab-badge'; b.textContent = 'ON SCREEN'; head.appendChild(b); }
  head.appendChild(addBtn(tab.id, `Add a widget to ${tab.name}`));
  const del = document.createElement('button'); del.className = 'bp-rtab-del'; setIcon(del, ICON_X);
  del.title = `Delete tab "${tab.name}" and its contents`;
  del.addEventListener('mousedown', (e) => { e.stopPropagation(); doDelete(tab.id); });
  head.appendChild(del);
  sec.appendChild(head);

  const grid = document.createElement('div'); grid.className = 'bp-rgrid bp-rroot';
  if (tab.children.length) fillGrid(grid, base, tab.children, tab.id, byRid);
  // Full-width add zone — a NEW ROW below all content (the per-row gaps cover partial rows).
  const add = document.createElement('div'); add.className = 'bp-radd-zone'; add.style.gridColumn = 'span 6';
  add.dataset.bpid = tab.id; add.dataset.bpkind = 'avail';
  const ai = document.createElement('span'); ai.className = 'bp-radd-ic'; setIcon(ai, ICON_PLUS);
  const at = document.createElement('span'); at.textContent = tab.children.length ? `Add a row to "${tab.name}"` : `Tab "${tab.name}" is empty — add a widget`;
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
  // Anchor to the active model tab's content box when there is one; otherwise (e.g. BMP's Result tab,
  // where the visible widgets are RESULT orphans not in any model tab) anchor to ALL visible widgets,
  // so the canvas still pops up. Returns false only when truly nothing is on screen.
  const active = activeModelTab(base, m, byRid);
  const frame = active?.frame ?? unionAllVisible(byRid);
  if (!frame) return false;
  const activeId = active?.tab.id ?? null;

  const wrap = document.createElement('div'); wrap.className = 'bp-result';
  Object.assign(wrap.style, { left: `${frame.left}px`, top: `${frame.top}px`, width: `${frame.width}px`, minHeight: `${frame.height}px` });

  // Active tab first (it's where the user is), then the rest — so you can move ACROSS tabs by dragging
  // between sections. With no active tab, render in model order (none marked ON SCREEN).
  const ordered = activeId ? [m.tabs.find(t => t.id === activeId)!, ...m.tabs.filter(t => t.id !== activeId)] : m.tabs;
  for (const tab of ordered) wrap.appendChild(tabSection(base, tab, tab.id === activeId, byRid));

  // "+ New tab" — tab management moved off the standalone tab bar into the canvas.
  const newTab = document.createElement('div'); newTab.className = 'bp-rnewtab';
  const ni = document.createElement('span'); ni.className = 'bp-radd-ic'; setIcon(ni, ICON_PLUS);
  const nt = document.createElement('span'); nt.textContent = 'New tab';
  newTab.append(ni, nt);
  newTab.addEventListener('mousedown', (e) => { e.stopPropagation(); addTabAction(); });
  wrap.appendChild(newTab);

  layer.appendChild(wrap);
  return true;
}

/** Bounding box of ALL currently-visible widgets (any tab/orphan) — the fallback anchor when no model
 *  tab is active. */
function unionAllVisible(byRid: Map<string, Element>): Rect | null {
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity, any = false;
  for (const el of byRid.values()) {
    const rc = el.getBoundingClientRect();
    if (rc.width < 8 || rc.height < 8 || rc.bottom <= 0 || rc.top >= innerHeight) continue;
    l = Math.min(l, rc.left); t = Math.min(t, rc.top); r = Math.max(r, rc.right); b = Math.max(b, rc.bottom); any = true;
  }
  return any ? { left: l, top: t, width: r - l, height: b - t } : null;
}
