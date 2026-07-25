/**
 * Blueprint controller — every edit gesture as a `bp` mutation followed by a re-render. Each action
 * runs a PURE layout op (`edit.ts`), pushes the result onto history, and re-renders; the model is
 * the single source of truth, the DOM just reflects it.
 *
 * Imports `render` from view.ts — a deliberate, runtime-safe controller↔view cycle: view wires these
 * actions onto button handlers, and these call render() at click time. All cross-calls happen inside
 * functions (never at module-init), so ESM resolves the cycle cleanly.
 */
import { findNode, isTempId, isResultTab } from '../lib/layout/model';
import { bandInsertIndex } from '../lib/layout/placement';
import { resize, setHeight, rename, remove, restoreNode, addWidget, addContainer, moveInto, swap, insertRelative, addTab, createTabset, toggleReset, setStyle } from '../lib/layout/edit';
import { diff, summarizeChanges } from '../lib/layout/diff';
import { addFlowChild, reorderFlowChild, removeFlowAdd, setActionFlag, addActionButton, flowDiff, flowChangeCount, stageNewFlowContainer, wireFlowRef, unwireFlowRef, renameFlowObject } from '../lib/layout/flow';
import { compile } from '../lib/layout/ec';
import { History } from '../lib/layout/history';
import { maskStyle, type LModel, type PlanStep, type NodeStyle } from '../lib/layout/types';
import { sendToSW } from '../lib/content-port';
import { showToast } from '../lib/toast';
import { bp, model } from './state';
import { render } from './view';
import { applyPage, fetchBlast, fetchFlowRefs, fetchFlowRefChildren, fetchEditPageSchemas } from './service';
import { ensureColorSets } from './colors';
import { loadPresets, savePreset, deletePreset } from './presets';
import { PAINT_STYLE_PROPS } from '../lib/style-props';
import type { StylePreset } from '../lib/style-presets';

/** Push a new model state onto history and re-render. The one write path for staged edits. Flags the
 *  next render to FLIP-animate cells from their old to new positions (so moves/reorders read as motion). */
export function mutate(next: LModel): void { bp.history?.push(next); bp.flipNext = true; render(); }

export function select(id: string | null): void { bp.selectedId = id; bp.swatch = null; render(); }
export function selectEditPageField(id: string, types: readonly string[]): void {
  bp.selectedId = id;
  bp.swatch = null;
  void fetchEditPageSchemas(types);
  render();
}
/** Begin renaming a node: select it and flag the next render to open its inline-rename field. The one
 *  entry point — used by BOTH double-click on a cell name and the toolbar pencil. */
export function beginRename(id: string): void { bp.selectedId = id; bp.renameId = id; render(); }
export function viewEditPage(id: string): void { bp.viewTabId = id; render(); }
/** Header tab-bar click = switch the REAL tab, same as BMP's own tab strip (not a separate "peek").
 *  Click BMP's matching native tab so it navigates; our MutationObserver then follows it. Falls back to
 *  a canvas-only view (viewTabId) when there's no live BMP tab to drive (e.g. an unmodeled page). */
export function viewTab(id: string): void {
  const m = model();
  const tab = m?.tabs.find(t => t.id === id);
  if (tab) {
    // Match BMP's native tab by the BASELINE name — the DOM still shows the original text, so a STAGED
    // rename (tab.name in the edited model) wouldn't match and we'd silently fall back to a canvas-only
    // view (the live/canvas divergence liveModelTabId exists to avoid).
    const domName = findNode(bp.baseline ?? m!, id)?.node.name ?? tab.name;
    const native = [...document.querySelectorAll('.corpo-tabSet__tab')].find(t => t.textContent?.trim() === domName);
    if (native) {
      const el = (native.querySelector('a') as HTMLElement) ?? (native as HTMLElement);
      for (const ev of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'] as const) {
        el.dispatchEvent(ev.startsWith('pointer')
          ? new PointerEvent(ev, { bubbles: true, cancelable: true, view: window, pointerId: 1 })
          : new MouseEvent(ev, { bubbles: true, cancelable: true, view: window, button: 0 }));
      }
      bp.viewTabId = null; // follow the live tab the observer will pick up
      return;
    }
  }
  bp.viewTabId = id; bp.selectedId = id; render();
}
export function setWidth(id: string, n: number): void { const m = model(); if (m) mutate(resize(m, id, 'L', n)); }
/** F2: stage/unstage a reset of one overridden property back to the template (the blue revert arrow). */
export function toggleResetProp(id: string, prop: string): void { const m = model(); if (m) mutate(toggleReset(m, id, prop)); }
export function setH(id: string, px: number): void { const m = model(); if (m) mutate(setHeight(m, id, px)); }
/** G3: stage a style edit on a node (style mode). Patch values are concrete — a colour bid ('' clears
 *  the link), a boolean/number/enum-string. Goes through history like any edit (undo/redo). */
