/**
 * Blueprint controller — every edit gesture as a `bp` mutation followed by a re-render. Each action
 * runs a PURE layout op (`edit.ts`), pushes the result onto history, and re-renders; the model is
 * the single source of truth, the DOM just reflects it.
 *
 * Imports `render` from view.ts — a deliberate, runtime-safe controller↔view cycle: view wires these
 * actions onto button handlers, and these call render() at click time. All cross-calls happen inside
 * functions (never at module-init), so ESM resolves the cycle cleanly.
 */
import { findNode, isTempId } from '../lib/layout/model';
import { resize, setHeight, rename, remove, addWidget, addContainer, moveInto, swap, insertRelative, addTab, findTabOf } from '../lib/layout/edit';
import { diff, summarizeChanges } from '../lib/layout/diff';
import { compile } from '../lib/layout/ec';
import { History } from '../lib/layout/history';
import type { LModel, PlanStep } from '../lib/layout/types';
import { sendToSW } from '../lib/content-port';
import { showToast } from '../lib/toast';
import { bp, model } from './state';
import { render } from './view';
import { applyPage, fetchBlast, createTabset } from './service';

/** Push a new model state onto history and re-render. The one write path for staged edits. Flags the
 *  next render to FLIP-animate cells from their old to new positions (so moves/reorders read as motion). */
export function mutate(next: LModel): void { bp.history?.push(next); bp.flipNext = true; render(); }

export function select(id: string | null): void { bp.selectedId = id; render(); }
/** Show a tab in the canvas (header tab-bar click). The canvas renders one tab at a time; this picks
 *  which, independent of BMP's live tab (an inactive tab renders from estimates). */
export function viewTab(id: string): void { bp.viewTabId = id; bp.selectedId = id; render(); }
export function setWidth(id: string, n: number): void { const m = model(); if (m) mutate(resize(m, id, 'L', n)); }
export function setH(id: string, px: number): void { const m = model(); if (m) mutate(setHeight(m, id, px)); }
export function doRename(id: string, name: string): void { const m = model(); if (m) mutate(rename(m, id, name)); }
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
  const afterId = bp.pickerOpts?.afterId;
  const at = afterId ? kids.findIndex(c => c.id === afterId) : -1;
  const idx = at >= 0 ? at + 1 : kids.length;
  const added = addWidget(m, cid, idx, className, undefined, bp.pickerOpts?.cols ?? 6);
  bp.picker = null; bp.pickerOpts = null;
  bp.selectedId = added.id;
  mutate(added.model);
}

export function addTabAction(): void { const m = model(); if (m) { const r = addTab(m, m.tabs.length, 'New Tab'); bp.selectedId = r.id; mutate(r.model); } }

