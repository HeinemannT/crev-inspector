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
import type { LModel, LNode, PlanNote } from '../lib/layout/types';
import type { BlueprintCtx } from '../lib/layout/sync';
import { findNode, walk, hasHeight, isChart } from '../lib/layout/model';
import { COMPOSITE_TYPES, COMPOSITE_CHILDREN } from '../lib/layout/constraints';
import { diff } from '../lib/layout/diff';
import { bp, model, PALETTE } from './state';
import { type Rect, ridElementMap, unionRect, anchorRect, mkBtn, delta, sp } from './geometry';
import {
  select, setWidth, setH, doDelete, doRename, openPicker, addFromPicker, closePicker,
  openMovePicker, closeMovePicker, moveTo, addTabAction, undo, redo, discard,
  openApplyPreview, confirmApply, closePreview, exitBlueprint,
} from './actions';

export function render(): void {
  const layer = bp.layer, base = bp.baseline, m = model(), ctx = bp.ctx;
  if (!layer || !base || !m || !ctx) return;
  layer.textContent = '';
  const byRid = ridElementMap();
  const pending = diff(base, m).length;
  layer.appendChild(renderChip(ctx, pending));
  layer.appendChild(tabBar(base, m));

  // container boxes first (behind), sized to the union of their live child-widget rects
  walk(base, (node) => {
    if (node.kind !== 'container') return;
    const rect = unionRect(node, byRid);
    if (!rect) return;
    if (nodeState(node, m) === 'gone') return; // deleted container → its widgets re-home; skip the box
    layer.appendChild(containerBox(node, rect, m));
  });

  // widget boxes, anchored to live DOM
  walk(base, (node, parent) => {
    if (node.kind !== 'widget' || !node.rid) return;
    const el = byRid.get(node.rid);
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (!r.width && !r.height) return;
    layer.appendChild(widgetBox(node, r, m, parent?.id ?? null));
  });

  // NEW widgets (staged adds) have no DOM — draw dashed placeholders stacked at the bottom of their
  // host's live area, so you can see what will be created and where.
  const stackY = new Map<string, number>();
  walk(m, (node, parent) => {
    if (node.kind !== 'widget' || node.rid || !parent) return; // rid-less ⇒ staged add
    const host = findNode(base, parent.id)?.node;
    const rect = host ? anchorRect(host, byRid) : null; // union for a container, own box for a composite
    if (!rect) return;
    const offset = stackY.get(parent.id) ?? 0;
    stackY.set(parent.id, offset + 42);
    layer.appendChild(newWidgetBox(node, { left: rect.left, top: rect.top + rect.height + 4 + offset, width: rect.width, height: 38 }));
  });

  // selection toolbar (hidden while a modal/picker is up)
  if (!bp.preview && !bp.picker && !bp.movePicker) {
    const selBox = bp.selectedId ? findNode(m, bp.selectedId) : null;
    if (selBox) {
      const anchor = anchorRect(selBox.node, byRid);
      if (anchor) layer.appendChild(toolbar(selBox.node, anchor));
    }
  }

  if (bp.movePicker) {
    const f = findNode(m, bp.movePicker);
    const anchor = f ? anchorRect(f.node, byRid) : null;
    layer.appendChild(moveMenu(bp.movePicker, anchor ?? { left: 80, top: 80, width: 0, height: 0 }));
  }
  if (bp.picker) layer.appendChild(pickerPanel(byRid));
  if (bp.preview) layer.appendChild(previewModal(bp.preview, ctx));
}

// ── per-element builders ─────────────────────────────────────────────────────

type NodeState = 'same' | 'changed' | 'gone';
function nodeState(baseNode: LNode, m: LModel): NodeState {
  const cur = findNode(m, baseNode.id);
  if (!cur) return 'gone';
  const c = cur.node;
  if (c.cols.L !== baseNode.cols.L || c.name !== baseNode.name || c.height !== baseNode.height) return 'changed';
  return 'same';
}