export function setNodeStyle(id: string, patch: Partial<NodeStyle>): void { const m = model(); if (m) mutate(setStyle(m, id, patch)); }
/** Open the colour swatch popup for a node's headerColor/fontColor slot (style mode). */
/** G3: switch between LAYOUT editing (cols/move/rename) and STYLE editing (colours/shadow/border). A pure
 *  client-side render switch over the SAME loaded model — no refetch — so it's instant and keeps staged
 *  edits. Closes any transient per-cell UI (a swatch/picker/move popup left open in the other mode). */
export function setMode(mode: 'layout' | 'style'): void {
  if (!bp.active || bp.mode === mode) return;
  bp.mode = mode;
  bp.swatch = null; bp.picker = null; bp.pickerOpts = null; bp.movePicker = null; bp.tabMenu = null; // don't leave a popup hanging across modes
  bp.brush.mode = 'off'; bp.paintPanel = null; // disarm the paintbrush when leaving/entering style mode
  if (mode === 'style') void ensureColorSets(); // lazy-load colours so cells can tint (re-renders on arrival)
  render();
}
export function openSwatch(nodeId: string, prop: 'headerColor' | 'fontColor'): void { bp.swatch = { nodeId, prop }; render(); }
export function closeSwatch(): void { if (bp.swatch) { bp.swatch = null; render(); } }
/** Pick (or clear, bid='') the open swatch popup's colour: stage the style edit on its target slot and
 *  close the popup in one render. */
export function applySwatch(bid: string): void {
  const s = bp.swatch, m = model();
  if (!s || !m) return;
  const field = s.prop === 'headerColor' ? 'headerColorBid' : 'fontColorBid';
  bp.swatch = null;
  mutate(setStyle(m, s.nodeId, { [field]: bid }));
}

// ── G4 paintbrush ─────────────────────────────────────────────────────────────
/** Arm PICK (the eyedropper) — the next widget click samples its style. Clicking Pick again disarms.
 *  Pick always re-samples, so it doubles as "load a different style". */
export function armPick(): void { bp.brush.mode = bp.brush.mode === 'pick' ? 'off' : 'pick'; bp.paintPanel = null; render(); }
/** Arm PAINT (the brush) — canvas clicks apply the held style. No-op without a held style. */
export function armPaint(): void {
  if (!bp.brush.held) return;
  bp.brush.mode = bp.brush.mode === 'paint' ? 'off' : 'paint';
  bp.paintPanel = null; render();
}
export function disarmBrush(): void { if (bp.brush.mode !== 'off') { bp.brush.mode = 'off'; render(); } }

/** A canvas cell was clicked while the brush is armed. In PICK mode → capture its style and advance to
 *  PAINT (so the flow is sample → then paint); in PAINT mode → apply the held style. Widgets only —
 *  containers/tabs carry no appearance props (same gate as the style toolbar), so a click is ignored. */