/** Add an empty container to a tab/container (from the picker's "New container" option). */
export function addContainerTo(parentId: string): void {
  const m = model(); if (!m) return;
  const f = findNode(m, parentId);
  const idx = f ? f.node.children.length : 0;
  const r = addContainer(m, parentId, idx);
  bp.picker = null;
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
export function doInsert(id: string, targetId: string, before: boolean): void { const m = model(); if (m) { bp.selectedId = id; mutate(insertRelative(m, id, targetId, before)); } }

/** The parent id that owns `id` in `mm` — its container/tab, or the enclosing tab for a tab-level node. */
function parentIdOf(mm: LModel, id: string): string | null {
  const f = findNode(mm, id);
  return f?.parent?.id ?? findTabOf(mm, id)?.id ?? null;
}

/** Revert a single node's staged changes back to baseline — the tray's per-node undo. A staged ADD
 *  (temp id, absent from baseline) is removed outright; an edited node is reset field-wise, and its
 *  position is restored ONLY if its parent or index actually moved (so reverting a pure field change
 *  never reorders it, and we never anchor to a baseline neighbour that has itself moved away). */
export function revertNode(id: string): void {
  const m = model(); if (!m || !bp.baseline) return;
  const base = findNode(bp.baseline, id);
  if (!base) { if (bp.selectedId === id) bp.selectedId = null; mutate(remove(m, id)); return; }
  let next = rename(m, id, base.node.name);
  next = resize(next, id, 'L', base.node.cols.L);
  if (base.node.height != null) next = setHeight(next, id, base.node.height);

  const baseSibs = base.parent ? base.parent.children : bp.baseline.tabs;
  const baseIndex = baseSibs.findIndex(n => n.id === id);
  const baseParentId = base.parent?.id ?? findTabOf(bp.baseline, id)?.id ?? null;
  const live = findNode(next, id);
  const liveParentId = live?.parent?.id ?? findTabOf(next, id)?.id ?? null;
  if (liveParentId !== baseParentId || (live && live.index !== baseIndex)) {
    const pred = baseIndex > 0 ? baseSibs[baseIndex - 1].id : null;
    const succ = baseIndex >= 0 && baseIndex < baseSibs.length - 1 ? baseSibs[baseIndex + 1].id : null;
    // anchor to a baseline neighbour only if it's still under the baseline parent; else reparent plain
    if (pred && parentIdOf(next, pred) === baseParentId) next = insertRelative(next, id, pred, false);
    else if (succ && parentIdOf(next, succ) === baseParentId) next = insertRelative(next, id, succ, true);
    else if (baseParentId && baseParentId !== id) next = moveInto(next, id, baseParentId);
  }
  mutate(next);
}

export function setHint(text: string | null): void { if (bp.hint !== text) { bp.hint = text; render(); } }
export function toggleTray(): void { bp.trayOpen = !bp.trayOpen; render(); }


/** A self-clearing hint-bar message for actions with no spatial gesture of their own (undo/redo).
 *  The timer only clears its OWN text, so a later gesture hint isn't clobbered. The caller renders. */
let hintTimer: ReturnType<typeof setTimeout> | undefined;
function flashHint(text: string): void {
  bp.hint = text;
  if (hintTimer) clearTimeout(hintTimer);
  hintTimer = setTimeout(() => { if (bp.hint === text) { bp.hint = null; render(); } }, 1400);
}

/** Count of staged changes vs baseline — so undo/redo can confirm where the model now stands. */
function pendingLabel(m: LModel): string {
  const n = bp.baseline ? summarizeChanges(diff(bp.baseline, m), m).changes : 0;
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
export function discard(): void { if (bp.baseline) { bp.history = new History(bp.baseline); bp.selectedId = null; render(); } }

/** EXISTING containers the plan structurally touches (resize/rename/move/delete) — the shared cells
 *  whose blast radius the preview checks. Returns {id, rid} so the shell can address a businessId-less
 *  container by lookup(rid). New (temp-id) containers are skipped (not shared yet); tab/widget edits
 *  too (only containers reverse-resolve via rref(container)). */
function touchedContainers(plan: PlanStep[], m: LModel): { id: string; rid?: string }[] {
  const out = new Map<string, { id: string; rid?: string }>();
  for (const s of plan) {
    if (s.kind === 'create') continue;
    const node = findNode(m, s.id)?.node;
    const kind = s.kind === 'reparent' || s.kind === 'delete' ? s.nodeKind : node?.kind;
    if (kind === 'container' && !isTempId(s.id)) out.set(s.id, { id: s.id, rid: node?.rid });
  }
  return [...out.values()];
}

/** Apply opens a preview first — never commit blind. The plan is computed with the SAME diff+compile
 *  the SW will run, so the human-readable notes match exactly what gets executed. */
export function openApplyPreview(): void {
  const m = model();
  if (!bp.ctx || !bp.baseline || !m || bp.applying) return;
  const plan = diff(bp.baseline, m);
  if (plan.length === 0) { showToast('Blueprint: nothing to apply', 'info'); return; }
  bp.preview = compile(plan, m).notes;
  bp.blast = null;
  const seq = ++bp.blastSeq; // invalidates any in-flight probe from an earlier preview
  render();
  // Best-effort + async: the modal renders now; the template-fan-out / shared-structure warnings
  // appear when (if) the rref walk returns. Never blocks the confirm path.
  void fetchBlast(seq, bp.ctx.pageId, touchedContainers(plan, m));
}
export function closePreview(): void { bp.preview = null; bp.blast = null; render(); }

/** Confirmed from the preview modal — fire the guarded SW apply (service owns the round-trip). */
export function confirmApply(): void {
  if (!bp.ctx || !bp.baseline || !bp.env || !model() || bp.applying) return;
  bp.preview = null;
  bp.blast = null;
  void applyPage();
}

export function exitBlueprint(): void { sendToSW({ type: 'BLUEPRINT_TOGGLE' }); }

/** Confirm from the create-tabset prompt — names + creates a dedicated tabset for a RESULT-only page,
 *  moves its widgets onto it, and loads the editor. No-ops on an empty name. */
export function doCreateTabset(name: string): void {
  const n = name.trim();
  if (n) void createTabset(n);
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
    else if (bp.picker) closePicker();
    else if (bp.movePicker) closeMovePicker();
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
