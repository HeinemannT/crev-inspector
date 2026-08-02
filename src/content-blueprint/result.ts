/**
 * Result view — the model-driven "what the page becomes after Apply" wireframe.
 *
 * The LIVE view (view.ts) anchors boxes to BMP's frozen DOM and shows edits as badges, because the
 * real grid can't reflow client-side. This view takes the opposite tack: it renders the EDITED model
 * as a real CSS-grid mirror of BMP's column model, so a move/resize/add/delete shows in its FINAL
 * position. It touches none of BMP's DOM — it's an overlay wireframe — so there's no iframe reload,
 * no chart breakage, no fight with BMP's renderer, and it works for staged adds (which have no DOM).
 *
 * Fidelity: BMP's real grid is 12 tracks (span = cols.L × 2) — children flow left-to-right in
 * canonical order (containers before tab-bound widgets, with NO row break at the band boundary) and
 * wrap by fits-in-remainder. All of that lives in ONE engine (`lib/layout/rows.computeRows`,
 * live-verified 2026-07-02); this view renders its rows with `grid-template-columns: repeat(12, 1fr)`
 * + `grid-column: span trackSpan(node)`, so the browser's auto-placement agrees with the computed
 * rows by construction. The grid is anchored to the live content box (origin + width measured from
 * the page's widget rects) so columns line up pixel-wise with the real page.
 *
 * Tab selection: the caller (view.render) resolves ONE `viewedId` and passes it in; this view renders
 * that tab. It anchors to that tab's own live widgets when they're on screen (peeking an off-screen tab
 * falls back to all visible widgets). Cells are selectable + draggable (they carry data-bpid/data-bpkind,
 * so the gesture machinery treats them as honest, final-position drop targets).
 */
import { STYLE_NODE_FIELDS, type LModel, type LNode, type NodeStyle } from '../lib/layout/types';
import { orderChildren, isTempId, isChart, walk, fieldsChanged, isFullGhost } from '../lib/layout/model';
import { computeRows, trackSpan, TRACKS } from '../lib/layout/rows';
import { COMPOSITE_TYPES } from '../lib/layout/constraints';
import {
  ICON_PLUS, ICON_CHART, ICON_TABLE, ICON_LIST, ICON_CHECK_CIRCLE, ICON_CODE,
  ICON_LINK, ICON_PLAY, ICON_PENCIL, ICON_BOOK, ICON_LAYOUT, ICON_REVERT,
  ICON_EYE_SLASH,
} from '../lib/icons';
import { getTypeAbbr, getTypeColor } from '../lib/types';
import { flowPanel, compositeFlowRows, hasFlowPanel } from './result-flow';
import { render, visibilityStrip } from './view';
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

/** A flat baseline lookup — every baseline node (tabs included) keyed by id with its parent's id, built
 *  ONCE per render. Replaces a per-cell `findNode(base,…)` (a full-tree DFS): the result canvas classifies
 *  every rendered cell against the baseline, so without this the render was O(cells × all-baseline-nodes)
 *  — quadratic, and painful on a many-tab shared tabset where the baseline holds every tab's nodes. */
export type BaselineIndex = Map<string, { node: LNode; parentId: string | null }>;
export function indexBaseline(base: LModel): BaselineIndex {
  const idx: BaselineIndex = new Map();
  walk(base, (n, parent) => idx.set(n.id, { node: n, parentId: parent?.id ?? null }));
  return idx;
}

export function cellState(base: BaselineIndex, node: LNode, modelParentId: string | null, reordered: ReadonlySet<string> = NO_REORDER): CellState {
  if (isTempId(node.id)) return 'new';
  const b = base.get(node.id);
  if (!b) return 'new';
  if (fieldsChanged(b.node, node)) return 'changed';
  if (b.parentId !== modelParentId) return 'moved';
  if (reordered.has(node.id)) return 'moved';
  return 'same';
}

/** Ids reordered WITHIN an unchanged parent group — a swap or drag-reorder where parent, width, name
 *  and height are all unchanged, so cellState would otherwise read 'same'. A cell is flagged when its
 *  preceding same-kind, baseline-surviving sibling differs from baseline; that's symmetric (both halves
 *  of a swap light up) and limited to genuine reorders. Only groups whose membership is IDENTICAL to
 *  baseline are considered, so an insert / cross-container move (already coloured 'new' / parent-'moved')
 *  doesn't light up the neighbours its index-shift dragged along. */