export function brushOnCell(id: string): void {
  const m = model(); if (!m) return;
  const node = findNode(m, id)?.node;
  if (!node || node.kind !== 'widget') return;
  if (bp.brush.mode === 'pick') {
    bp.brush.held = node.style ? { ...node.style } : {}; // {} = an unstyled source (paints = reset to default)
    bp.brush.mode = 'paint'; // sampled → ready to paint
    render();
  } else if (bp.brush.mode === 'paint') {
    const masked = maskStyle(bp.brush.held!, bp.brushMask);
    // Trait guard: the flag props (tools menu / search) only exist on types that carry the trait — the
    // target's fetched style omits the key when it doesn't. Don't paint a flag onto a trait-less widget
    // (BMP would reject the write); silently skip it, matching how the Style toolbar hides the toggle.
    for (const k of ['showToolMenu', 'disableSearch'] as const) {
      if (masked[k] !== undefined && node.style?.[k] === undefined) delete masked[k];
    }
    mutate(setStyle(m, id, masked)); // mutate re-renders; stays in paint mode
  }
}

/** Toggle one prop in the brush's copy-set (the Setup popup). */
export function setBrushMaskProp(prop: string, on: boolean): void {
  if (on) bp.brushMask.add(prop); else bp.brushMask.delete(prop);
  render();
}
export function setBrushMaskAll(on: boolean): void {
  bp.brushMask = new Set(on ? PAINT_STYLE_PROPS : []);
  render();
}

/** Open a paint-station popup (setup mask / the save+library menu). `library` fetches the presets. */
export function openPaintPanel(which: 'setup' | 'library'): void {
  bp.paintPanel = which;
  render();
  if (which === 'library') void loadPresets();
}
export function closePaintPanel(): void { if (bp.paintPanel) { bp.paintPanel = null; render(); } }

/** Save the held style as a named preset (stays in the library menu so you can keep working). No-op
 *  without a held style/name. */
export function doSavePreset(name: string): void {
  const held = bp.brush.held;
  if (!held || !name.trim()) return;
  void savePreset(name.trim(), held);
}
/** Load a preset into the brush → paint mode; close the library menu. */
export function doLoadPreset(preset: StylePreset): void {
  bp.brush.held = { ...preset.style };
  bp.brush.mode = 'paint';
  bp.paintPanel = null;
  render();
}
export function doDeletePreset(id: string): void { void deletePreset(id); }
export function doRename(id: string, name: string): void {
  const m = model(); if (!m) return;
  const cur = findNode(m, id)?.node;
  const next = name.trim();
  if (cur) {
    // Trim, reject an empty name, and skip a no-op (same name, or opened-then-closed) so neither commits
    // a phantom edit / pushes a history entry you'd have to undo through — just re-render to close the field.
    if (next === '' || next === cur.name) { render(); return; }
    mutate(rename(m, id, next)); return;
  }
  // Not in the layout tree → a FLOW object (child / container / reference / staged-new): reuse the SAME
  // inline-rename machinery, routed to the flow rename staging. null = no-op (empty / unchanged).
  const r = renameFlowObject(m, id, next);
  if (r) mutate(r); else render();
}
export function doDelete(id: string): void { const m = model(); if (m) { bp.selectedId = null; mutate(remove(m, id)); } }

/** Open the add picker for a tab/container. `opts.afterId` inserts the new widget right after that
 *  sibling (else appends); `opts.cols` sizes it to a detected free-column gap (else full width). */
export function openPicker(containerId: string, opts?: { afterId?: string; cols?: number; at?: { x: number; y: number } }): void {
  bp.picker = containerId; bp.pickerOpts = opts ?? null; bp.selectedId = null; render();
}
export function closePicker(): void { bp.picker = null; bp.pickerOpts = null; render(); }
export function addFromPicker(className: string): void {
  const m = model(); const cid = bp.picker;
  if (!m || !cid) return;
  const f = findNode(m, cid);
  const kids = f ? f.node.children : m.tabs;
  // Band-correct insertion: after the gap's anchor when that slot is band-legal, else the nearest
  // position BMP can actually render it at (widgets always flow after all containers).
  const { index, remapped } = bandInsertIndex(kids, bp.pickerOpts?.afterId, 'widget');
  if (remapped) showToast('Widgets render after all containers, so it was added at the start of the widget flow', 'info');
  const added = addWidget(m, cid, index, className, undefined, bp.pickerOpts?.cols ?? 6);
  bp.picker = null; bp.pickerOpts = null;
  bp.selectedId = added.id;
  mutate(added.model);
}

