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
import { findNode, hasHeight, isResultTab, descendantWidgets, descendantVisibleWidgets } from '../lib/layout/model';
import { COMPOSITE_TYPES, COMPOSITE_CHILDREN } from '../lib/layout/constraints';
import { isAncestorOf } from '../lib/layout/edit';
import { diff, summarizeChanges } from '../lib/layout/diff';
import { ICON_PLUS, ICON_MINUS, ICON_PENCIL, ICON_TRASH, ICON_ARROW_RIGHT, ICON_X, ICON_LAYOUT, ICON_LINK, ICON_EYE_OPEN, ICON_EYE_SLASH, ICON_DOTS_THREE_V, ICON_SEARCH } from '../lib/icons';
import { colorLinkBid } from '../lib/color-util';
import { styleOptions } from '../lib/style-props';
import { renderSwatchGrid } from '../lib/swatch-grid';
import { bp, model, PALETTE, MOST_USED } from './state';
import { colorRgb, colorInfo, colorSets } from './colors';
import { type Rect, ridElementMap, unionRect, anchorRect, setIcon, mkBtn, mkIconBtn, docX, docY } from './geometry';

/** Hairline divider inside a toolbar row. */
function vdivEl(): HTMLElement {
  const d = document.createElement('div'); d.className = 'bp-vdiv'; return d;
}

/** A portal-flag toggle: quiet grey at the BMP default, amber when deviating.
 *  `current` is the staged boolean; `def` the decompiled trait default. The
 *  icon may differ per state (eye / eye-slash) or stay constant (dots, gps). */
function flagBtn(current: boolean, def: boolean, iconDefault: string, iconDeviant: string, title: string, onClick: () => void): HTMLElement {
  const b = document.createElement('button');
  const deviating = current !== def;
  b.className = 'bp-flag' + (deviating ? ' dev' : '');
  b.title = title;
  setIcon(b, deviating ? iconDeviant : iconDefault);
  b.addEventListener('mousedown', (e) => { e.stopPropagation(); onClick(); });
  return b;
}

/** The value the eye restores to. A widget that STARTED adminVisibleOnly /
 *  visibleAsParentOnly must return to that baseline, not plain VISIBLE — the
 *  eye must not silently destroy an admin-only setup. */
function restoreVisibility(nodeId: string): string {
  const b = bp.baseline ? findNode(bp.baseline, nodeId)?.node : null;
  const bv = b?.style?.visibility;
  return bv && bv !== 'NOVISIBLE' ? bv : 'VISIBLE';
}

/** Joined [eye | L | M | S] visibility strip. Eye toggles the `visibility`
 *  ENUM between VISIBLE and NOVISIBLE (the `visible` boolean is read-only —
 *  Visibillity has no setter). adminVisibleOnly / visibleAsParentOnly read as
 *  VISIBLE here (unslashed eye; the cell wears a marker instead). L/M/S are
 *  the ScreenSizeVisibility booleans: unticked = orange letter with a slash. */