function widgetBox(baseNode: LNode, r: DOMRect, m: LModel, baseParentId: string | null): HTMLElement {
  const found = findNode(m, baseNode.id);
  const cur = found?.node;
  const state = nodeState(baseNode, m);
  const moved = state !== 'gone' && found != null && (found.parent?.id ?? null) !== baseParentId;
  const box = document.createElement('div');
  box.className = 'bp-box'
    + (isChart(baseNode.className) ? ' bp-chart' : '')
    + (state === 'changed' || moved ? ' changed' : '')
    + (state === 'gone' ? ' del' : '')
    + (moved ? ' moved' : '')
    + (bp.selectedId === baseNode.id ? ' sel' : '');
  Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  box.addEventListener('mousedown', (e) => { e.stopPropagation(); select(baseNode.id); });

  const lab = document.createElement('div'); lab.className = 'bp-lab';
  const nm = document.createElement('span'); nm.className = 'bp-nm'; nm.textContent = cur?.name ?? baseNode.name;
  const ty = document.createElement('span'); ty.className = 'ty'; ty.textContent = baseNode.className.toUpperCase();
  lab.append(nm, ty);
  if (cur && state !== 'gone') {
    if (cur.cols.L !== baseNode.cols.L) lab.appendChild(delta(`${baseNode.cols.L}→${cur.cols.L}/6`));
    else { const wd = document.createElement('span'); wd.className = 'wd'; wd.textContent = `${cur.cols.L}/6`; lab.appendChild(wd); }
    if (cur.height !== baseNode.height && cur.height != null) lab.appendChild(delta(`h${cur.height}`));
    if (moved) lab.appendChild(delta(`→ ${found?.parent?.name ?? 'tab'}`));
  }
  box.appendChild(lab);
  return box;
}

