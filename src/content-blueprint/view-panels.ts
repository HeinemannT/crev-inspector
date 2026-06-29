/**
 * Blueprint chrome panels — the self-contained overlay surfaces that frame the editor: the command
 * chip, the apply-preview modal, the pending-changes tray, and the gesture hint bar. These are pure
 * builders: they read `bp`/the model and wire controller actions onto buttons, but never call
 * `render()` themselves (the actions do), so there's no import cycle with view.ts. The box/zone
 * builders and the tab/picker/rename cluster (which is coupled to inline-rename + render) stay in
 * view.ts.
 */
import type { LModel, LNode, PlanNote } from '../lib/layout/types';
import type { BlueprintCtx } from '../lib/layout/sync';
import { findNode, isResultTab, eachInSubtree } from '../lib/layout/model';
import { getTypeAbbr, getTypeColor } from '../lib/types';
import { lint } from '../lib/layout/constraints';
import { diff, summarizeChanges } from '../lib/layout/diff';
import { ICON_PLUS, ICON_PENCIL, ICON_TRASH, ICON_X, ICON_SWAP, ICON_ARROW_RIGHT, ICON_ARROW_UNDO, ICON_ARROW_REDO, ICON_LIST, ICON_BLUEPRINT, ICON_PAINT, ICON_WARNING, ICON_EYE_SLASH } from '../lib/icons';
import { bp, model } from './state';
import { setIcon, mkBtn, mkIconBtn, sp } from './geometry';
import { closePreview, confirmApply, revertNode, undo, redo, toggleTray, togglePeek, discard, openApplyPreview, exitBlueprint, setMode } from './actions';
import { setEditTarget } from '../content-blueprint'; // runtime-only (click handler) — no init-time cycle

const VERB_ICON: Record<PlanNote['verb'], string> = { create: ICON_PLUS, update: ICON_PENCIL, move: ICON_ARROW_RIGHT, reorder: ICON_SWAP, delete: ICON_TRASH };

/** Scope accent class for the chip / header / modal: TEMPLATE = blue (` tmpl`), an instance reusing a
 *  template = orange (` inst`), a plain page = none. One place so the three surfaces can't disagree. */
export function scopeClass(ctx: BlueprintCtx): string {
  if (ctx.target === 'template') return ' tmpl';
  if (ctx.templateId) return ' inst';
  return '';
}

/** A warning banner row: a leading warning-triangle icon followed by the message
 *  text (replaces the former text '⚠ ' prefix). */
function warnRow(text: string): HTMLElement {
  const w = document.createElement('div'); w.className = 'bp-modal-warn';
  const ic = document.createElement('span'); ic.className = 'bp-modal-warn-ic'; setIcon(ic, ICON_WARNING);
  w.append(ic, document.createTextNode(text));
  return w;
}

/** A neutral scope-note row (muted, no warning weight) — for "this applies to the instance" and the
 *  like, which a user should see but which isn't a hazard. */
function infoRow(text: string): HTMLElement {
  const w = document.createElement('div'); w.className = 'bp-modal-info';
  const dot = document.createElement('span'); dot.className = 'bp-modal-info-dot';
  w.append(dot, document.createTextNode(text));
  return w;
}

/** Does the staged plan touch the shared Result tab, and does it touch CONTAINERS there? Built from the
 *  union of the Result subtree in baseline + desired (so a move IN, a move OUT, and a staged add are all
 *  caught), then matched against the plan's step ids. Container impact is called out louder. */
function resultImpact(): { touched: boolean; containers: boolean } {
  const base = bp.baseline, m = model();
  if (!base || !m) return { touched: false, containers: false };
  const subtree = (mm: LModel): Map<string, LNode['kind']> => {
    const ids = new Map<string, LNode['kind']>();
    const t = mm.tabs.find(isResultTab);
    if (t) eachInSubtree(t, n => ids.set(n.id, n.kind));
    return ids;
  };
  const ids = new Map([...subtree(base), ...subtree(m)]);
  let touched = false, containers = false;
  for (const s of diff(base, m)) {
    const sid = s.kind === 'create' ? s.node.id : s.id; // a created node carries its id on `node`
    const k = ids.get(sid);
    if (k !== undefined) { touched = true; if (k === 'container') containers = true; }
  }
  return { touched, containers };
}