export function addTabAction(): void { const m = model(); if (m) { const r = addTab(m, m.tabs.length, 'New Tab'); bp.selectedId = r.id; mutate(r.model); } }

// ── flow editing (blueprint flow layer) ────────────────────────────────────────
/** Open the flow add picker for a flow container (InputSet/EditPage/ButtonGroup referenced by a flow
 *  widget). These live OUTSIDE the layout tree, so bp.picker can't address them — flowPicker carries
 *  the container key + className (palette) instead. */
export function openFlowPicker(key: string, className: string, opts?: { afterId?: string; at?: { x: number; y: number }; isAction?: boolean }): void {
  bp.flowPicker = { key, className, ...opts };
  bp.picker = null; bp.pickerOpts = null; bp.selectedId = null;
  render();
}
export function closeFlowPicker(): void { if (bp.flowPicker) { bp.flowPicker = null; bp.flowRefList = null; render(); } }
/** Stage a new flow child from the open flow picker (type + name auto — no property forms). */
export function addFlowFromPicker(className: string): void {
  const m = model(); const p = bp.flowPicker;
  if (!m || !p) return;
  bp.flowPicker = null;
  mutate(addFlowChild(m, p.key, className, undefined, p.afterId).model);
}
/** Tray "Add action": stage a new page-level menu button (born displayOnActionMenu, bound to the
 *  viewed tab — RESULT when the page renders its buttons through the shared Result tab). */
export function addActionFromTray(name: string, tabContainer: string): void {
  const m = model(); if (!m) return;
  bp.flowPicker = null;
  mutate(addActionButton(m, tabContainer, name).model);
}
/** Drop of a flow-row drag: stage the reorder within its container (moveBefore/moveAfter on apply). */
export function doFlowReorder(key: string, id: string, afterId: string | null): void {
  const m = model(); if (!m) return;
  mutate(reorderFlowChild(m, key, id, afterId));
}
/** Cancel a STAGED flow add (the only flow "delete" — existing children aren't deletable here). */
export function cancelFlowAdd(key: string, id: string): void {
  const m = model(); if (!m) return;
  mutate(removeFlowAdd(m, key, id));
}
/** Placement control / tray toggles: stage an action-button flag flip. */
export function setActionButtonFlag(id: string, prop: 'displayOnActionMenu' | 'displayOnAllTabs', value: boolean): void {
  const m = model(); if (!m) return;
  mutate(setActionFlag(m, id, prop, value));
}
/** "+ new": stage a NEW InputSet/EditPage for a reference-less flow widget with a predictable name.
 *  Children stage underneath immediately (the empty row list renders with its Add-element row). */
export function stageNewRef(widgetId: string, prop: 'inputSet' | 'editPage'): void {
  const m = model(); if (!m) return;
  const name = prop === 'inputSet' ? 'New InputSet' : 'New EditPage';
  mutate(stageNewFlowContainer(m, widgetId, prop, name).model);
}
/** Open the "wire to existing" picker for a reference-less flow widget; the workspace list fetches at
 *  open (lean — bid/rid/class/category/name only, never in the main layout fetch). */
export function openWireExisting(widgetId: string, prop: 'inputSet' | 'editPage', at?: { x: number; y: number }): void {
  const refClass = prop === 'inputSet' ? 'InputSet' as const : 'EditPage' as const;
  bp.flowPicker = { key: widgetId, className: refClass, wireExisting: true, ...(at ? { at } : {}) };
  bp.picker = null; bp.pickerOpts = null; bp.selectedId = null;
  render();
  void fetchFlowRefs(refClass);
}
/** Wire the picker's widget to the chosen existing InputSet/EditPage. When the target isn't on this
 *  page (no projection references it), fetch its real children on demand so the cell shows the current
 *  contents instead of an "unknown contents" note (FIX 2). */
