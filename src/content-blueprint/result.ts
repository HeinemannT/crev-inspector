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
 * width measured from the page's widget rects) so columns line up pixel-wise with the real page.
 *
 * Tab selection: the caller (view.render) resolves ONE `viewedId` and passes it in; this view renders
 * that tab. It anchors to that tab's own live widgets when they're on screen (peeking an off-screen tab
 * falls back to all visible widgets). Cells are selectable + draggable (they carry data-bpid/data-bpkind,
 * so the gesture machinery treats them as honest, final-position drop targets).
 */
import { STYLE_NODE_FIELDS, type LModel, type LNode, type NodeStyle } from '../lib/layout/types';
import { findNode, orderChildren, isTempId, isChart, walk, fieldsChanged } from '../lib/layout/model';
import { COMPOSITE_TYPES } from '../lib/layout/constraints';
import {
  ICON_PLUS, ICON_CHART, ICON_TABLE, ICON_LIST, ICON_CHECK_CIRCLE, ICON_CODE,
  ICON_LINK, ICON_PLAY, ICON_PENCIL, ICON_BOOK, ICON_LAYOUT, ICON_REVERT,
} from '../lib/icons';
import { type Rect, unionRect, setIcon, docX, docY, widgetRects } from './geometry';
import { armBox } from './gestures';
import { openPicker, toggleResetProp } from './actions';
import { bp } from './state';
import { colorRgb } from './colors';
import { contrastInk } from '../lib/color-util';

/** Widget-type → Phosphor glyph, so each result cell carries a scannable icon instead of only a mono
 *  type string (and the big empty chart/table cells aren't pure void). First match wins. */
const TYPE_ICONS: [RegExp, string][] = [
  [/Chart$/, ICON_CHART], [/Table$/, ICON_TABLE], [/List$/, ICON_LIST], [/Status/, ICON_CHECK_CIRCLE],
  [/CustomVisualization/, ICON_CODE], [/URLView/, ICON_LINK], [/Button/, ICON_PLAY],
  [/(Input|Create|ObjectView)/, ICON_PENCIL], [/(Description|Text)/, ICON_BOOK], [/Container/, ICON_LAYOUT],
];
/** A composite widget (ButtonContainer/ButtonGroup/InputSet/…) that holds nested children. We render
 *  these READ-ONLY — show the children inside the box so a ButtonContainer's buttons are visible — but
 *  with no add slot and no drag arming, since editing INTO a composite needs `<composite>.add(child)`
 *  EC the compiler doesn't emit yet. */
const isCompositeWithKids = (n: LNode): boolean => COMPOSITE_TYPES.has(n.className) && n.children.length > 0;

export function typeIcon(className: string): string | null {
  for (const [re, ic] of TYPE_ICONS) if (re.test(className)) return ic;
  return null;
}

/** A small "+" add button for a result container/tab cell. armBox already ignores mousedowns that
 *  land on a <button>, so this never starts a drag/select — it just opens the add picker for `id`. */
function addBtn(id: string, title: string): HTMLButtonElement {
  const b = document.createElement('button'); b.className = 'bp-radd'; setIcon(b, ICON_PLUS); b.title = title;
  b.addEventListener('mousedown', (e) => { e.stopPropagation(); openPicker(id, { at: { x: e.clientX, y: e.clientY } }); });
  return b;
}

export type CellState = 'same' | 'new' | 'moved' | 'changed';

/** Classify a model node against the baseline for result-view colouring. A field change (width/name/
 *  height) outranks a pure move, so a moved-AND-edited widget reads as 'changed' (yellow) while a
 *  move with no other edit reads as 'moved' (lighter yellow) — matching the at-a-glance colour code.
 *  `reordered` carries the ids whose order changed within an unchanged parent (a swap/drag-reorder),
 *  which look 'same' field-wise but should still read as 'moved'. */
const NO_REORDER: ReadonlySet<string> = new Set();
export function cellState(base: LModel, node: LNode, modelParentId: string | null, reordered: ReadonlySet<string> = NO_REORDER): CellState {
  if (isTempId(node.id)) return 'new';
  const b = findNode(base, node.id);
  if (!b) return 'new';
  if (fieldsChanged(b.node, node)) return 'changed';
  if ((b.parent?.id ?? null) !== modelParentId) return 'moved';
  if (reordered.has(node.id)) return 'moved';
  return 'same';
}

