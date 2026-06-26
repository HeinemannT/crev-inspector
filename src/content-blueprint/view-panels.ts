/**
 * Blueprint chrome panels — the self-contained overlay surfaces that frame the editor: the command
 * chip, the apply-preview modal, the pending-changes tray, and the gesture hint bar. These are pure
 * builders: they read `bp`/the model and wire controller actions onto buttons, but never call
 * `render()` themselves (the actions do), so there's no import cycle with view.ts. The box/zone
 * builders and the tab/picker/rename cluster (which is coupled to inline-rename + render) stay in
 * view.ts.
 */
import type { LModel, PlanNote } from '../lib/layout/types';
import type { BlueprintCtx } from '../lib/layout/sync';
import { findNode } from '../lib/layout/model';
import { lint } from '../lib/layout/constraints';
import { diff } from '../lib/layout/diff';
import { ICON_PLUS, ICON_PENCIL, ICON_TRASH, ICON_X, ICON_SWAP, ICON_ARROW_RIGHT, ICON_ARROW_UNDO, ICON_ARROW_REDO, ICON_LIST } from '../lib/icons';
import { bp, model } from './state';
import { setIcon, mkBtn, mkIconBtn, sp } from './geometry';
import { closePreview, confirmApply, revertNode, undo, redo, toggleTray, discard, openApplyPreview, exitBlueprint } from './actions';

const VERB_ICON: Record<PlanNote['verb'], string> = { create: ICON_PLUS, update: ICON_PENCIL, move: ICON_ARROW_RIGHT, reorder: ICON_SWAP, delete: ICON_TRASH };

/** The apply-preview: the exact plan as human-readable steps + the blast-radius warning, behind a confirm. */
export function previewModal(notes: PlanNote[], ctx: BlueprintCtx): HTMLElement {
  const shared = ctx.target === 'template';
  const back = document.createElement('div'); back.className = 'bp-modal-back';
  back.addEventListener('mousedown', (e) => { if (e.target === back) closePreview(); });
  const card = document.createElement('div'); card.className = 'bp-modal' + (shared ? ' tmpl' : '');
  const h = document.createElement('div'); h.className = 'bp-modal-h';
  h.textContent = `Apply ${notes.length} change${notes.length === 1 ? '' : 's'} to ${ctx.pageClass} ${ctx.pageId}`;
  card.appendChild(h);
  if (shared) {
    const w = document.createElement('div'); w.className = 'bp-modal-warn';
    w.textContent = '⚠ This is a shared template — these changes affect every instance that uses it.';
    card.appendChild(w);
  }
  // Pre-commit lint: empty-tab and structural-on-instance warnings (undo is frozen while this modal
  // is open, so the model behind these matches exactly what Confirm will apply).
  const lm = model();
  if (lm && bp.baseline) {
    for (const msg of lint(lm, lm.target, diff(bp.baseline, lm))) {
      const w = document.createElement('div'); w.className = 'bp-modal-warn';
      w.textContent = `⚠ ${msg}`;
      card.appendChild(w);
    }
  }
  const list = document.createElement('div'); list.className = 'bp-modal-list';
  for (const note of notes) {
    const row = document.createElement('div'); row.className = `bp-prow v-${note.verb}`;
    const ic = document.createElement('span'); ic.className = 'ic'; setIcon(ic, VERB_ICON[note.verb]);
    const tx = document.createElement('span'); tx.textContent = note.text;
    row.append(ic, tx);
    if (note.ec) { const ec = document.createElement('code'); ec.textContent = note.ec.replace(/ \/\/ BMP assigns id$/, ''); row.appendChild(ec); }
    list.appendChild(row);
  }
  card.appendChild(list);
  const foot = document.createElement('div'); foot.className = 'bp-modal-foot';
  foot.append(mkBtn('Cancel', closePreview), (() => { const b = mkBtn('Confirm & apply', confirmApply); b.className = 'apply'; return b; })());
  card.appendChild(foot);
  back.appendChild(card);
  return back;
}