export function wireExistingFromPicker(targetId: string, targetClass: string, targetName?: string): void {
  const m = model(); const p = bp.flowPicker;
  if (!m || !p?.wireExisting) return;
  const prop = p.className === 'InputSet' ? 'inputSet' as const : 'editPage' as const;
  bp.flowPicker = null; bp.flowRefList = null;
  mutate(wireFlowRef(m, p.key, prop, targetId, targetClass, targetName));
  const onPage = Object.values(m.flows ?? {}).some(fp => fp.refId === targetId);
  if (!onPage) void fetchFlowRefChildren(targetId, targetClass);
}
/** Cancel a staged reference wire (and the staged-new container behind it, when there is one). */
export function doUnwire(widgetId: string): void {
  const m = model(); if (!m) return;
  mutate(unwireFlowRef(m, widgetId));
}
/** Fold/unfold a flow cell on its reference band (default expanded; folded set lives in bp). */
export function toggleFlowFold(ownerId: string): void {
  bp.flowFolds.has(ownerId) ? bp.flowFolds.delete(ownerId) : bp.flowFolds.add(ownerId);
  render();
}
/** Expand/collapse an ACTION tray card's inline transport list. */
export function toggleTrayCard(id: string): void {
  bp.trayCardsOpen.has(id) ? bp.trayCardsOpen.delete(id) : bp.trayCardsOpen.add(id);
  render();
}

/** Open the tab-strip right-click reorder menu, anchored at the cursor. */
export function openTabMenu(id: string, x: number, y: number): void { bp.tabMenu = { id, x, y }; render(); }
export function closeTabMenu(): void { if (bp.tabMenu) { bp.tabMenu = null; render(); } }

/** Reorder a tab in the strip. Tab order IS the tabs' sibling order under the tabset, so a move
 *  compiles to a `moveAfter`/`moveBefore` (the diff emits it; see diff.ts). Operates on the
 *  reorderable tabs only — the shared Result tab is pinned first and excluded (moving relative to it
 *  would be a cross-tabset edit). No-ops (already at the edge) just close the menu. */
export function reorderTab(id: string, dir: 'left' | 'right' | 'start' | 'end'): void {
  bp.tabMenu = null;
  const m = model();
  if (!m) { render(); return; }
  const order = m.tabs.filter(t => !isResultTab(t));
  const i = order.findIndex(t => t.id === id);
  if (i < 0) { render(); return; } // the shared Result tab isn't reorderable
  const last = order.length - 1;
  let targetId: string; let before: boolean;
  if (dir === 'left') { if (i === 0) { render(); return; } targetId = order[i - 1].id; before = true; }
  else if (dir === 'right') { if (i === last) { render(); return; } targetId = order[i + 1].id; before = false; }
  else if (dir === 'start') { if (i === 0) { render(); return; } targetId = order[0].id; before = true; }
  else { if (i === last) { render(); return; } targetId = order[last].id; before = false; }
  mutate(insertRelative(m, id, targetId, before));
}

/** Add an empty container to a tab/container (from the picker's "New container" option). Honours the
 *  picker's positional + sized intent the same way addFromPicker does: dropped into a free-column gap,
 *  the new container inherits that gap's width and lands right after the row's last cell (so adding a
 *  container beside a 3-wide widget makes a 3-wide container in the gap, not a full-width one at the end). */
export function addContainerTo(parentId: string): void {
  const m = model(); if (!m) return;
  const f = findNode(m, parentId);
  const kids = f ? f.node.children : m.tabs;
  const { index, remapped } = bandInsertIndex(kids, bp.pickerOpts?.afterId, 'container');
  if (remapped) showToast('Containers render before widgets, so it was added at the end of the container flow', 'info');
  const r = addContainer(m, parentId, index, bp.pickerOpts?.cols ?? 6);
  bp.picker = null; bp.pickerOpts = null;
  bp.selectedId = r.id;
  mutate(r.model);
}