/** Ids reordered WITHIN an unchanged parent group — a swap or drag-reorder where parent, width, name
 *  and height are all unchanged, so cellState would otherwise read 'same'. A cell is flagged when its
 *  preceding same-kind, baseline-surviving sibling differs from baseline; that's symmetric (both halves
 *  of a swap light up) and limited to genuine reorders. Only groups whose membership is IDENTICAL to
 *  baseline are considered, so an insert / cross-container move (already coloured 'new' / parent-'moved')
 *  doesn't light up the neighbours its index-shift dragged along. */
function reorderedIds(base: LModel, m: LModel): Set<string> {
  const out = new Set<string>();
  const consider = (parentId: string, kids: LNode[]): void => {
    const bf = findNode(base, parentId);
    const baseKids = bf ? bf.node.children : base.tabs.find(t => t.id === parentId)?.children;
    if (!baseKids) return; // parent absent from baseline (a new container) — nothing to compare against
    for (const kind of ['container', 'widget'] as const) {
      const cur = orderChildren(kids).filter(c => c.kind === kind).map(c => c.id);
      const bas = orderChildren(baseKids).filter(c => c.kind === kind).map(c => c.id);
      // membership-unchanged guard: same id set, no staged adds
      if (cur.length !== bas.length || cur.some(id => isTempId(id) || !bas.includes(id))) continue;
      const basePred = new Map<string, string | null>();
      bas.forEach((id, i) => basePred.set(id, i > 0 ? bas[i - 1] : null));
      cur.forEach((id, i) => { if ((i > 0 ? cur[i - 1] : null) !== basePred.get(id)) out.add(id); });
    }
  };
  m.tabs.forEach(t => consider(t.id, t.children));
  walk(m, n => { if (n.kind === 'container') consider(n.id, n.children); });
  return out;
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
 *   1. its AUTHORED height (chartHeight, or a staged height edit) — the explicit pixel height BMP will
 *      render, so a height change PREVIEWS immediately instead of being masked by the un-applied live size,
 *   2. its LIVE rendered height (active-tab widgets are in the DOM — ground truth for content-driven
 *      widgets BMP gives no server height for, which carry no authored height),
 *   3. a per-type estimate (inactive tabs — no DOM to measure).
 *  Capped so one huge table can't make the panel absurd. Containers return null: they size from
 *  their children. (`measured` only drives the faint dashed "estimated" edge — authored + live are both
 *  exact, so both clear it.) */
const HEIGHT_CAP = 520;
const SHORT_CELL_HEIGHT = 104; // below this a cell can't fit label + centred watermark + caption → hide the watermark
function widgetHeight(node: LNode, byRid: Map<string, Element>): { px: number; measured: boolean } | null {
  if (node.kind !== 'widget') return null;
  if (node.height != null) return { px: Math.min(node.height, HEIGHT_CAP), measured: true };
  if (node.rid) {
    const el = byRid.get(node.rid);
    if (el) { const h = el.getBoundingClientRect().height; if (h > 8) return { px: Math.min(Math.round(h), HEIGHT_CAP), measured: true }; }
  }
  return { px: estimateHeight(node.className), measured: false };
}

/** A small "+" zone filling the trailing FREE columns of a row, so the empty right side of a
 *  partly-filled row (e.g. Risk Register) is a real add target. Sized to the gap so the new widget
 *  lands in it; also a move drop-target. */
function gapCell(parentId: string, free: number, afterId?: string): HTMLElement {
  const z = document.createElement('div'); z.className = 'bp-rgap'; z.style.gridColumn = `span ${free}`;
  z.dataset.bpid = parentId; z.dataset.bpkind = 'avail'; z.dataset.bpfree = String(free); // a widget dropped here resizes to fit the slot
  // The gap's ordinal anchor: the row's last real cell. A DROP here inserts right after it (same as the
  // click/add path), not appended at the parent's end — so a widget dropped in a trailing slot keeps the
  // row's reading order instead of landing far below. Absent on a full-width empty-container gap → append.
  if (afterId) z.dataset.bpafter = afterId;
  const ic = document.createElement('span'); ic.className = 'bp-rgap-ic'; setIcon(ic, ICON_PLUS); z.appendChild(ic);
  // Insert the new widget AT the clicked gap (right after the row's last cell), not appended at the end
  // of the parent — otherwise adding to an empty right-side slot drops the widget far below, off-screen.
  z.addEventListener('mousedown', (e) => { e.stopPropagation(); openPicker(parentId, { cols: free, at: { x: e.clientX, y: e.clientY }, ...(afterId ? { afterId } : {}) }); });
  return z;
}

/** Append a parent's children to `grid`, packed into 6-col rows, dropping a gapCell in each row's
 *  trailing free columns. Mirrors BMP's left-to-right wrap, and makes every empty slot fillable. */
function fillGrid(grid: HTMLElement, base: LModel, children: LNode[], parentId: string, byRid: Map<string, Element>, reordered: ReadonlySet<string>): void {
  let used = 0;
  let lastId: string | undefined; // the cell a trailing gap sits right after — its add inserts there
  for (const c of orderChildren(children)) {
    const sp = Math.max(1, Math.min(6, c.cols.L));
    if (used + sp > 6 && used > 0) { grid.appendChild(gapCell(parentId, 6 - used, lastId)); used = 0; }
    grid.appendChild(cell(base, c, parentId, byRid, reordered));
    lastId = c.id;
    used += sp;
    if (used >= 6) used = 0;
  }
  if (used > 0) grid.appendChild(gapCell(parentId, 6 - used, lastId));
}

/** F2: the blue revert arrow shown next to an overridden property in instance view — it IS the
 *  indicator (this prop overrides the template) AND the control (click to stage/unstage a reset to the
 *  template). `label` is the human word for the title (width/name/height); `prop` is the BMP name. */
function revertArrow(node: LNode, prop: string, label: string): HTMLElement {
  const b = document.createElement('button');
  const staged = (node.resets ?? []).includes(prop);
  b.className = 'bp-revert' + (staged ? ' staged' : '');
  setIcon(b, ICON_REVERT);
  b.title = staged
    ? `${label}: reset staged — reverts to the template on Apply (click to cancel)`
    : `${label} overrides the template — click to reset it to the template value`;
  // mousedown + stopPropagation so it doesn't start a cell select/drag (overlay convention).
  b.addEventListener('mousedown', (e) => { e.stopPropagation(); e.preventDefault(); toggleResetProp(node.id, prop); });
  return b;
}

/** The cell's header row: type glyph, name (+ name revert arrow), type badge, width (+ width/height
 *  revert arrows), the change-state tag, and — for a container — its "+ add" button. The F2 revert
 *  arrows render only for props in node.overrides (instance view; empty in template view / local widgets). */
function buildLabel(node: LNode, state: CellState): HTMLElement {
  const lab = document.createElement('div'); lab.className = 'bp-rlab';
  const icon = typeIcon(node.className);
  if (icon) { const ic = document.createElement('span'); ic.className = 'bp-ric'; setIcon(ic, icon); lab.appendChild(ic); }
  const over = node.overrides ?? [];
  const nm = document.createElement('span'); nm.className = 'bp-rnm'; nm.textContent = node.name; lab.appendChild(nm);
  if (over.includes('name')) lab.appendChild(revertArrow(node, 'name', 'name'));
  const ty = document.createElement('span'); ty.className = 'bp-rty'; ty.textContent = node.className.toUpperCase(); lab.appendChild(ty);
  const wd = document.createElement('span'); wd.className = 'bp-rwd'; wd.textContent = node.cols.L >= 6 ? 'full' : `${node.cols.L} col`; lab.appendChild(wd);
  if (over.includes('columnsLargeScreen')) lab.appendChild(revertArrow(node, 'columnsLargeScreen', 'width'));
  if (over.includes('chartHeight')) lab.appendChild(revertArrow(node, 'chartHeight', 'height'));
  if (state !== 'same') {
    const tag = document.createElement('span'); tag.className = `bp-rtag st-${state}`;
    tag.textContent = state === 'moved' ? 'MOVED' : state === 'new' ? 'NEW' : 'CHANGED';
    lab.appendChild(tag);
  }
  if (node.kind === 'container') lab.appendChild(addBtn(node.id, `Add a widget to ${node.name}`));
  return lab;
}

/** G3 style mode: paint a cell with the widget's ACTUAL appearance — header tint (headerColor) with
 *  contrast ink, font colour, shadow, border, header-drop, transparency. A schematic approximation of
 *  the real widget, enough to read the styling at a glance. Layout mode never calls this. */
function applyStyle(el: HTMLElement, label: HTMLElement, s: NodeStyle): void {
  el.classList.add('bp-styled');
  const hc = colorRgb(s.headerColorBid);
  if (hc) {
    label.classList.add('bp-styled-hdr');
    label.style.background = hc;
    label.style.color = contrastInk(hc);
  }
  const fc = colorRgb(s.fontColorBid);
  if (fc) {
    const nm = label.querySelector<HTMLElement>('.bp-rnm');
    if (nm) nm.style.color = fc;
  }
  if (s.shadow) el.classList.add('bp-sh-on');
  if (s.borderStyle === 'LINE') el.classList.add('bp-bd-line');
  else if (s.borderStyle === 'NONE') el.classList.add('bp-bd-none');
  if (s.headerStyle === 'NONE') el.classList.add('bp-hdr-none');
  if (typeof s.transparency === 'number' && s.transparency > 0) {
    el.style.opacity = String(Math.max(0.15, 1 - s.transparency / 100));
  }
}

/** Does this node's appearance differ from the baseline? (Any STYLE_NODE_FIELDS field, absence folded to
 *  its default — same rule as diff.changedStyle.) Drives the style-mode "edited" ring. A staged-add node
 *  has no baseline counterpart and already reads as 'new', so it's not flagged here. */
function styleDirty(base: LModel, node: LNode): boolean {
  const b = findNode(base, node.id)?.node;
  if (!b) return false;
  return STYLE_NODE_FIELDS.some(f => (b.style?.[f.key] ?? f.def) !== (node.style?.[f.key] ?? f.def));
}

/** One widget/container cell. Containers recurse into a nested 6-col sub-grid. */
function cell(base: LModel, node: LNode, parentId: string | null, byRid: Map<string, Element>, reordered: ReadonlySet<string>): HTMLElement {
  const el = document.createElement('div');
  el.dataset.bpid = node.id;
  el.dataset.bpkind = node.kind === 'container' ? 'container' : 'widget';
  el.style.gridColumn = `span ${Math.max(1, Math.min(6, node.cols.L))}`;
  const composite = isCompositeWithKids(node);
  const h = widgetHeight(node, byRid);
  if (h && !composite) el.style.height = `${h.px}px`; // composites size to their children, not an estimate
  const state = cellState(base, node, parentId, reordered);
  // Too short to fit the label + the centred type watermark + the caption without overlap → drop the
  // watermark (CSS hides .bp-rwm on .bp-rshort). Short content widgets (TextElement, InputView) hit this.
  const short = node.kind === 'widget' && !composite && !!h && h.px < SHORT_CELL_HEIGHT;
  el.className = `bp-rcell st-${state}` + (node.kind === 'container' ? ' bp-rcont' : '') + (composite ? ' bp-rcomp-host' : '')
    + (isChart(node.className) ? ' bp-rchart' : '') + (short ? ' bp-rshort' : '')
    + (h && !composite ? (h.measured ? ' bp-rsized' : ' bp-rest') : '') + (bp.selectedId === node.id ? ' sel' : '');

  const icon = typeIcon(node.className);
  const labelEl = buildLabel(node, state);
  el.appendChild(labelEl);
  if (bp.mode === 'style') {
    if (node.style) applyStyle(el, labelEl, node.style);
    if (styleDirty(base, node)) el.classList.add('bp-style-dirty'); // staged appearance edit → ring it
  }

  if (node.kind === 'container') {
    const grid = document.createElement('div'); grid.className = 'bp-rgrid';
    if (node.children.length) fillGrid(grid, base, node.children, node.id, byRid, reordered);
    else grid.appendChild(gapCell(node.id, 6)); // empty container → a full add slot
    el.appendChild(grid);
  } else if (composite) {
    // Composite (ButtonContainer/ButtonGroup/InputSet/…): show its nested children read-only so a
    // ButtonContainer's buttons are visible inside the box, at their container-relative width.
    const grid = document.createElement('div'); grid.className = 'bp-rgrid bp-rcomp';
    for (const c of orderChildren(node.children)) grid.appendChild(compositeChildCell(c));
    el.appendChild(grid);
  } else {
    // Pure line-art: a faint type glyph fills the cell body with a small mono type caption beneath, so a
    // tall empty box reads as a typed placeholder (the dominant name + this glyph carry recognisability —
    // no photographic thumbnail, which fought the blueprint aesthetic).
    if (icon) {
      const wm = document.createElement('span'); wm.className = 'bp-rwm'; setIcon(wm, icon);
      el.appendChild(wm);
    }
    const cap = document.createElement('span'); cap.className = 'bp-rwm-ty'; cap.textContent = node.className.toUpperCase();
    el.appendChild(cap);
  }

  // Composites are not drop targets (their children bind via `.add`, not `container :=`), but the
  // composite box itself is still selectable/draggable as a unit.
  armBox(el, node.id); // select on click, drag to move — drop targets are now final positions
  return el;
}

/** A read-only cell for a child nested inside a composite (e.g. a button in a ButtonContainer). Not
 *  armed for selection/drag — composite-child editing isn't supported yet — so it's purely visual. */
function compositeChildCell(node: LNode): HTMLElement {
  const el = document.createElement('div');
  el.className = 'bp-rcell bp-rcomp-child st-same';
  el.dataset.bpid = node.id;
  el.dataset.bpkind = 'widget';
  el.style.gridColumn = `span ${Math.max(1, Math.min(6, node.cols.L))}`;
  const lab = document.createElement('div'); lab.className = 'bp-rlab';
  const icon = typeIcon(node.className);
  if (icon) { const ic = document.createElement('span'); ic.className = 'bp-ric'; setIcon(ic, icon); lab.appendChild(ic); }
  const nm = document.createElement('span'); nm.className = 'bp-rnm'; nm.textContent = node.name;
  const ty = document.createElement('span'); ty.className = 'bp-rty'; ty.textContent = node.className.toUpperCase();
  lab.append(nm, ty);
  el.appendChild(lab);
  return el;
}

/**
 * Render the result wireframe into `layer` — ONE tab at a time (the header tab bar switches/manages
 * tabs; the canvas just lays out the chosen tab's grid). Anchored to the live content box for column
 * alignment. Returns false when it can't anchor (nothing on screen) so the caller falls back.
 *
 * `viewedId` is the tab id the caller (render) resolved for BOTH the canvas and the highlighted tab
 * pill, so the two never disagree (the canvas would otherwise fall back to the first model tab while
 * the pill bar — using a different rule — highlighted nothing, e.g. on BMP's non-model Result tab). It's
 * optional only so the headless tests can render without a resolution step (they default to tab 0).
 */
export function renderResult(base: LModel, m: LModel, byRid: Map<string, Element>, layer: HTMLElement, viewedId?: string | null): boolean {
  const tab = (viewedId ? m.tabs.find(t => t.id === viewedId) : null) ?? m.tabs[0] ?? null;
  if (!tab) return false;
  // Anchor to the VIEWED tab's OWN live widgets — not just "the first tab with any visible widgets".
  // The shared Result tab's widgets render on every tab (a persistent action bar), so the old heuristic
  // would anchor the canvas to those (bottom of the page) regardless of which tab you're editing. When
  // the viewed tab has no live widgets on screen (peeking an off-screen tab), fall back to all visible.
  const baseTab = base.tabs.find(t => t.id === tab.id);
  const frame = (baseTab ? unionRect(baseTab, byRid) : null) ?? unionAllVisible(byRid);
  if (!frame) return false;
  // Reuse the frozen anchor for THIS tab if we have one: the canvas top/left/width don't change when the
  // page scrolls or grows below, so a mid-scroll re-render must NOT recompute them from whatever widgets
  // happen to be on-screen (that's what shifted the canvas off the real widgets). We still require a live
  // frame above (no phantom canvas), but its position is taken from the cache when present.
  const cached = bp.resultAnchor?.tabId === tab.id ? bp.resultAnchor : null;

  // Position in DOCUMENT space (frame is viewport-relative; add the scroll offset). The layer is
  // document-absolute, so the panel then scrolls natively with the page — no strip clamp needed (BMP's
  // header/tabs aren't sticky; they scroll away with everything else).
  const minH = Math.max(60, frame.height);
  // Span the FULL 6-column content area, not just the occupied columns: when no top-level row fills all
  // six (e.g. Risk Register), the widget union is narrower than BMP's grid, which squished the panel and
  // left the empty right columns as bare page. Anchor the width to BMP's real content grid instead.
  let docTop: number, left: number, width: number;
  if (cached) {
    ({ docTop, left, width } = cached);
  } else {
    const contentW = bmpContentWidth(byRid, frame.left);
    width = contentW > frame.width ? contentW : frame.width;
    docTop = docY(frame.top);
    left = docX(frame.left);
    bp.resultAnchor = { tabId: tab.id, docTop, left, width };
  }
  // Full-bleed grid backdrop BEHIND the panel — fills the whole editor width edge-to-edge (the panel
  // itself stays at content width so the cards keep BMP's column alignment). Height set after layout.
  const bg = document.createElement('div'); bg.className = 'bp-canvas-bg'; bg.style.top = `${docTop}px`;
  layer.appendChild(bg);
  const wrap = document.createElement('div'); wrap.className = 'bp-result';
  Object.assign(wrap.style, { left: `${left}px`, top: `${docTop}px`, width: `${width}px`, minHeight: `${minH}px` });

  const reordered = reorderedIds(base, m);
  const grid = document.createElement('div'); grid.className = 'bp-rgrid bp-rroot';
  if (tab.children.length) fillGrid(grid, base, tab.children, tab.id, byRid, reordered);
  // Full-width add zone — a NEW ROW below all content (the per-row gaps cover partial rows).
  const add = document.createElement('div'); add.className = 'bp-radd-zone'; add.style.gridColumn = 'span 6';
  add.dataset.bpid = tab.id; add.dataset.bpkind = 'avail';
  const ai = document.createElement('span'); ai.className = 'bp-radd-ic'; setIcon(ai, ICON_PLUS);
  const at = document.createElement('span'); at.textContent = tab.children.length ? `Add a row to "${tab.name}"` : `Tab "${tab.name}" is empty — add a widget`;
  add.append(ai, at);
  add.addEventListener('mousedown', (e) => { e.stopPropagation(); openPicker(tab.id, { at: { x: e.clientX, y: e.clientY } }); });
  grid.appendChild(add);
  wrap.appendChild(grid);

  layer.appendChild(wrap);
  // Extend the backdrop to cover whichever is lower: the panel, or the bottom of EVERY widget on the
  // page (in document space, incl. below the fold) — so a scroll never exposes real BMP widgets that
  // sit below the modelled content (e.g. a persistent action bar rendered under every tab). We can't use
  // unionAllVisible here (it drops off-screen widgets) since the canvas no longer re-renders on scroll.
  bg.style.height = `${Math.max(docTop + wrap.offsetHeight, allWidgetsBottomDoc(byRid)) - docTop}px`;
  return true;
}

/** Document-space bottom (px) of every laid-out widget on the page, viewport-visible or not — used to
 *  size the canvas backdrop so nothing real peeks out below it when scrolled. */
function allWidgetsBottomDoc(byRid: Map<string, Element>): number {
  let maxBottom = 0;
  for (const r of widgetRects(byRid)) maxBottom = Math.max(maxBottom, docY(r.bottom));
  return maxBottom;
}

/** BMP's true content-grid width (the full 6-column area) so the wireframe spans the whole content
 *  region even when the occupied widgets don't fill all six columns. Walk up from the topmost visible
 *  widget to the widest ancestor that shares the content's left edge (BMP's grid sits at the same left
 *  as its widgets; the page wrapper above it starts at x=0, so the left-match excludes it). 0 if none. */
function bmpContentWidth(byRid: Map<string, Element>, left: number): number {
  let probe: Element | null = null, ty = Infinity;
  for (const e of byRid.values()) {
    const r = e.getBoundingClientRect();
    if (r.width < 8 || r.height < 8 || r.bottom <= 0 || r.top >= innerHeight) continue;
    if (r.top < ty) { ty = r.top; probe = e; }
  }
  let best = 0, el: Element | null = probe;
  for (let i = 0; i < 12 && el; i++) {
    const r = el.getBoundingClientRect();
    if (Math.abs(r.left - left) <= 6 && r.width > best && r.width <= innerWidth) best = r.width;
    el = el.parentElement;
  }
  return best;
}

/** Bounding box of ALL currently ON-SCREEN widgets (any tab/orphan) — the fallback anchor when no model
 *  tab is active. */
function unionAllVisible(byRid: Map<string, Element>): Rect | null {
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity, any = false;
  for (const rc of widgetRects(byRid)) {
    if (rc.bottom <= 0 || rc.top >= innerHeight) continue; // on-screen only
    l = Math.min(l, rc.left); t = Math.min(t, rc.top); r = Math.max(r, rc.right); b = Math.max(b, rc.bottom); any = true;
  }
  return any ? { left: l, top: t, width: r - l, height: b - t } : null;
}