function reorderedIds(base: BaselineIndex, m: LModel): Set<string> {
  const out = new Set<string>();
  const consider = (parentId: string, kids: LNode[]): void => {
    const baseKids = base.get(parentId)?.node.children; // index holds tabs too, so this covers both tab + container parents
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

/** A small "+" zone filling the trailing FREE tracks of a row, so the empty right side of a
 *  partly-filled row (e.g. Risk Register) is a real add target. `freeTracks` sizes the visual span;
 *  `fitL` (whole L columns that fit, = ⌊freeTracks/2⌋) sizes what lands in it. A slot too narrow for
 *  any widget (fitL 0 — the odd track beside a 0-width container) renders as inert filler. */
function gapCell(parentId: string, freeTracks: number, afterId?: string): HTMLElement {
  const z = document.createElement('div'); z.className = 'bp-rgap'; z.style.gridColumn = `span ${freeTracks}`;
  const fitL = Math.floor(freeTracks / 2);
  if (fitL < 1) { z.classList.add('bp-rgap-dead'); return z; }
  z.dataset.bpid = parentId; z.dataset.bpkind = 'avail'; z.dataset.bpfree = String(fitL); // a widget dropped here resizes to fit the slot
  // The gap's ordinal anchor: the row's last real cell. A DROP here inserts right after it (same as the
  // click/add path), not appended at the parent's end — so a widget dropped in a trailing slot keeps the
  // row's reading order instead of landing far below. Absent on a full-width empty-container gap → append.
  if (afterId) z.dataset.bpafter = afterId;
  const ic = document.createElement('span'); ic.className = 'bp-rgap-ic'; setIcon(ic, ICON_PLUS); z.appendChild(ic);
  // Insert the new widget AT the clicked gap (right after the row's last cell), not appended at the end
  // of the parent — otherwise adding to an empty right-side slot drops the widget far below, off-screen.
  z.addEventListener('mousedown', (e) => { e.stopPropagation(); openPicker(parentId, { cols: fitL, at: { x: e.clientX, y: e.clientY }, ...(afterId ? { afterId } : {}) }); });
  return z;
}

/** Append a parent's children to `grid` as computeRows lays them out, dropping a gapCell in each
 *  row's trailing free tracks — the render side of the ONE row engine, so every empty slot the
 *  wireframe shows is a slot the engine agrees exists. `m` = the EDITED model (flow projections +
 *  staged flow edits ride on it). */
function fillGrid(grid: HTMLElement, base: BaselineIndex, m: LModel, children: LNode[], parentId: string, byRid: Map<string, Element>, reordered: ReadonlySet<string>): void {
  // Full ghosts (noVisible / hidden on every display size) never render for
  // anyone and BMP's packing reflows around them (verified live) — so they're
  // excluded from BOTH the cells and the row math, or the grid shown here
  // would be a layout no user ever sees. They live in the hidden tray below
  // the add-zone instead. They stay in the MODEL (diff/apply untouched).
  // Same precedent for an ActionButton STAGED to the action menu (Placement → Action bar): it leaves
  // the cells AND the row math for the tray card, but stays in the model/diff untouched.
  const stagedToMenu = (c: LNode): boolean => m.flowEdits?.[c.id]?.displayOnActionMenu === true;
  const rendered = children.filter(c => !isFullGhost(c) && !stagedToMenu(c));
  // A parent whose only children are full ghosts renders no rows, so without
  // this it would show an empty box with no way to add to it (the caller took
  // the "has children" branch on the raw count). Give it the same full-width
  // add slot an empty parent gets — the ghosts still live in the tray below.
  if (rendered.length === 0) {
    grid.appendChild(gapCell(parentId, TRACKS));
    return;
  }
  for (const row of computeRows(rendered)) {
    for (const c of row.items) grid.appendChild(cell(base, m, c, parentId, byRid, reordered));
    if (row.free > 0) grid.appendChild(gapCell(parentId, row.free, row.items[row.items.length - 1]?.id));
  }
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
    ? `Reset staged: Apply reverts ${label} to the template value. Click to cancel.`
    : `${label} overrides the template. Click to reset it to the template value.`;
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
  const nm = document.createElement('span'); nm.className = 'bp-rnm'; nm.textContent = node.name; nm.dataset.bprename = node.id; lab.appendChild(nm);
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
  // Transparency in BMP dissolves the widget CHROME (header fill, underline),
  // not the content — the type icon and header text stay readable. So the
  // preview drops the header colour + line instead of fading the whole cell
  // (the old opacity ramp made fade 100 read as "widget missing").
  const faded = typeof s.transparency === 'number' && s.transparency > 0;
  if (faded) el.classList.add('bp-fade');
  const hc = colorRgb(s.headerColorBid);
  if (hc && !faded) {
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
}

/** Does this node's appearance differ from the baseline? (Any STYLE_NODE_FIELDS field, absence folded to
 *  its default — same rule as diff.changedStyle.) Drives the style-mode "edited" ring. A staged-add node
 *  has no baseline counterpart and already reads as 'new', so it's not flagged here. */
function styleDirty(base: BaselineIndex, node: LNode): boolean {
  const b = base.get(node.id)?.node;
  if (!b) return false;
  return STYLE_NODE_FIELDS.some(f => (b.style?.[f.key] ?? f.def) !== (node.style?.[f.key] ?? f.def));
}

/** One widget/container cell. Containers recurse into a nested 6-col sub-grid. */
function cell(base: BaselineIndex, m: LModel, node: LNode, parentId: string | null, byRid: Map<string, Element>, reordered: ReadonlySet<string>): HTMLElement {
  const el = document.createElement('div');
  el.dataset.bpid = node.id;
  el.dataset.bpkind = node.kind === 'container' ? 'container' : 'widget';
  el.style.gridColumn = `span ${trackSpan(node)}`;
  const composite = isCompositeWithKids(node);
  // A flow-bearing widget (InputView/COV/ActionButton with a projection) renders its chain in the cell
  // body — composite-style sizing (size to the rows, no height clamp, no watermark/short-cell logic
  // fighting the panel — pitfall 11).
  const flow = node.kind === 'widget' && hasFlowPanel(m, node);
  const h = widgetHeight(node, byRid);
  if (h && !composite && !flow) el.style.height = `${h.px}px`; // composites/flow cells size to their children, not an estimate
  const state = cellState(base, node, parentId, reordered);
  // Too short to fit the label + the centred type watermark + the caption without overlap → drop the
  // watermark (CSS hides .bp-rwm on .bp-rshort). Short content widgets (TextElement, InputView) hit this.
  const short = node.kind === 'widget' && !composite && !flow && !!h && h.px < SHORT_CELL_HEIGHT;
  el.className = `bp-rcell st-${state}` + (node.kind === 'container' ? ' bp-rcont' : '') + (composite ? ' bp-rcomp-host' : '')
    + (flow ? ' bp-rflow' : '')
    + (isChart(node.className) ? ' bp-rchart' : '') + (short ? ' bp-rshort' : '')
    + (h && !composite && !flow ? (h.measured ? ' bp-rsized' : ' bp-rest') : '') + (bp.selectedId === node.id ? ' sel' : '');

  const icon = typeIcon(node.className);
  const labelEl = buildLabel(node, state);
  el.appendChild(labelEl);
  if (bp.mode === 'style') {
    if (node.style) applyStyle(el, labelEl, node.style);
    if (styleDirty(base, node)) el.classList.add('bp-style-dirty'); // staged appearance edit → ring it
  }
  // Per-viewer visibility marker: adminVisibleOnly / visibleAsParentOnly render
  // normally for the configurator (they DO occupy this layout), but users don't
  // see them and their layout reflows without them — surface that on the cell.
  const vis = node.style?.visibility;
  if (vis === 'ADMINVISIBLEONLY' || vis === 'VISIBLEASPARENTONLY') {
    const tag = document.createElement('span');
    tag.className = 'bp-vis-tag';
    tag.textContent = vis === 'ADMINVISIBLEONLY' ? 'ADMIN' : 'PARENT';
    tag.title = vis === 'ADMINVISIBLEONLY'
      ? 'visibility = adminVisibleOnly. Renders for you; non-admin users do not see it and their layout reflows without it.'
      : 'visibility = visibleAsParentOnly. Shown only in the parent context; other viewers do not see it.';
    el.appendChild(tag);
  }

  if (node.kind === 'container') {
    const grid = document.createElement('div'); grid.className = 'bp-rgrid';
    if (node.children.length) fillGrid(grid, base, m, node.children, node.id, byRid, reordered);
    else grid.appendChild(gapCell(node.id, TRACKS)); // empty container → a full add slot
    el.appendChild(grid);
  } else if (flow) {
    // Flow-bearing widget: config band(s) + reference band + the chain as badge-led rows (result-flow).
    const panel = flowPanel(m, node);
    if (panel) el.appendChild(panel);
  } else if (composite) {
    // Composite placed IN THE GRID (ButtonContainer/ButtonGroup/InputSet/…): its LNode children in the
    // same flow row grammar — adds/reorders ride the EXISTING layout pipeline (ec composite branch).
    el.appendChild(compositeFlowRows(m, node));
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

// (The old read-only compositeChildCell was replaced by result-flow.compositeFlowRows — grid
// composites now render editable badge-led rows in the flow grammar.)

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
interface GhostEntry {
  node: LNode;
  /** Where it re-packs on restore: after this sibling, or first in `parentName`. */
  prevName: string | null;
  parentName: string;
}

/** Collect the viewed tab's FULL ghosts, top-most only (a ghost container's
 *  children ride along with it — listing them separately would double-count).
 *  Each entry carries its return position: the nearest preceding NON-ghost
 *  sibling (what it packs after when restored), or "first" in its parent. */
function collectGhosts(tab: LNode): GhostEntry[] {
  const out: GhostEntry[] = [];
  const walkTop = (parent: LNode, nodes: LNode[]): void => {
    const ordered = orderChildren(nodes);
    for (let i = 0; i < ordered.length; i++) {
      const n = ordered[i];
      if (isFullGhost(n)) {
        let prevName: string | null = null;
        for (let j = i - 1; j >= 0; j--) {
          if (!isFullGhost(ordered[j])) { prevName = ordered[j].name || ordered[j].id; break; }
        }
        out.push({ node: n, prevName, parentName: parent.name || parent.id });
      } else {
        walkTop(n, n.children);
      }
    }
  };
  walkTop(tab, tab.children);
  return out;
}

/** The per-tab hidden tray — the add-zone's quiet counterpart directly below
 *  it. Collapsed: one grey line with the count. Expanded: a hatched row of
 *  ghost cells (type chip · name · reason · restore). The grid above shows
 *  ONLY what BMP renders, so it stays truthful; this is where the rest live. */
function ghostTray(tab: LNode): HTMLElement | null {
  const ghosts = collectGhosts(tab);
  if (!ghosts.length) return null;

  const zone = document.createElement('div');
  zone.className = 'bp-ghost-tray' + (bp.ghostTrayOpen ? ' open' : '');
  zone.style.gridColumn = 'span 12';

  const head = document.createElement('button');
  head.className = 'bp-ghost-head';
  const hi = document.createElement('span'); setIcon(hi, ICON_EYE_SLASH); hi.className = 'bp-ghost-ic';
  const ht = document.createElement('span');
  ht.textContent = 'Hidden widgets';
  const ct = document.createElement('span'); ct.className = 'bp-ghost-count'; ct.textContent = String(ghosts.length);
  const hh = document.createElement('span'); hh.className = 'bp-ghost-hint';
  hh.textContent = bp.ghostTrayOpen ? 'Click to fold' : 'Click to show';
  head.append(hi, ht, ct, hh);
  head.title = 'Widgets on this tab that no viewer sees. The grid above shows how the page packs without them.';
  // mousedown is the overlay's gesture convention (every cell/handle toggles on
  // mousedown, not click) and it fires before render() tears this node down, so
  // it's the single source of truth. The trailing click is swallowed only so it
  // can't reach the canvas underneath — it must NOT toggle again (the head it
  // would land on is a freshly-rendered node, so a shared debounce can't guard
  // it; two handlers toggling was the open-then-immediately-close bug).
  head.addEventListener('mousedown', (e) => {
    e.stopPropagation(); e.preventDefault();
    bp.ghostTrayOpen = !bp.ghostTrayOpen;
    render();
  });
  head.addEventListener('click', (e) => { e.stopPropagation(); e.preventDefault(); });
  zone.appendChild(head);

  if (bp.ghostTrayOpen) {
    // Shadow row — each ghost as a LIFE-SIZE blueprint cell at its true column
    // width: night header (chip + name + type), hatched body with the type
    // watermark, and a footer holding the REAL visibility strip. The strip is
    // both the reason display (slashed eye = noVisible, slashed letters =
    // sizes off) and the control: any toggle that un-ghosts the node re-packs
    // it into the grid above at its model position on the very next render —
    // the node never left the model, only this render-time tray.
    const row = document.createElement('div');
    row.className = 'bp-ghost-row';
    for (const g of ghosts) {
      const c = document.createElement('div');
      c.className = 'bp-ghost-cell';
      c.style.gridColumn = `span ${trackSpan(g.node)}`;

      const lab = document.createElement('div'); lab.className = 'bp-ghost-lab';
      const typ = document.createElement('span'); typ.className = 'typ';
      typ.textContent = getTypeAbbr(g.node.className);
      typ.style.setProperty('--type-color', getTypeColor(g.node.className));
      const nm = document.createElement('span'); nm.className = 'bp-ghost-nm'; nm.textContent = g.node.name || g.node.id;
      const ty = document.createElement('span'); ty.className = 'bp-ghost-ty'; ty.textContent = g.node.className.toUpperCase();
      lab.append(typ, nm, ty);
      c.appendChild(lab);

      const body = document.createElement('div'); body.className = 'bp-ghost-body';
      const icon = typeIcon(g.node.className);
      if (icon) { const wm = document.createElement('span'); wm.className = 'bp-ghost-wm'; setIcon(wm, icon); body.appendChild(wm); }
      c.appendChild(body);

      const foot = document.createElement('div'); foot.className = 'bp-ghost-foot';
      const strip = visibilityStrip(g.node);
      if (strip) foot.appendChild(strip);
      const pos = document.createElement('span'); pos.className = 'bp-ghost-pos';
      pos.textContent = g.prevName ? `returns after \u201C${g.prevName}\u201D` : `returns first in \u201C${g.parentName}\u201D`;
      pos.title = 'Un-hiding re-packs the widget at its saved position in the grid above.';
      foot.appendChild(pos);
      foot.addEventListener('mousedown', (e) => e.stopPropagation());
      c.appendChild(foot);

      row.appendChild(c);
    }
    zone.appendChild(row);
  }
  return zone;
}

export function renderResult(base: LModel, m: LModel, byRid: Map<string, Element>, layer: HTMLElement, viewedId?: string | null): boolean {
  const tab = (viewedId ? m.tabs.find(t => t.id === viewedId) : null) ?? m.tabs[0] ?? null;
  if (!tab) return false;
  // Anchor to the VIEWED tab's OWN live widgets — not just "the first tab with any visible widgets".
  // The shared Result tab's widgets render on every tab (a persistent action bar), so the old heuristic
  // would anchor the canvas to those (bottom of the page) regardless of which tab you're editing. When
  // the viewed tab has no live widgets on screen (peeking an off-screen tab), fall back to all visible.
  const baseTab = base.tabs.find(t => t.id === tab.id);
  let frame = (baseTab ? unionRect(baseTab, byRid) : null) ?? unionAllVisible(byRid);
  // No live widget anchors — BMP hasn't painted yet (the post-apply reload re-enables blueprint before
  // React mounts), or the model's rids don't exist in this page's DOM (editing the template/instance
  // counterpart of what's rendered). The model is loaded and perfectly editable, so render it anyway on
  // a synthetic content-box frame instead of dead-ending on "no widgets are on screen". Not cached: the
  // next render with real widgets recomputes and snaps the canvas into pixel alignment.
  const synthetic = !frame;
  if (!frame) frame = contentAreaFrame();
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
    if (!synthetic) bp.resultAnchor = { tabId: tab.id, docTop, left, width }; // never freeze a guessed frame
  }
  // Full-bleed grid backdrop BEHIND the panel — fills the whole editor width edge-to-edge (the panel
  // itself stays at content width so the cards keep BMP's column alignment). Height set after layout.
  const bg = document.createElement('div'); bg.className = 'bp-canvas-bg'; bg.style.top = `${docTop}px`;
  layer.appendChild(bg);
  const wrap = document.createElement('div'); wrap.className = 'bp-result';
  Object.assign(wrap.style, { left: `${left}px`, top: `${docTop}px`, width: `${width}px`, minHeight: `${minH}px` });

  // Index the baseline ONCE for this render (not per cell) — see indexBaseline. Every cellState /
  // styleDirty / reorderedIds lookup below hits this map instead of a full-tree findNode.
  const bidx = indexBaseline(base);
  const reordered = reorderedIds(bidx, m);
  const grid = document.createElement('div'); grid.className = 'bp-rgrid bp-rroot';
  if (tab.children.length) fillGrid(grid, bidx, m, tab.children, tab.id, byRid, reordered);
  // Full-width add zone — a NEW ROW below all content (the per-row gaps cover partial rows).
  const add = document.createElement('div'); add.className = 'bp-radd-zone'; add.style.gridColumn = 'span 12';
  add.dataset.bpid = tab.id; add.dataset.bpkind = 'avail';
  const ai = document.createElement('span'); ai.className = 'bp-radd-ic'; setIcon(ai, ICON_PLUS);
  const at = document.createElement('span'); at.textContent = tab.children.length ? `Add a container or widget to "${tab.name}"` : `Tab "${tab.name}" is empty. Add a container or widget`;
  add.append(ai, at);
  add.addEventListener('mousedown', (e) => { e.stopPropagation(); openPicker(tab.id, { at: { x: e.clientX, y: e.clientY } }); });
  grid.appendChild(add);
  const tray = ghostTray(tab);
  if (tray) grid.appendChild(tray);
  wrap.appendChild(grid);

  layer.appendChild(wrap);
  // Extend the backdrop to cover whichever is lower: the panel, or the bottom of EVERY widget on the
  // page (in document space, incl. below the fold) — so a scroll never exposes real BMP widgets that
  // sit below the modelled content (e.g. a persistent action bar rendered under every tab). We can't use
  // unionAllVisible here (it drops off-screen widgets) since the canvas no longer re-renders on scroll.
  bg.style.height = `${Math.max(docTop + wrap.offsetHeight, allWidgetsBottomDoc(byRid)) - docTop}px`;
  return true;
}

/** Fallback frame when no live widget anchors the canvas: BMP's app container inset a little, else a
 *  viewport-derived band. Only used for the synthetic (uncached) render — see renderResult. */
function contentAreaFrame(): Rect {
  const el = document.querySelector('#epmapp, #corpo-app, main, #root');
  const r = el?.getBoundingClientRect();
  if (r && r.width >= 320) {
    return { left: r.left + 16, top: Math.max(r.top + 16, 96), width: Math.min(r.width - 32, 1400), height: 240 };
  }
  return { left: 24, top: 96, width: Math.max(320, Math.min(innerWidth - 48, 1400)), height: 240 };
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

/** Bounding box of ALL rendered widgets (any tab/orphan), whether or not in the viewport — the fallback
 *  anchor when the viewed tab's rids don't match the live DOM. NOT viewport-filtered: that made the anchor
 *  depend on the scroll position at enter-time (see 21cbdff). */
function unionAllVisible(byRid: Map<string, Element>): Rect | null {
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity, any = false;
  // Union EVERY rendered widget (widgetRects already drops zero-size / unrendered ones) — NOT only those
  // in the viewport. The old on-screen filter anchored the canvas to whatever happened to be scrolled
  // into view when Blueprint was entered, so entering while scrolled down placed the canvas "down there"
  // at the scroll position instead of over the page's real top. Viewport-relative rects + docY() in the
  // caller make this scroll-independent, so the fallback anchor is now the page's full content box.
  for (const rc of widgetRects(byRid)) {
    l = Math.min(l, rc.left); t = Math.min(t, rc.top); r = Math.max(r, rc.right); b = Math.max(b, rc.bottom); any = true;
  }
  return any ? { left: l, top: t, width: r - l, height: b - t } : null;
}