export function openMovePicker(id: string): void { bp.movePicker = id; render(); }
export function closeMovePicker(): void { bp.movePicker = null; render(); }
export function moveTo(id: string, destId: string): void {
  const m = model(); if (!m) return;
  bp.movePicker = null;
  mutate(moveInto(m, id, destId));
}

// ── direct-manipulation drops (gestures.ts stages these on drop) ──────────────
export function doMoveInto(id: string, destId: string, fitCols?: number): void {
  const m = model(); if (!m) return;
  bp.selectedId = id;
  let next = moveInto(m, id, destId);
  if (fitCols != null) next = resize(next, id, 'L', fitCols); // dropped into a sized empty slot → fit it
  mutate(next);
}
export function doSwap(a: string, b: string): void { const m = model(); if (m) { bp.selectedId = a; mutate(swap(m, a, b)); } }
export function doInsert(id: string, targetId: string, before: boolean, fitCols?: number): void {
  const m = model(); if (!m) return;
  bp.selectedId = id;
  let next = insertRelative(m, id, targetId, before);
  if (fitCols != null) next = resize(next, id, 'L', fitCols); // dropped into a sized empty slot → fit it
  mutate(next);
}

/** Revert a single tray subject. Flow edits are removed from their staging entry; a staged layout ADD
 * is removed outright; an existing layout object is restored from the exact baseline snapshot. */
export function revertNode(id: string): void {
  const m = model(); if (!m || !bp.baseline) return;
  // Flow edits first: the id may be a flow-edit KEY (an InputSet/EditPage/button whose staged edit is
  // reverted whole) or a STAGED flow add's temp id inside one — neither exists in the layout tree.
  if (m.flowEdits) {
    if (m.flowEdits[id]) {
      const next = { ...m, flowEdits: { ...m.flowEdits } };
      // A widget entry whose wireRef points at a staged-new container cascades: dropping the wire
      // also drops the (now-orphaned) new container and its staged children.
      const wireTarget = next.flowEdits[id].wireRef?.targetId;
      delete next.flowEdits[id];
      if (wireTarget && wireTarget.includes(':') && next.flowEdits[wireTarget]?.newContainer) delete next.flowEdits[wireTarget];
      if (!Object.keys(next.flowEdits).length) delete (next as { flowEdits?: unknown }).flowEdits;
      mutate(next);
      return;
    }
    for (const [key, e] of Object.entries(m.flowEdits)) {
      if (e.adds?.some(a => a.id === id)) { mutate(removeFlowAdd(m, key, id)); return; }
    }
  }
  const base = findNode(bp.baseline, id);
  if (!base) { if (bp.selectedId === id) bp.selectedId = null; mutate(remove(m, id)); return; }
  mutate(restoreNode(m, bp.baseline, id));
}

export function setHint(text: string | null): void { if (bp.hint !== text) { bp.hint = text; render(); } }
export function toggleTray(): void { bp.trayOpen = !bp.trayOpen; render(); }
export function toggleActionMenu(): void { bp.actionMenuOpen = !bp.actionMenuOpen; render(); }
/** Sticky peek toggle — keep the overlay faded so the live widgets stay visible (hover gives a transient
 *  peek; this click keeps it on). The faded state is a class on the layer; render() keeps it in sync. */
export function togglePeek(): void { bp.peek = !bp.peek; bp.layer?.classList.toggle('bp-peek', bp.peek); render(); }


/** A self-clearing hint-bar message for actions with no spatial gesture of their own (undo/redo).
 *  The timer only clears its OWN text, so a later gesture hint isn't clobbered. The caller renders. */
let hintTimer: ReturnType<typeof setTimeout> | undefined;
/** Cancel a pending flashHint timer — called on teardown so its deferred render() closure can't fire
 *  after the session is gone. */
export function clearHintTimer(): void { if (hintTimer) { clearTimeout(hintTimer); hintTimer = undefined; } }
function flashHint(text: string): void {
  bp.hint = text;
  if (hintTimer) clearTimeout(hintTimer);
  hintTimer = setTimeout(() => { if (bp.hint === text) { bp.hint = null; render(); } }, 1400);
}