function newWidgetBox(node: LNode, r: Rect): HTMLElement {
  const box = document.createElement('div');
  box.className = 'bp-box bp-new' + (isChart(node.className) ? ' bp-chart' : '') + (bp.selectedId === node.id ? ' sel' : '');
  Object.assign(box.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
  box.addEventListener('mousedown', (e) => { e.stopPropagation(); select(node.id); });
  const lab = document.createElement('div'); lab.className = 'bp-lab';
  const tag = document.createElement('span'); tag.className = 'newtag'; tag.textContent = 'NEW';
  const nm = document.createElement('span'); nm.className = 'bp-nm'; nm.textContent = node.name;
  const ty = document.createElement('span'); ty.className = 'ty'; ty.textContent = node.className.toUpperCase();
  lab.append(tag, nm, ty);
  box.appendChild(lab);
  return box;
}

function containerBox(baseNode: LNode, rect: Rect, m: LModel): HTMLElement {
  const cur = findNode(m, baseNode.id)?.node;
  const box = document.createElement('div');
  box.className = 'bp-cont';
  Object.assign(box.style, { left: `${rect.left - 3}px`, top: `${rect.top - 3}px`, width: `${rect.width + 6}px`, height: `${rect.height + 6}px` });
  if (cur && cur.cols.L !== baseNode.cols.L) box.style.borderColor = '#E0A85A';
  // "+ widget" affordance — top-right, the only interactive part of the dashed box
  const add = document.createElement('button');
  add.className = 'bp-cadd'; add.textContent = '＋'; add.title = `Add a widget to ${baseNode.name}`;
  add.addEventListener('mousedown', (e) => { e.stopPropagation(); openPicker(baseNode.id); });
  box.appendChild(add);
  return box;
}

function toolbar(node: LNode, r: Rect): HTMLElement {
  const t = document.createElement('div'); t.className = 'bp-tools';
  t.style.left = `${Math.max(4, r.left)}px`;
  t.style.top = `${Math.max(40, r.top - 32)}px`;

  const lblW = document.createElement('span'); lblW.className = 'lbl'; lblW.textContent = 'W'; t.appendChild(lblW);
  const seg = document.createElement('div'); seg.className = 'bp-seg';
  for (let i = 1; i <= 6; i++) {
    const b = document.createElement('button'); b.textContent = String(i);
    if (node.cols.L === i) b.classList.add('on');
    b.addEventListener('mousedown', (e) => { e.stopPropagation(); setWidth(node.id, i); });
    seg.appendChild(b);
  }
  t.appendChild(seg);

  if (node.kind === 'widget' && hasHeight(node.className)) {
    t.append(mkBtn('H−', () => setH(node.id, (node.height ?? 200) - 40)), mkBtn('H+', () => setH(node.id, (node.height ?? 200) + 40)));
  }
  if (node.kind === 'widget' && COMPOSITE_TYPES.has(node.className)) t.appendChild(mkBtn('+ Child', () => openPicker(node.id)));
  if (node.kind === 'widget') t.appendChild(mkBtn('Move →', () => openMovePicker(node.id)));
  t.appendChild(mkBtn('Rename', () => startRename(node.id)));
  const del = mkBtn('Delete', () => doDelete(node.id)); del.classList.add('del');
  t.appendChild(del);
  return t;
}

/** The add picker — searchable. A composite target offers only its valid children; else the palette. */
function pickerPanel(byRid: Map<string, Element>): HTMLElement {
  const cid = bp.picker!;
  const host = bp.baseline ? findNode(bp.baseline, cid)?.node : null;
  const rect = host ? unionRect(host, byRid) : null;
  const back = document.createElement('div'); back.className = 'bp-pick-back';
  back.addEventListener('mousedown', (e) => { if (e.target === back) closePicker(); });
  const panel = document.createElement('div'); panel.className = 'bp-pick';
  if (rect) { panel.style.left = `${Math.min(rect.left, window.innerWidth - 320)}px`; panel.style.top = `${Math.min(rect.top + 24, window.innerHeight - 420)}px`; }
  else { panel.style.left = '50%'; panel.style.top = '80px'; panel.style.transform = 'translateX(-50%)'; }
  const composite = host && host.kind === 'widget' && COMPOSITE_TYPES.has(host.className) ? host.className : null;
  const groups = composite ? [{ group: `${composite} children`, items: COMPOSITE_CHILDREN[composite] ?? [] }] : PALETTE;
  const head = document.createElement('div'); head.className = 'bp-pick-h';
  head.textContent = composite ? `Add to ${host?.name}` : `Add widget to ${host?.name ?? 'container'}`;
  const search = document.createElement('input'); search.className = 'bp-pick-s'; search.placeholder = 'Search…';
  const list = document.createElement('div'); list.className = 'bp-pick-list';
  const fill = (q: string): void => {
    list.textContent = '';
    const ql = q.trim().toLowerCase();
    for (const grp of groups) {
      const items = grp.items.filter(it => !ql || it.name.toLowerCase().includes(ql) || it.key.toLowerCase().includes(ql));
      if (!items.length) continue;
      const gh = document.createElement('div'); gh.className = 'bp-pick-grp'; gh.textContent = grp.group; list.appendChild(gh);
      for (const it of items) {
        const b = document.createElement('button'); b.className = 'bp-pick-it';
        b.innerHTML = `<span>${it.name}</span><span class="k">${it.key}</span>`;
        b.addEventListener('mousedown', (e) => { e.stopPropagation(); addFromPicker(it.key); });
        list.appendChild(b);
      }
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
  for (const tab of m.tabs) {
    addDest(list, tab, tab.name, widgetId, curParentId);
    const rec = (n: LNode, path: string): void => {
      for (const c of n.children) {
        if (c.kind === 'container') { addDest(list, c, `${path} / ${c.name}`, widgetId, curParentId); rec(c, `${path} / ${c.name}`); }
      }
    };
    rec(tab, tab.name);
  }
  if (!list.children.length) { const e = document.createElement('div'); e.className = 'bp-pick-grp'; e.textContent = 'nowhere else to move'; list.appendChild(e); }
  panel.append(head, list);
  back.appendChild(panel);
  return back;
}
function addDest(list: HTMLElement, dest: LNode, label: string, widgetId: string, curParentId: string | null): void {
  if (dest.id === curParentId || dest.id === widgetId) return;
  const b = document.createElement('button'); b.className = 'bp-pick-it';
  b.innerHTML = `<span>${label}</span><span class="k">${dest.kind === 'tab' ? 'tab' : 'container'}</span>`;
  b.addEventListener('mousedown', (e) => { e.stopPropagation(); moveTo(widgetId, dest.id); });
  list.appendChild(b);
}

const VERB_ICON: Record<PlanNote['verb'], string> = { create: '＋', update: '✎', move: '⇄', reorder: '↕', delete: '🗑' };

/** The apply-preview: the exact plan as human-readable steps + the blast-radius warning, behind a confirm. */
function previewModal(notes: PlanNote[], ctx: BlueprintCtx): HTMLElement {
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
  const list = document.createElement('div'); list.className = 'bp-modal-list';
  for (const note of notes) {
    const row = document.createElement('div'); row.className = `bp-prow v-${note.verb}`;
    const ic = document.createElement('span'); ic.className = 'ic'; ic.textContent = VERB_ICON[note.verb];
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

function renderChip(ctx: BlueprintCtx, pending: number): HTMLElement {
  const shared = ctx.target === 'template';
  const c = document.createElement('div'); c.className = 'bp-chip' + (shared ? ' tmpl' : '');
  const b = document.createElement('b'); b.textContent = 'BLUEPRINT';
  const id = document.createElement('span'); id.textContent = `${ctx.pageClass} ${ctx.pageId}`;
  c.append(b, id);
  if (shared) { const w = document.createElement('span'); w.className = 'warn'; w.textContent = '⚠ shared template — affects all instances'; c.appendChild(w); }
  c.appendChild(sp());
  const undoB = mkBtn('↶', undo); undoB.disabled = !bp.history?.canUndo(); c.appendChild(undoB);
  const redoB = mkBtn('↷', redo); redoB.disabled = !bp.history?.canRedo(); c.appendChild(redoB);
  const discardB = mkBtn('Discard', discard); discardB.disabled = pending === 0 || bp.applying; c.appendChild(discardB);
  const applyB = mkBtn(bp.applying ? 'Applying…' : `Apply${pending ? ` (${pending})` : ''}`, openApplyPreview);
  applyB.className = 'apply'; applyB.disabled = pending === 0 || bp.applying; c.appendChild(applyB);
  const exit = mkBtn('✕', exitBlueprint); exit.title = 'Exit blueprint mode'; c.appendChild(exit);
  return c;
}

/** Tab manager — a strip under the chip listing every tab (rename inline, delete, add widget) + "+ Tab".
 *  Rendered from the BASELINE tabs so deletions stay visible (struck), with staged new tabs appended. */
function tabBar(base: LModel, m: LModel): HTMLElement {
  const bar = document.createElement('div'); bar.className = 'bp-tabs';
  const lbl = document.createElement('span'); lbl.className = 'bp-tabs-l'; lbl.textContent = 'TABS'; bar.appendChild(lbl);
  for (const bt of base.tabs) {
    const cur = findNode(m, bt.id)?.node;
    bar.appendChild(tabPill(bt.id, cur?.name ?? bt.name, !cur ? 'gone' : (cur.name !== bt.name ? 'renamed' : 'same')));
  }
  for (const mt of m.tabs) {
    if (!base.tabs.some(b => b.id === mt.id)) bar.appendChild(tabPill(mt.id, mt.name, 'new'));
  }
  bar.appendChild(mkBtn('+ Tab', addTabAction));
  return bar;
}

function tabPill(id: string, name: string, state: 'same' | 'renamed' | 'gone' | 'new'): HTMLElement {
  const pill = document.createElement('div'); pill.className = `bp-tab st-${state}` + (bp.selectedId === id ? ' sel' : '');
  pill.addEventListener('mousedown', (e) => { e.stopPropagation(); select(id); });
  if (state === 'new') { const t = document.createElement('span'); t.className = 'newtag'; t.textContent = 'NEW'; pill.appendChild(t); }
  const nm = document.createElement('span'); nm.className = 'bp-tnm'; nm.textContent = name;
  nm.addEventListener('mousedown', (e) => { if (state !== 'gone') { e.stopPropagation(); startTabRename(id, nm); } });
  pill.appendChild(nm);
  if (state !== 'gone') {
    const add = document.createElement('button'); add.className = 'bp-tadd'; add.textContent = '＋'; add.title = `Add a widget to ${name}`;
    add.addEventListener('mousedown', (e) => { e.stopPropagation(); openPicker(id); });
    pill.appendChild(add);
  }
  const del = document.createElement('button'); del.className = 'bp-tdel'; del.textContent = state === 'gone' ? '↺' : '×';
  del.title = state === 'gone' ? 'Undo delete (use Undo)' : `Delete tab "${name}" and its contents`;
  if (state !== 'gone') del.addEventListener('mousedown', (e) => { e.stopPropagation(); doDelete(id); });
  pill.appendChild(del);
  return pill;
}

// ── inline rename (view-level: edits the rendered name span in place, then commits) ──────────────
function startRename(id: string): void {
  render();
  inlineRename(id, bp.layer?.querySelector('.bp-box.sel .bp-nm') as HTMLElement | null);
}
function startTabRename(id: string, nm: HTMLElement): void { inlineRename(id, nm); }
function inlineRename(id: string, nm: HTMLElement | null): void {
  if (!nm) return;
  nm.setAttribute('contenteditable', 'true');
  nm.focus();
  const range = document.createRange(); range.selectNodeContents(nm);
  const sel = getSelection(); sel?.removeAllRanges(); sel?.addRange(range);
  nm.addEventListener('blur', () => { nm.removeAttribute('contenteditable'); doRename(id, nm.textContent ?? ''); }, { once: true });
  nm.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') { e.preventDefault(); nm.blur(); }
    if ((e as KeyboardEvent).key === 'Escape') { nm.textContent = findNode(model()!, id)?.node.name ?? ''; nm.blur(); }
  });
}