export function visibilityStrip(node: LNode): HTMLElement | null {
  const st = node.style;
  // A staged-add widget has no rid and no fetched style yet, but every widget
  // supports visibility + the S/M/L sizes — and the compiler already emits them
  // for a new node (`styleAssignments(undefined, n.style)`). So show the strip
  // with defaults (visible, all sizes on); the value reads below default missing
  // → visible/on. Without this the controls silently vanish on new objects.
  const isNewWidget = !node.rid && node.kind === 'widget';
  const hasEnum = st?.visibility !== undefined || isNewWidget;
  const hasSizes = st?.shownOnLargeDisplay !== undefined || st?.shownOnMediumDisplay !== undefined || st?.shownOnSmallDisplay !== undefined || isNewWidget;
  if (!hasEnum && !hasSizes) return null;
  const wrap = document.createElement('div');
  wrap.className = 'bp-vseg';
  wrap.setAttribute('role', 'group');
  wrap.setAttribute('aria-label', 'Visibility');

  const mkCell = (off: boolean, title: string, onClick: () => void, content: { icon?: string; text?: string }, moot = false): HTMLElement => {
    const c = document.createElement('button');
    c.className = 'c' + (off ? ' off' : '') + (moot ? ' moot' : '');
    c.title = title;
    if (content.icon) setIcon(c, content.icon); else c.textContent = content.text ?? '';
    c.addEventListener('mousedown', (e) => { e.stopPropagation(); onClick(); });
    return c;
  };

  const hiddenNow = st?.visibility === 'NOVISIBLE';
  if (hasEnum) {
    wrap.appendChild(mkCell(
      hiddenNow,
      hiddenNow ? 'HIDDEN for everyone (visibility = noVisible). Click to show' : 'Visible. Click to hide for everyone',
      () => setNodeStyle(node.id, { visibility: hiddenNow ? restoreVisibility(node.id) : 'NOVISIBLE' }),
      { icon: hiddenNow ? ICON_EYE_SLASH : ICON_EYE_OPEN },
    ));
  }
  if (hasSizes) {
    const sizes: Array<{ key: 'shownOnLargeDisplay' | 'shownOnMediumDisplay' | 'shownOnSmallDisplay'; letter: string; word: string }> = [
      { key: 'shownOnLargeDisplay', letter: 'L', word: 'large' },
      { key: 'shownOnMediumDisplay', letter: 'M', word: 'medium' },
      { key: 'shownOnSmallDisplay', letter: 'S', word: 'small' },
    ];
    for (const sz of sizes) {
      const on = st?.[sz.key] !== false;
      wrap.appendChild(mkCell(
        !on,
        on ? `Shown on ${sz.word} displays. Click to hide there` : `HIDDEN on ${sz.word} displays. Click to show`,
        () => setNodeStyle(node.id, { [sz.key]: !on }),
        { text: sz.letter },
        hiddenNow, // letters are moot while the eye hides everywhere
      ));
    }
  }
  return wrap;
}
import {
  beginRename, viewTab, addTabAction, setWidth, setH, doDelete, doRename, openPicker, addFromPicker, closePicker, addContainerTo,
  openMovePicker, closeMovePicker, moveTo, doCreateTabset, setNodeStyle, openSwatch, closeSwatch, applySwatch,
  openTabMenu, closeTabMenu, reorderTab,
} from './actions';
import { renderChip, modeSwitch, scopeClass, previewModal, trayPanel, hintBar } from './view-panels';
import { paintStation, paintPopup } from './view-paint';
import { renderResult, typeIcon } from './result';

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
  const base = bp.baseline, m = model(), ctx = bp.ctx;
  if (!base || !m || !ctx) return;
  // Paintbrush cursor/affordance hooks (toggled each render so they track the brush state).
  layer.classList.toggle('bp-brush', bp.brush.mode !== 'off');
  layer.classList.toggle('bp-brush-pick', bp.brush.mode === 'pick');
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
  header.className = 'bp-header' + scopeClass(ctx) + (bp.mode === 'style' ? ' style' : '');
  // The vertical mode switch sits at the left, spanning the chip + tab rows; the chip and tab bar stack
  // in the main column to its right.
  const main = document.createElement('div'); main.className = 'bp-header-main';
  main.append(renderChip(ctx, pending), tabBar(base, m, liveId, viewedId));
  header.append(modeSwitch(), main);
  if (bp.mode === 'style') header.appendChild(paintStation()); // the paintbrush 2×2, right of the bar
  layer.appendChild(header);

  // The result canvas IS the editor: the edited model laid out as a CSS-grid wireframe (final positions,
  // real heights, all tabs, honest drop targets) — the sole editing surface. It anchors to the live
  // content box; when nothing is on screen to anchor to (an all-empty page) it returns false and we show
  // a small empty-state instead. Selection toolbar + pickers + tray + modal render at the foot.
  if (renderResult(base, m, byRid, layer, viewedId)) {
    bp.resultMode = true;
    renderFloatingChrome(byRid, m);
    if (oldRects) flipFrom(layer, oldRects); // animate moved/reordered cells to their new positions
    ensureScrollRoom(layer.querySelector('.bp-result')); // let the page scroll to a panel taller than BMP's content
    return;
  }
  bp.resultMode = false;
  renderEmptyCanvas(layer);
  renderFloatingChrome(byRid, m);
}

/** Shown when the result canvas has nothing to render — the loaded model has NO TABS at all (a page
 *  whose layout lives elsewhere). Anchor failures no longer land here: renderResult falls back to a
 *  synthetic content-box frame when no live widget anchors, so a loaded model always renders. */
function renderEmptyCanvas(layer: HTMLElement): void {
  neutralizeScrollRoom(); // no tall panel here — collapse any spacer the previous result render left
  const box = document.createElement('div'); box.className = 'bp-empty';
  const t = document.createElement('div'); t.className = 'bp-empty-t'; t.textContent = 'Nothing to lay out here';
  const s = document.createElement('div'); s.className = 'bp-empty-s';
  s.textContent = 'This page’s layout model has no tabs. If this is a templated instance that owns no layout of its own, switch the target back to Template to edit the shared layout.';
  box.append(t, s);
  layer.appendChild(box);
}