/** Count of staged changes vs baseline — so undo/redo can confirm where the model now stands. Flow
 *  edits (keyed per flow object) count one each on top of the layout changes. */
function pendingLabel(m: LModel): string {
  const n = (bp.baseline ? summarizeChanges(diff(bp.baseline, m), m).changes : 0) + flowChangeCount(m);
  return n === 0 ? 'back to original' : `${n} pending change${n === 1 ? '' : 's'}`;
}

export function undo(): void {
  const m = bp.history?.undo();
  if (!m) { flashHint('Nothing to undo'); render(); return; }
  bp.selectedId = null;
  flashHint(`Undo · ${pendingLabel(m)}`);
  render();
}
export function redo(): void {
  const m = bp.history?.redo();
  if (!m) { flashHint('Nothing to redo'); render(); return; }
  bp.selectedId = null;
  flashHint(`Redo · ${pendingLabel(m)}`);
  render();
}
export function discard(): void { disarmDiscard(); if (bp.baseline) { bp.history = new History(bp.baseline); bp.selectedId = null; render(); } }

/** Two-step Discard confirm (non-intrusive: the SAME button just changes label). First click ARMS it —
 *  the button reads "Sure?" for a few seconds; a second click within that window actually discards. It
 *  auto-disarms on the timer so a stray arm never lingers. */
export function armDiscard(): void {
  if (bp.discardTimer) clearTimeout(bp.discardTimer);
  bp.discardArm = true;
  bp.discardTimer = window.setTimeout(() => { bp.discardArm = false; bp.discardTimer = 0; render(); }, 3500);
  render();
}
export function disarmDiscard(): void {
  if (bp.discardTimer) { clearTimeout(bp.discardTimer); bp.discardTimer = 0; }
  bp.discardArm = false;
}

/** EXISTING containers the plan structurally touches (resize/rename/move/delete) — the shared cells
 *  whose blast radius the preview checks. Returns {id, rid} so the shell can address a businessId-less
 *  container by lookup(rid). New (temp-id) containers are skipped (not shared yet); tab/widget edits
 *  too (only containers reverse-resolve via rref(container)). */
function touchedContainers(plan: PlanStep[], m: LModel): { id: string; rid?: string }[] {
  const out = new Map<string, { id: string; rid?: string }>();
  for (const s of plan) {
    // creates aren't shared yet; flow steps touch InputSets/EditPages, not layout containers
    if (s.kind === 'create' || s.kind === 'flowCreate' || s.kind === 'flowReorder' || s.kind === 'flowFlag' || s.kind === 'flowRename') continue;
    const node = findNode(m, s.id)?.node;
    const kind = s.kind === 'reparent' || s.kind === 'delete' ? s.nodeKind : node?.kind;
    if (kind === 'container' && !isTempId(s.id)) out.set(s.id, { id: s.id, rid: node?.rid });
  }
  return [...out.values()];
}

/** Are there unsaved staged edits (layout or flow)? Staged edits live only in memory (the History +
 *  the working model), so an accidental Ctrl+R or in-portal navigation discards the whole session. This
 *  drives the beforeunload guard in the blueprint lifecycle. */
export function hasPendingEdits(): boolean {
  const m = model();
  if (!bp.baseline || !m) return false;
  return diff(bp.baseline, m).length > 0 || flowChangeCount(m) > 0;
}

/** Apply opens a preview first — never commit blind. The plan is computed with the SAME diff+compile
 *  the SW will run, so the human-readable notes match exactly what gets executed. */
