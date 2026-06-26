/**
 * Blueprint controller — every edit gesture as a `bp` mutation followed by a re-render. Each action
 * runs a PURE layout op (`edit.ts`), pushes the result onto history, and re-renders; the model is
 * the single source of truth, the DOM just reflects it.
 *
 * Imports `render` from view.ts — a deliberate, runtime-safe controller↔view cycle: view wires these
 * actions onto button handlers, and these call render() at click time. All cross-calls happen inside
 * functions (never at module-init), so ESM resolves the cycle cleanly.
 */
import { findNode } from '../lib/layout/model';
import { resize, setHeight, rename, remove, addWidget, moveInto, addTab } from '../lib/layout/edit';
import { diff } from '../lib/layout/diff';
import { compile } from '../lib/layout/ec';
import { History } from '../lib/layout/history';
import type { LModel } from '../lib/layout/types';
import { sendToSW } from '../lib/content-port';
import { showToast } from '../lib/toast';
import { bp, model } from './state';
import { render } from './view';

/** Push a new model state onto history and re-render. The one write path for staged edits. */
export function mutate(next: LModel): void { bp.history?.push(next); render(); }

export function select(id: string | null): void { bp.selectedId = id; render(); }
export function setWidth(id: string, n: number): void { const m = model(); if (m) mutate(resize(m, id, 'L', n)); }
export function setH(id: string, px: number): void { const m = model(); if (m) mutate(setHeight(m, id, px)); }
export function doRename(id: string, name: string): void { const m = model(); if (m) mutate(rename(m, id, name)); }
export function doDelete(id: string): void { const m = model(); if (m) { bp.selectedId = null; mutate(remove(m, id)); } }

export function openPicker(containerId: string): void { bp.picker = containerId; bp.selectedId = null; render(); }
export function closePicker(): void { bp.picker = null; render(); }
export function addFromPicker(className: string): void {
  const m = model(); const cid = bp.picker;
  if (!m || !cid) return;
  const f = findNode(m, cid);
  const idx = f ? f.node.children.length : 0;
  const added = addWidget(m, cid, idx, className);
  bp.picker = null;
  bp.selectedId = added.id;
  mutate(added.model);
}

export function addTabAction(): void { const m = model(); if (m) { const r = addTab(m, m.tabs.length, 'New Tab'); bp.selectedId = r.id; mutate(r.model); } }

export function openMovePicker(id: string): void { bp.movePicker = id; render(); }
export function closeMovePicker(): void { bp.movePicker = null; render(); }
export function moveTo(id: string, destId: string): void {
  const m = model(); if (!m) return;
  bp.movePicker = null;
  mutate(moveInto(m, id, destId));
}

export function undo(): void { const m = bp.history?.undo(); if (m) { bp.selectedId = null; render(); } }
export function redo(): void { const m = bp.history?.redo(); if (m) { bp.selectedId = null; render(); } }
export function discard(): void { if (bp.baseline) { bp.history = new History(bp.baseline); bp.selectedId = null; render(); } }

/** Apply opens a preview first — never commit blind. The plan is computed with the SAME diff+compile
 *  the SW will run, so the human-readable notes match exactly what gets executed. */
export function openApplyPreview(): void {
  const m = model();
  if (!bp.ctx || !bp.baseline || !m || bp.applying) return;
  const plan = diff(bp.baseline, m);
  if (plan.length === 0) { showToast('Blueprint: nothing to apply', 'info'); return; }
  bp.preview = compile(plan, m).notes;
  render();
}
export function closePreview(): void { bp.preview = null; render(); }

/** Confirmed from the preview modal — fire the guarded SW apply. */
export function confirmApply(): void {
  const m = model();
  if (!bp.ctx || !bp.baseline || !bp.env || !m || bp.applying) return;
  bp.preview = null;
  bp.applying = true; render();
  sendToSW({ type: 'LAYOUT_APPLY', env: bp.env, ctx: bp.ctx, baseline: bp.baseline, desired: m });
}

export function exitBlueprint(): void { sendToSW({ type: 'BLUEPRINT_TOGGLE' }); }

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
  const mod = e.ctrlKey || e.metaKey;
  if (mod && (e.key === 'z' || e.key === 'Z')) { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redo(); return; }
  if ((e.key === 'Delete' || e.key === 'Backspace') && bp.selectedId && !bp.preview && !bp.picker) {
    const sel = findNode(model() ?? bp.baseline!, bp.selectedId);
    if (sel?.node.kind === 'widget') { e.preventDefault(); doDelete(bp.selectedId); }
  }
}