/** Selection toolbar + move-menu + add-picker + tray + hint + apply modal. These anchor to a node's
 *  box (resolved via `anchorRect`, which works in either view) and otherwise float, so both the live
 *  and result views share them verbatim. */
function renderFloatingChrome(byRid: Map<string, Element>, m: LModel): void {
  const layer = bp.layer!, base = bp.baseline!, ctx = bp.ctx!;
  // selection toolbar (hidden while a modal/picker is up, or while the paintbrush is armed / a paint
  // popup is open — you're transferring styles in bulk, not editing one cell)
  if (!bp.preview && !bp.picker && !bp.movePicker && bp.brush.mode === 'off' && !bp.paintPanel) {
    const selBox = bp.selectedId ? findNode(m, bp.selectedId) : null;
    // Tabs own their rename/add/delete on the pill itself — the generic toolbar's Rename targets
    // a `.bp-box .bp-nm` a pill doesn't have, and its W/Delete just duplicate the pill. Skip it.
    // Style mode only styles widgets (containers/tabs don't carry the appearance props) — skip the
    // toolbar for a selected non-widget there; layout mode keeps the container toolbar.
    const styleSkip = bp.mode === 'style' && !!selBox && selBox.node.kind !== 'widget';
    if (selBox && selBox.node.kind !== 'tab' && !styleSkip) {
      // Prefer the RESULT CELL's box — that's the surface the user sees and edits. anchorRect (the live
      // widget's real-page position) is only the fallback for the no-result live view; using it first
      // anchored the toolbar to where the widget sits on the real page, not its result cell.
      const anchor = resultAnchor(selBox.node.id) ?? anchorRect(selBox.node, byRid);
      if (anchor) layer.appendChild(toolbar(selBox.node, anchor));
    }
  }
  if (bp.swatch) layer.appendChild(swatchPopup(byRid));
  if (bp.paintPanel) { const p = paintPopup(); if (p) layer.appendChild(p); }

  if (bp.movePicker) {
    const f = findNode(m, bp.movePicker);
    const anchor = resultAnchor(bp.movePicker) ?? (f ? anchorRect(f.node, byRid) : null);
    layer.appendChild(moveMenu(bp.movePicker, anchor ?? { left: 80, top: 80, width: 0, height: 0 }));
  }
  if (bp.tabMenu) layer.appendChild(tabContextMenu(bp.tabMenu));
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

function toolbar(node: LNode, r: Rect): HTMLElement {
  if (bp.mode === 'style') return styleToolbar(node, r);
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
  // Visibility strip [eye | L | M | S] — the layout strip's one portal-flag
  // group (the style panel carries tools/search). Rendered when the type has
  // either trait (absent from the fetched style = no trait = no cell).
  const strip = visibilityStrip(node);
  if (node.kind === 'widget' && strip) {
    t.appendChild(vdivEl());
    t.appendChild(strip);
  }
  if (node.kind === 'widget' && COMPOSITE_TYPES.has(node.className)) t.appendChild(mkIconBtn(ICON_PLUS, () => openPicker(node.id), 'Child'));
  if (node.kind === 'widget') t.appendChild(mkIconBtn(ICON_ARROW_RIGHT, () => openMovePicker(node.id), 'Move'));
  t.appendChild(mkIconBtn(ICON_PENCIL, () => beginRename(node.id), 'Rename'));
  const del = mkIconBtn(ICON_TRASH, () => doDelete(node.id), 'Delete'); del.classList.add('del');
  t.appendChild(del);
  return t;
}

// ── G3 style-mode toolbar (appearance: colours, shadow, header/border, transparency) ──────────────
// The enum option lists come from the single style catalog (style-props) — same source the side panel's
// pane-schema reads — so the toolbar, the fetch, and the apply can't drift on the member names.
const HEADER_STYLE_OPTS = styleOptions('headerStyle');
const BORDER_STYLE_OPTS = styleOptions('borderStyle');

/** The style-mode selection toolbar — a compact 2-row appearance panel (Photoshop-style) in place of the
 *  layout W/H/move/rename strip. Row 1 = the two colour slots; row 2 = shadow / border / header / fade.
 *  Each control is a labelled group so nothing is cut off. Colours open the swatch popup; everything else
 *  stages immediately (live preview via applyStyle). */
function styleToolbar(node: LNode, r: Rect): HTMLElement {
  const t = document.createElement('div'); t.className = 'bp-tools bp-style-tools';
  const lift = bp.resultMode ? 56 : 50; // taller (2 rows) → lift further so it clears the cell
  t.style.left = `${docX(Math.max(4, r.left))}px`;
  t.style.top = `${docY(Math.max(0, r.top - lift))}px`;
  const s = node.style ?? {};

  const row1 = document.createElement('div'); row1.className = 'bp-strow';
  row1.append(
    colorSlot('Header', node.id, 'headerColor', s.headerColorBid),
    colorSlot('Font', node.id, 'fontColor', s.fontColorBid),
  );
  // Widget flags — captioned like every other group, rendered only when the
  // type carries the trait (the fetch read a real value). Quiet at the BMP
  // default, amber when deviating (blueprint's 'changed' colour).
  if (s.showToolMenu !== undefined || s.disableSearch !== undefined) row1.append(vdivEl());
  if (s.showToolMenu !== undefined) {
    row1.append(styleGroup('Tools', flagBtn(
      s.showToolMenu, true, ICON_DOTS_THREE_V, ICON_DOTS_THREE_V,
      s.showToolMenu ? 'Tools menu shown (default). Click to hide' : 'Tools menu HIDDEN. Click to show',
      () => setNodeStyle(node.id, { showToolMenu: !(node.style?.showToolMenu ?? true) }),
    )));
  }
  if (s.disableSearch !== undefined) {
    row1.append(styleGroup('Hide search', flagBtn(
      !s.disableSearch, true, ICON_SEARCH, ICON_SEARCH,
      s.disableSearch ? 'Widget search DISABLED. Click to enable' : 'Widget search enabled (default). Click to disable',
      () => setNodeStyle(node.id, { disableSearch: !(node.style?.disableSearch ?? false) }),
    )));
  }

  const row2 = document.createElement('div'); row2.className = 'bp-strow';
  row2.append(
    styleGroup('Shadow', segChoice([{ value: 'on', label: 'On' }, { value: 'off', label: 'Off' }], s.shadow ? 'on' : 'off', (v) => setNodeStyle(node.id, { shadow: v === 'on' }))),
    styleGroup('Border', segChoice(BORDER_STYLE_OPTS, s.borderStyle, (v) => setNodeStyle(node.id, { borderStyle: v }))),
    // "Header bar" = the headerStyle placement (In/Out/None) — distinct from the "Header" colour slot in row 1.
    styleGroup('Header bar', segChoice(HEADER_STYLE_OPTS, s.headerStyle, (v) => setNodeStyle(node.id, { headerStyle: v }))),
    styleGroup('Fade', transpControl(node, s.transparency ?? 0)),
  );

  t.append(row1, row2);
  return t;
}

/** A labelled control group: a tiny uppercase caption above its control (Photoshop panel idiom). */
function styleGroup(label: string, control: HTMLElement): HTMLElement {
  const g = document.createElement('div'); g.className = 'bp-sgrp';
  const l = document.createElement('span'); l.className = 'bp-sgrp-l'; l.textContent = label;
  g.append(l, control);
  return g;
}

/** A colour slot: caption + a wide swatch button showing the linked colour's chip + name (or "None").
 *  Click opens the swatch popup for that slot; highlighted while its popup is open. */
function colorSlot(label: string, nodeId: string, prop: 'headerColor' | 'fontColor', bid: string | undefined): HTMLElement {
  const b = document.createElement('button'); b.className = 'bp-swatch-btn';
  if (bp.swatch?.nodeId === nodeId && bp.swatch.prop === prop) b.classList.add('open');
  const sq = document.createElement('span'); sq.className = 'bp-swatch-sq';
  const info = bid ? colorInfo(bid) : null;
  const rgb = colorRgb(bid);
  if (rgb) sq.style.background = rgb; else sq.classList.add('none');
  const nm = document.createElement('span'); nm.className = 'bp-swatch-nm';
  nm.textContent = info?.name ?? (bid ? bid : 'None');
  b.append(sq, nm);
  b.title = `${label} colour. Click to pick or clear it.`;
  b.addEventListener('mousedown', (e) => { e.stopPropagation(); openSwatch(nodeId, prop); });
  return styleGroup(label, b);
}

/** A segmented choice — the option whose value === current lights up (none when unset). Auto-width
 *  buttons (vs the layout strip's fixed 20px) so labels like "Out"/"None" aren't clipped. */
function segChoice(opts: readonly { value: string; label: string }[], current: string | undefined, onPick: (v: string) => void): HTMLElement {
  const seg = document.createElement('div'); seg.className = 'bp-seg bp-sseg';
  for (const o of opts) {
    const b = document.createElement('button'); b.textContent = o.label;
    if (o.value === current) b.classList.add('on');
    b.addEventListener('mousedown', (e) => { e.stopPropagation(); onPick(o.value); });
    seg.appendChild(b);
  }
  return seg;
}

/** A −/+ number stepper around a numeric input — shared by the transparency control and the height
 *  control. The steppers + commit read the LIVE input value (`current()`), so a typed-but-not-yet-Entered
 *  value is respected (type "55" then click + ⇒ 65, not old+10). `commit` receives the clamped result. */
function stepper(opts: { value: number; min: number; max?: number; step: number; title: string; suffix?: string; commit: (v: number) => void }): HTMLElement {
  const { value, min, max = Infinity, step, title, suffix = '', commit } = opts;
  const clamp = (n: number): number => Math.max(min, Math.min(max, n));
  const box = document.createElement('div'); box.className = 'bp-hbox';
  const inp = document.createElement('input'); inp.className = 'bp-hpx'; inp.type = 'number';
  inp.min = String(min); if (max !== Infinity) inp.max = String(max);
  inp.value = String(value); inp.title = title;
  inp.addEventListener('mousedown', (e) => e.stopPropagation());
  const current = (): number => { const v = parseInt(inp.value, 10); return isNaN(v) ? value : v; };
  const apply = (v: number): void => commit(clamp(v));
  inp.addEventListener('change', () => apply(current()));
  inp.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Enter') { e.preventDefault(); apply(current()); } e.stopPropagation(); });
  const step1 = (dir: -1 | 1): HTMLButtonElement => {
    const b = document.createElement('button'); b.className = 'bp-hstep'; setIcon(b, dir < 0 ? ICON_MINUS : ICON_PLUS);
    b.title = `${dir < 0 ? '−' : '+'}${step}${suffix}`;
    b.addEventListener('mousedown', (e) => { e.stopPropagation(); apply(current() + dir * step); });
    return b;
  };
  box.append(step1(-1), inp, step1(1));
  return box;
}

/** Transparency stepper: −/+ 10 around a 0–100 number input (BMP `transparency`, 0 = opaque). */
function transpControl(node: LNode, val: number): HTMLElement {
  return stepper({ value: val, min: 0, max: 100, step: 10, title: 'Transparency (0 = opaque, 100 = clear)',
    commit: (v) => setNodeStyle(node.id, { transparency: v }) });
}

/** The colour swatch popup (style mode) — searchable, folder-grouped CorpoColors over the shared
 *  `renderSwatchGrid`, themed for the overlay. Picking links the colour to the open slot; "None" clears
 *  it. Filter is popup-local; folder-open state lives in `bp.swatchExpanded` (reset on teardown). */
function swatchPopup(byRid: Map<string, Element>): HTMLElement {
  const sw = bp.swatch!;
  const m = model();
  const node = m ? findNode(m, sw.nodeId)?.node ?? null : null;
  const back = document.createElement('div'); back.className = 'bp-pick-back';
  back.addEventListener('mousedown', (e) => { if (e.target === back) closeSwatch(); });
  const panel = document.createElement('div'); panel.className = 'bp-pick bp-swatch-pop';
  const rect = resultAnchor(sw.nodeId) ?? (node ? anchorRect(node, byRid) : null);
  if (rect) {
    panel.style.left = `${Math.max(4, Math.min(rect.left, window.innerWidth - 320))}px`;
    panel.style.top = `${Math.max(40, Math.min(rect.top + 24, window.innerHeight - 440))}px`;
  } else { panel.style.left = '50%'; panel.style.top = '80px'; panel.style.transform = 'translateX(-50%)'; }
  const head = document.createElement('div'); head.className = 'bp-pick-h';
  head.textContent = `${sw.prop === 'headerColor' ? 'Header' : 'Font'} colour`;
  const search = document.createElement('input'); search.className = 'bp-pick-s'; search.placeholder = 'Search colours…';
  const host = document.createElement('div'); host.className = 'bp-swatch-host';
  const curBid = (sw.prop === 'headerColor' ? node?.style?.headerColorBid : node?.style?.fontColorBid) || null;
  let q = '';
  const paint = (): void => {
    host.textContent = '';
    host.appendChild(renderSwatchGrid({
      sets: colorSets(), q, currentBid: curBid, includeBasics: true,
      expanded: bp.swatchExpanded,
      onToggle: (label) => { if (bp.swatchExpanded.has(label)) bp.swatchExpanded.delete(label); else bp.swatchExpanded.add(label); paint(); },
      onPick: (bidName) => applySwatch(colorLinkBid(bidName)),
      onClear: () => applySwatch(''),
    }));
  };
  search.addEventListener('mousedown', (e) => e.stopPropagation());
  search.addEventListener('input', () => { q = search.value; paint(); });
  paint();
  panel.append(head, search, host);
  back.appendChild(panel);
  setTimeout(() => search.focus(), 0);
  return back;
}

/** Height control: an EXACT pixel-height stepper. Seeds from the authored height, falling back to the
 *  cell's current rendered height (`r`); −/+ nudge 10px. setH re-renders (rebuilding this). */
function heightControl(node: LNode, r: Rect): HTMLElement {
  return stepper({ value: Math.round(node.height ?? r.height), min: 20, step: 10, suffix: 'px',
    title: 'Height in pixels', commit: (v) => setH(node.id, v) });
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

/** Tab-strip right-click menu — reorder the tab within the strip. Anchored at the cursor; a backdrop
 *  click dismisses. Tab order IS the tabs' sibling order under the tabset, so each item compiles to a
 *  moveAfter/moveBefore (see reorderTab). Directions that are no-ops (already first/last among the
 *  reorderable tabs) are disabled, so the menu is honest about what it can do. */
function tabContextMenu(menu: { id: string; x: number; y: number }): HTMLElement {
  const m = model();
  if (!m) return document.createElement('div'); // session torn down between open and paint — no menu
  const order = m.tabs.filter(t => !isResultTab(t));
  const i = order.findIndex(t => t.id === menu.id);
  const name = findNode(m, menu.id)?.node.name ?? '';
  const back = document.createElement('div'); back.className = 'bp-pick-back';
  back.addEventListener('mousedown', (e) => { if (e.target === back) closeTabMenu(); });
  const panel = document.createElement('div'); panel.className = 'bp-pick bp-tabmenu';
  panel.style.left = `${Math.min(Math.max(4, menu.x), window.innerWidth - 220)}px`;
  panel.style.top = `${Math.min(Math.max(40, menu.y), window.innerHeight - 200)}px`;
  const head = document.createElement('div'); head.className = 'bp-pick-h'; head.textContent = `Move "${name}"`;
  const list = document.createElement('div'); list.className = 'bp-pick-list';
  const atStart = i <= 0, atEnd = i === order.length - 1;
  const item = (label: string, dir: 'left' | 'right' | 'start' | 'end', disabled: boolean): void => {
    const b = document.createElement('button'); b.className = 'bp-pick-it'; b.textContent = label;
    if (disabled) b.disabled = true;
    else b.addEventListener('mousedown', (e) => { e.stopPropagation(); reorderTab(menu.id, dir); });
    list.appendChild(b);
  };
  item('Move left', 'left', atStart);
  item('Move right', 'right', atEnd);
  item('Move to start', 'start', atStart);
  item('Move to end', 'end', atEnd);
  panel.append(head, list);
  back.appendChild(panel);
  return back;
}

// ── header tab bar (manage tabs + switch which one the canvas shows) ──────────────
/** The tab strip under the chip. Each pill switches the canvas to that tab (click), renames (pencil),
 *  and deletes (✕); it's also a cross-tab move drop-target (data-bpkind=tab). Rendered from the
 *  BASELINE tabs so a staged delete stays visible (struck), with staged-new tabs appended. The pill
 *  for BMP's live (on-screen) tab carries a dot; the currently-viewed tab is highlighted. */
function tabBar(base: LModel, m: LModel, liveId: string | null, viewedId: string | null): HTMLElement {
  const bar = document.createElement('div'); bar.className = 'bp-tabs';
  const lbl = document.createElement('span'); lbl.className = 'bp-tabs-l'; lbl.textContent = 'TABS'; bar.appendChild(lbl);
  // A tab is USED when it holds a widget on THIS page — in the baseline or after staged edits
  // (moving a widget onto an empty tab makes it used immediately). BMP's portal shows only used
  // tabs, so a big shared tabset (Risk Register's has ~25 tabs, 2 used) would otherwise drown the
  // strip: lead with the used pills and fold the empty rest behind a "+N empty" expander. A changed
  // (renamed/deleted), viewed, or live tab always stays visible — folding it would hide an edit.
  // "Used" = holds a VISIBLE widget. A tab whose widgets are all hidden is folded
  // like an empty one, because BMP hides it on the web all the same (verified live).
  // It stays in the model (only the strip folds), so opening it still shows its ghost
  // tray to un-hide the widgets.
  const used = new Set<string>();
  for (const t of [...base.tabs, ...m.tabs]) if (descendantVisibleWidgets(t).length) used.add(t.id);
  // Order the pills by the DESIRED (model) order so a staged reorder shows in the strip at once, with
  // deleted tabs (in the baseline, gone from the model) appended as struck 'gone' pills so Undo can
  // restore them. Rendering from base.tabs would pin the strip in baseline order and hide the very
  // reorder the user just made.
  type TabRow = { node: LNode | null; id: string; name: string; state: 'same' | 'renamed' | 'gone' | 'new' };
  const baseName = new Map(base.tabs.map(b => [b.id, b.name]));
  const inModel = new Set(m.tabs.map(t => t.id));
  const rows: TabRow[] = m.tabs.map(mt => {
    const bn = baseName.get(mt.id);
    return { node: mt, id: mt.id, name: mt.name, state: bn === undefined ? 'new' : (mt.name !== bn ? 'renamed' : 'same') };
  });
  for (const bt of base.tabs) if (!inModel.has(bt.id)) rows.push({ node: null, id: bt.id, name: bt.name, state: 'gone' });
  const folded: HTMLElement[] = [];
  for (const r of rows) {
    const pill = tabPill(r.id, r.name, r.state, r.id === viewedId, r.id === liveId);
    if (r.state === 'same' && !used.has(r.id) && r.id !== viewedId && r.id !== liveId) {
      pill.classList.add('unused');
      pill.title = r.node && descendantWidgets(r.node).length > 0
        ? 'Every widget on this tab is hidden, so BMP hides the tab. Click to view; show a widget (eye / S·M·L) to bring it back.'
        : 'Empty on this page, so BMP hides it. Click to view; add or move a widget here to use it.';
      folded.push(pill);
    } else {
      bar.appendChild(pill);
    }
  }
  if (folded.length) {
    if (bp.unusedTabsOpen) {
      for (const p of folded) bar.appendChild(p);
      const less = mkBtn('− hide', () => { bp.unusedTabsOpen = false; render(); });
      less.className = 'bp-tabs-fold';
      less.title = 'Collapse the hidden tabs again';
      bar.appendChild(less);
    } else {
      const more = mkBtn(`+${folded.length} hidden`, () => { bp.unusedTabsOpen = true; render(); });
      more.className = 'bp-tabs-fold';
      more.title = `${folded.length} tab${folded.length === 1 ? '' : 's'} of this tabset ${folded.length === 1 ? 'is' : 'are'} not shown on this page (empty, or every widget hidden), so BMP hides ${folded.length === 1 ? 'it' : 'them'}. Expand to view or edit ${folded.length === 1 ? 'it' : 'them'}.`;
      bar.appendChild(more);
    }
  }
  if (m.resultOnly) {
    // No dedicated tabset: adding a plain tab would hit the shared default_tabset. Offer to create a
    // tabset of the page's own instead (one click — names it after the page; the Tab can be renamed).
    const b = mkBtn('+ Create tabset', () => doCreateTabset());
    b.title = 'This page has no tabset of its own. Create one to organise its widgets into tabs. It is created together with your other changes when you Apply.';
    bar.appendChild(b);
  } else {
    bar.appendChild(mkBtn('+ Tab', addTabAction)); // plain "+ Tab" text (no icon — the icon mis-aligned)
  }
  return bar;
}

function tabPill(id: string, name: string, state: 'same' | 'renamed' | 'gone' | 'new', viewed: boolean, live: boolean): HTMLElement {
  const gone = state === 'gone';
  const pill = document.createElement('div');
  pill.className = `bp-tab st-${state}` + (viewed ? ' sel' : '') + (live ? ' live' : '');
  const shared = isResultTab({ kind: 'tab', id }); // the shared Result tab — view + edit its widgets, but
  pill.dataset.bpid = id; pill.dataset.bpkind = 'tab'; // drop target for cross-tab moves
  pill.title = gone ? 'Deleted. Use Undo to restore it.'
    : shared ? 'The shared Result tab. Its widgets are editable, but the tab itself is shared across scorecards, so rename and delete are disabled.'
    : 'Show this tab in the canvas';
  if (shared) pill.classList.add('shared');
  // click switches the tab — but NOT when clicking into the open rename field (that would navigate away).
  // Left-button only: a right-click's mousedown (button 2) precedes `contextmenu`, and viewTab can
  // dispatch synthetic clicks that switch BMP's live tab — so an unguarded handler would navigate the
  // page when you only meant to open the reorder menu.
  if (!gone) pill.addEventListener('mousedown', (e) => { if (e.button !== 0 || (e.target as HTMLElement).isContentEditable) return; e.stopPropagation(); viewTab(id); });
  // Right-click a real (non-shared) tab to reorder it in the strip. The shared Result tab is pinned.
  if (!gone && !shared) pill.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); openTabMenu(id, e.clientX, e.clientY); });
  if (live) { const d = document.createElement('span'); d.className = 'bp-tlive'; d.title = 'On screen in BMP'; pill.appendChild(d); }
  if (state === 'new') { const t = document.createElement('span'); t.className = 'newtag'; t.textContent = 'NEW'; pill.appendChild(t); }
  const nm = document.createElement('span'); nm.className = 'bp-tnm'; nm.textContent = name; pill.appendChild(nm);
  if (shared) { const lk = document.createElement('span'); lk.className = 'bp-tshared'; setIcon(lk, ICON_LINK); lk.title = 'Shared across scorecards'; pill.appendChild(lk); }
  // the Result tab can't be renamed or deleted (that edits the shared default_tabset) — omit its controls.
  // preventDefault on these buttons stops the default mousedown focus-grab, which would otherwise steal
  // focus from the rename field inlineRename just opened (the "click Rename, nothing happens" bug).
  if (!gone && !shared) {
    const edit = document.createElement('button'); edit.className = 'bp-tedit'; setIcon(edit, ICON_PENCIL); edit.title = `Rename "${name}"`;
    // Pending-rename flow (bp.renameId), not a direct inlineRename on `nm`: an outside-click commit of
    // an already-open rename re-renders first, which would detach this pill's span mid-handler.
    edit.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); bp.renameId = id; render(); });
    pill.appendChild(edit);
    const del = document.createElement('button'); del.className = 'bp-tdel'; setIcon(del, ICON_X); del.title = `Delete tab "${name}" and its contents`;
    del.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); doDelete(id); });
    pill.appendChild(del);
  }
  return pill;
}