/** Docked pending-changes tray — one row per changed node, each with a revert. Toggled from the chip. */
export function trayPanel(base: LModel, m: LModel): HTMLElement {
  const plan = diff(base, m);
  const wrap = document.createElement('div'); wrap.className = 'bp-tray';
  const h = document.createElement('div'); h.className = 'bp-tray-h'; h.textContent = `Pending changes · ${plan.length}`;
  wrap.appendChild(h);
  if (!plan.length) { const e = document.createElement('div'); e.className = 'bp-tray-empty'; e.textContent = 'No staged changes'; wrap.appendChild(e); return wrap; }
  const seen = new Set<string>();
  for (const s of plan) {
    const id = s.kind === 'create' ? s.node.id : s.id;
    if (seen.has(id)) continue; seen.add(id);
    const name = (s.kind === 'create' ? s.node.name : findNode(m, id)?.node.name ?? findNode(base, id)?.node.name) ?? id;
    const verb = s.kind === 'create' ? 'NEW' : s.kind === 'delete' ? 'DELETE' : s.kind === 'reparent' ? 'MOVE' : s.kind === 'reorder' ? 'ORDER' : 'EDIT';
    const row = document.createElement('div'); row.className = `bp-pop v-${s.kind}`;
    const tag = document.createElement('span'); tag.className = 'tag'; tag.textContent = verb;
    const tx = document.createElement('span'); tx.className = 'tx'; tx.textContent = name;
    const x = document.createElement('button'); x.className = 'bp-pop-x'; setIcon(x, ICON_X); x.title = 'Revert this change';
    x.addEventListener('mousedown', (e) => { e.stopPropagation(); revertNode(id); });
    row.append(tag, tx, x);
    wrap.appendChild(row);
  }
  return wrap;
}

export function hintBar(text: string): HTMLElement {
  const h = document.createElement('div'); h.className = 'bp-hint'; h.textContent = text;
  return h;
}

/** Command chip — page id, undo/redo, pending tray toggle, discard, apply, exit. */
export function renderChip(ctx: BlueprintCtx, pending: number): HTMLElement {
  const shared = ctx.target === 'template';
  const c = document.createElement('div'); c.className = 'bp-chip' + (shared ? ' tmpl' : '');
  const b = document.createElement('b'); b.textContent = 'BLUEPRINT';
  const id = document.createElement('span'); id.textContent = `${ctx.pageClass} ${ctx.pageId}`;
  c.append(b, id);
  if (shared) { const w = document.createElement('span'); w.className = 'warn'; w.textContent = '⚠ shared template — affects all instances'; c.appendChild(w); }
  c.appendChild(sp());
  const undoB = mkIconBtn(ICON_ARROW_UNDO, undo); undoB.title = 'Undo'; undoB.disabled = !bp.history?.canUndo(); c.appendChild(undoB);
  const redoB = mkIconBtn(ICON_ARROW_REDO, redo); redoB.title = 'Redo'; redoB.disabled = !bp.history?.canRedo(); c.appendChild(redoB);
  const trayB = mkIconBtn(ICON_LIST, toggleTray, String(pending)); trayB.title = 'Pending changes'; trayB.disabled = pending === 0;
  if (bp.trayOpen) trayB.classList.add('on'); c.appendChild(trayB);
  const discardB = mkBtn('Discard', discard); discardB.disabled = pending === 0 || bp.applying; c.appendChild(discardB);
  const applyB = mkBtn(bp.applying ? 'Applying…' : `Apply${pending ? ` (${pending})` : ''}`, openApplyPreview);
  applyB.className = 'apply'; applyB.disabled = pending === 0 || bp.applying; c.appendChild(applyB);
  const exit = mkIconBtn(ICON_X, exitBlueprint); exit.title = 'Exit blueprint mode'; c.appendChild(exit);
  return c;
}