/** The apply-preview: the exact plan as human-readable steps + the blast-radius warning, behind a confirm. */
export function previewModal(notes: PlanNote[], ctx: BlueprintCtx): HTMLElement {
  const shared = ctx.target === 'template';
  const back = document.createElement('div'); back.className = 'bp-modal-back';
  back.addEventListener('mousedown', (e) => { if (e.target === back) closePreview(); });
  const card = document.createElement('div'); card.className = 'bp-modal' + scopeClass(ctx);
  const h = document.createElement('div'); h.className = 'bp-modal-h';
  // Headline = logical changes; "(N actions)" exposes the raw EC step count when it differs (an insert
  // can compile to a create + a moveAfter chain). The list below still enumerates every action.
  const lm0 = model();
  const sum = lm0 && bp.baseline ? summarizeChanges(diff(bp.baseline, lm0), lm0) : { changes: notes.length, actions: notes.length };
  h.textContent = `Apply ${sum.changes} change${sum.changes === 1 ? '' : 's'}`
    + (sum.actions !== sum.changes ? ` (${sum.actions} actions)` : '')
    + ` to ${ctx.pageClass} ${ctx.pageId}`;
  card.appendChild(h);
  // Blast radius (async, best-effort — appears once the rref probe returns; see actions.openApplyPreview).
  const warn = (text: string) => { card.appendChild(warnRow(text)); };
  // ONE shared-template warning: the fanout version (with the live instance count) supersedes the static
  // one when the probe has returned — they otherwise both say "this is a template" and read as redundant.
  const fanout = bp.blast?.fanout;
  if (fanout?.isMaster) {
    const n = fanout.instances.length;
    warn(`This is a shared template — ${n} linked scorecard${n === 1 ? '' : 's'} inherit from it. `
      + 'Widget edits propagate to them; tab or container edits change every one.');
  } else if (shared) {
    warn('This is a shared template. These changes affect every instance that uses it.');
  }
  const xfam = bp.blast?.blast;
  if (xfam && xfam.otherFamilies > 0) {
    const names = xfam.families.map(f => f.name).filter(Boolean).slice(0, 2).join(', ');
    warn(`Some containers here are shared with ${xfam.otherFamilies} page${xfam.otherFamilies === 1 ? '' : 's'} `
      + `outside this template${names ? ` (${names}${xfam.otherFamilies > 2 ? ', …' : ''})` : ''}. Your structural changes affect them too.`);
  }
  // Shared Result-tab warning. The Result tab lives in the SHARED default_tabset, so structural edits
  // there (above all a new/moved container) land on every scorecard that uses it — louder than a normal
  // widget edit, which only touches this scorecard's own objects. Computed locally (no probe needed).
  const ri = resultImpact();
  if (ri.touched) {
    card.appendChild(warnRow(ri.containers
      ? 'You are changing containers on the shared Result tab. A container added or moved here appears on EVERY scorecard that uses the default tab set, not just this one.'
      : "You are editing the shared Result tab. These widgets are this scorecard's own, but the tab is shared across scorecards — review before applying."));
  }
  // Blast-radius warning. Deleting a tab cascades to every container/widget under it (a tab's contents
  // can't re-home the way a deleted container's widgets do), so one delete gesture can stage many. Make
  // that scope explicit at the confirm gate — the rows below enumerate it, but the count is the headline.
  const deletes = notes.filter(n => n.verb === 'delete').length;
  if (deletes > 0) {
    card.appendChild(warnRow(`${deletes} object${deletes === 1 ? '' : 's'} will be permanently deleted. This can't be undone after Apply.`));
  }
  // Pre-commit lint: empty-tab and structural-on-instance warnings (undo is frozen while this modal
  // is open, so the model behind these matches exactly what Confirm will apply).
  const lm = model();
  if (lm && bp.baseline) {
    for (const msg of lint(lm, lm.target, diff(bp.baseline, lm))) {
      card.appendChild(msg.level === 'info' ? infoRow(msg.text) : warnRow(msg.text));
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
  const { changes, actions } = summarizeChanges(plan, m);
  const wrap = document.createElement('div'); wrap.className = 'bp-tray';
  // Headline = logical changes; the "· N actions" exposes the underlying EC steps without hiding them
  // (one insert can compile to a create + a moveAfter chain). Singular-aware.
  const h = document.createElement('div'); h.className = 'bp-tray-h';
  h.textContent = `${changes} change${changes === 1 ? '' : 's'}`
    + (actions !== changes ? ` · ${actions} action${actions === 1 ? '' : 's'}` : '');
  wrap.appendChild(h);
  if (!plan.length) { const e = document.createElement('div'); e.className = 'bp-tray-empty'; e.textContent = 'No staged changes'; wrap.appendChild(e); return wrap; }
  const seen = new Set<string>();
  for (const s of plan) {
    const id = s.kind === 'create' ? s.node.id : s.id;
    if (seen.has(id)) continue; seen.add(id);
    const node = s.kind === 'create' ? s.node : (findNode(m, id)?.node ?? findNode(base, id)?.node ?? null);
    const name = node?.name ?? id;
    // Two badges: WHAT changed (new/changed/deleted/moved) + WHAT it is (CREV's coloured type tag).
    const change = s.kind === 'create' ? 'NEW' : s.kind === 'delete' ? 'DELETED' : (s.kind === 'reparent' || s.kind === 'reorder') ? 'MOVED' : 'CHANGED';
    const row = document.createElement('div'); row.className = `bp-pop v-${s.kind}`;
    const chg = document.createElement('span'); chg.className = 'chg'; chg.textContent = change;
    const typ = document.createElement('span'); typ.className = 'typ'; typ.textContent = getTypeAbbr(node?.className);
    typ.style.setProperty('--type-color', getTypeColor(node?.className)); typ.title = node?.className ?? '';
    const tx = document.createElement('span'); tx.className = 'tx'; tx.textContent = name;
    const x = document.createElement('button'); x.className = 'bp-pop-x'; setIcon(x, ICON_X); x.title = 'Revert this change';
    x.addEventListener('mousedown', (e) => { e.stopPropagation(); revertNode(id); });
    row.append(chg, typ, tx, x);
    wrap.appendChild(row);
  }
  return wrap;
}

export function hintBar(text: string): HTMLElement {
  const h = document.createElement('div'); h.className = 'bp-hint'; h.textContent = text;
  return h;
}


/** The vertical mode switch mounted at the LEFT of the header — top = Layout (blueprint), bottom =
 *  Style (paint). A physical-feeling toggle that spans the header + tab rows; flipping it morphs the
 *  whole editor (the chip wordmark + the per-widget toolbar) between structure and appearance. */
export function modeSwitch(): HTMLElement {
  const sw = document.createElement('div'); sw.className = 'bp-vswitch';
  const seg = (mode: 'layout' | 'style', icon: string, title: string): HTMLElement => {
    const b = document.createElement('button');
    b.className = 'bp-vsw-b' + (mode === 'style' ? ' style' : '') + (bp.mode === mode ? ' on' : '');
    setIcon(b, icon); b.title = title;
    b.addEventListener('click', () => setMode(mode));
    return b;
  };
  sw.append(
    seg('layout', ICON_BLUEPRINT, 'Layout — structure, columns, position'),
    seg('style', ICON_PAINT, 'Style — colours, shadow, border, header'),
  );
  return sw;
}

/** Command chip — page id, undo/redo, pending tray toggle, discard, apply, exit. */
export function renderChip(ctx: BlueprintCtx, pending: number): HTMLElement {
  const styling = bp.mode === 'style';
  const c = document.createElement('div'); c.className = 'bp-chip' + scopeClass(ctx) + (styling ? ' style' : '');
  const b = document.createElement('b');
  // The wordmark morphs with the mode — BLUEPRINT (cyan) in layout, STYLE (purple) in style — so the
  // mode is legible without the old horizontal toggle (that role moved to the vertical switch at left).
  const mark = document.createElement('span'); mark.className = 'bp-mark'; setIcon(mark, styling ? ICON_PAINT : ICON_BLUEPRINT);
  // Fixed-width word so the chip (centred header) doesn't resize/shift when the shorter "STYLE" replaces
  // "BLUEPRINT" — the box is sized to the longer word and the text left-aligns in it.
  const wordmark = document.createElement('span'); wordmark.className = 'bp-word'; wordmark.textContent = styling ? 'STYLE' : 'BLUEPRINT';
  b.append(mark, wordmark);
  const id = document.createElement('span'); id.className = 'bp-pgid'; id.textContent = `${ctx.pageClass} ${ctx.pageId}`;
  c.append(b, id);
  // F: template/instance target toggle — shown whenever this page reuses a template (you can edit the
  // shared template OR just this instance). Default is the template. The active segment + the tmpl
  // styling on the chip ARE the "what am I editing" indicator (E), so no free-flowing warning text that
  // could shove the buttons out of alignment.
  if (ctx.templateId) {
    const seg = document.createElement('div'); seg.className = 'bp-target';
    const tBtn = document.createElement('button');
    tBtn.className = 'bp-target-b' + (bp.editingTemplate ? ' on' : '');
    tBtn.textContent = 'Template';
    tBtn.title = `Editing the shared template ${ctx.templateId} — changes affect every instance`;
    tBtn.addEventListener('click', () => setEditTarget(true));
    const iBtn = document.createElement('button');
    iBtn.className = 'bp-target-b' + (!bp.editingTemplate ? ' on' : '');
    iBtn.textContent = 'This instance';
    iBtn.title = `Editing only ${ctx.instanceId ?? 'this instance'} — overrides the template here`;
    iBtn.addEventListener('click', () => setEditTarget(false));
    seg.append(tBtn, iBtn);
    c.appendChild(seg);
  }
  // (No "affects all instances" banner here — the template scope is shown by the Template/Instance
  // toggle above, and the full blast-radius warning is spelled out in the apply-preview modal.)
  c.appendChild(sp());
  // Peek + undo/redo are borderless (.plain) — they're frequent, low-stakes nudges, so the outline just
  // ate width and pushed Exit out of the chip. Peek: hover for a transient fade, CLICK to keep it on.
  const peek = mkIconBtn(ICON_EYE_SLASH, togglePeek); peek.title = 'Peek at the live widgets — hover for a moment, click to keep it on';
  peek.classList.add('plain');
  if (bp.peek) peek.classList.add('on');
  peek.addEventListener('mouseenter', () => bp.layer?.classList.add('bp-peek'));
  peek.addEventListener('mouseleave', () => { if (!bp.peek) bp.layer?.classList.remove('bp-peek'); });
  c.appendChild(peek);
  const undoB = mkIconBtn(ICON_ARROW_UNDO, undo); undoB.title = 'Undo'; undoB.disabled = !bp.history?.canUndo(); undoB.classList.add('plain'); c.appendChild(undoB);
  const redoB = mkIconBtn(ICON_ARROW_REDO, redo); redoB.title = 'Redo'; redoB.disabled = !bp.history?.canRedo(); redoB.classList.add('plain'); c.appendChild(redoB);
  const trayB = mkIconBtn(ICON_LIST, toggleTray, String(pending)); trayB.title = 'Pending changes'; trayB.disabled = pending === 0;
  if (bp.trayOpen) trayB.classList.add('on'); c.appendChild(trayB);
  const discardB = mkBtn('Discard', discard); discardB.disabled = pending === 0 || bp.applying; c.appendChild(discardB);
  const applyB = mkBtn(bp.applying ? 'Applying…' : `Apply${pending ? ` (${pending})` : ''}`, openApplyPreview);
  applyB.className = 'apply'; applyB.disabled = pending === 0 || bp.applying; c.appendChild(applyB);
  const exit = mkIconBtn(ICON_X, exitBlueprint); exit.title = 'Exit blueprint mode'; c.appendChild(exit);
  return c;
}