// ── inline rename (view-level: edits the rendered name span in place, then commits) ──────────────
/** Open a pending inline-rename (flagged by beginRename or a tab pill's pencil) once the target has
 *  been freshly rendered. Called at the end of every render. The editable span is the tab pill's
 *  `.bp-tnm` (matched by id), else the selected result-cell `.bp-rnm` / live box `.bp-nm`. */
function openPendingRename(): void {
  if (!bp.renameId || !bp.layer) return;
  const id = bp.renameId; bp.renameId = null;
  const nm = bp.layer.querySelector(`.bp-tab[data-bpid="${CSS.escape(id)}"] .bp-tnm`)
    ?? bp.layer.querySelector('.bp-rcell.sel .bp-rnm, .bp-box.sel .bp-nm');
  inlineRename(id, nm as HTMLElement | null);
}
function inlineRename(id: string, nm: HTMLElement | null): void {
  if (!nm || !nm.isConnected) return;
  nm.setAttribute('contenteditable', 'true');
  nm.focus();
  bp.renaming = true; // freeze re-render: a render() would textContent='' the layer and destroy this field
  const range = document.createRange(); range.selectNodeContents(nm);
  const sel = getSelection(); sel?.removeAllRanges(); sel?.addRange(range);
  let cancelled = false;
  // Commit on the FIRST mousedown outside the field, BEFORE the clicked control's own handler runs.
  // Every overlay button preventDefault()s its mousedown (to protect this very field), so no native
  // blur would fire — without this, an edit made mid-rename mutated the model behind a frozen render
  // and only appeared when the field finally closed ("buffered" edits). Capture phase guarantees the
  // commit (+ its render) lands first; the original event then still reaches the clicked control.
  const outside = (e: MouseEvent): void => {
    if (!nm.isConnected) { document.removeEventListener('mousedown', outside, true); return; } // overlay torn down mid-rename
    if (e.target !== nm && !nm.contains(e.target as Node)) nm.blur();
  };
  document.addEventListener('mousedown', outside, true);
  nm.addEventListener('blur', () => {
    document.removeEventListener('mousedown', outside, true);
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