export function openApplyPreview(): void {
  const m = model();
  if (!bp.ctx || !bp.baseline || !m || bp.applying) return;
  // Layout + flow steps compose into the ONE plan — the same composition applyModel (SW-side) runs,
  // so the previewed EC matches the committed EC exactly.
  const plan = [...diff(bp.baseline, m), ...flowDiff(bp.baseline, m)];
  if (plan.length === 0) { showToast('Blueprint: nothing to apply', 'info'); return; }
  const { script, notes } = compile(plan, m);
  bp.preview = notes;
  bp.previewScript = script; // the modal's "Copy EC" copies the whole program, not per-row fragments
  bp.blast = null;
  bp.blastPending = true; // Confirm waits for the impact probe — the shared-master / fan-out warning
                          // is the most consequential one and must not be skippable by a fast click.
  const seq = ++bp.blastSeq; // invalidates any in-flight probe from an earlier preview
  render();
  // Async: the modal renders now with Confirm disabled ("Checking impact…"); fetchBlast clears
  // `blastPending` (and fills the fan-out / shared-structure warnings) when the rref walk returns —
  // or fails, so a dead probe can't wedge Confirm shut.
  void fetchBlast(seq, bp.ctx.pageId, touchedContainers(plan, m));
}
export function closePreview(): void { bp.preview = null; bp.previewScript = ''; bp.blast = null; bp.blastPending = false; render(); }
/** Dismiss the docked stale/partial/failed outcome panel (the user has acknowledged it). */
export function dismissApplyOutcome(): void { bp.applyOutcome = null; render(); }

/** Confirmed from the preview modal — fire the guarded SW apply (service owns the round-trip). Blocked
 *  while the impact probe is still running (`blastPending`) so the fan-out / shared-structure warning
 *  always renders before a commit — the UI also disables the Confirm button in that window. */
export function confirmApply(): void {
  if (!bp.ctx || !bp.baseline || !bp.env || !model() || bp.applying || bp.blastPending) return;
  bp.preview = null;
  bp.previewScript = '';
  bp.blast = null;
  void applyPage();
}

/** Exit is an explicit close, never a toggle. MV3 can restart the worker or briefly disconnect the
 * content port; either event must not turn a close click into a no-op (or, worse, re-enable Blueprint). */
export function exitBlueprint(): void { sendToSW({ type: 'BLUEPRINT_CLOSE' }); }

/** "+ Create tabset" on a RESULT-only page: STAGE a virtual tabset with a "Main" tab and rehome the
 *  page's widgets onto it. Nothing is written yet — the tabset + tabs are created together in the Apply
 *  EC (see edit.createTabset + ec.ts). Staged like any edit, so it's undoable and previewable. */
export function doCreateTabset(): void {
  const m = model(); if (!m) return;
  const r = createTabset(m);
  bp.selectedId = r.id;
  mutate(r.model);
}

/** Keyboard: Escape backs out (modal → picker → move-menu → selection); Delete removes the selected
 *  widget; Ctrl/Cmd+Z / +Shift+Z (or +Y) undo/redo. All no-ops while typing in a field. */
export function onKeydown(e: KeyboardEvent): void {
  if (!bp.active) return;
  const t = e.target as HTMLElement | null;
  const typing = !!t && (t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'TEXTAREA');
  if (e.key === 'Escape') {
    if (typing) return;
    if (bp.preview) closePreview();
    else if (bp.paintPanel) closePaintPanel();
    else if (bp.swatch) closeSwatch();
    else if (bp.flowPicker) closeFlowPicker();
    else if (bp.picker) closePicker();
    else if (bp.movePicker) closeMovePicker();
    else if (bp.tabMenu) closeTabMenu();
    else if (bp.brush.mode !== 'off') disarmBrush();
    else if (bp.selectedId) select(null);
    else return;
    e.preventDefault();
    return;
  }
  if (typing) return;
  // While the apply-preview modal is up, the plan shown was frozen at openApplyPreview() time but
  // confirmApply re-reads the live model — so an undo here would apply a different plan than the one
  // listed. Freeze history editing until the preview is dismissed (Delete is already gated below).
  if (bp.preview) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redo(); return; }
  if ((e.key === 'Delete' || e.key === 'Backspace') && bp.selectedId && !bp.preview && !bp.picker) {
    const sel = findNode(model() ?? bp.baseline!, bp.selectedId);
    if (sel?.node.kind === 'widget') { e.preventDefault(); doDelete(bp.selectedId); }
  }
}
