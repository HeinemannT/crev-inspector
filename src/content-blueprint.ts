/**
 * Blueprint overlay (content script) — the interactive layout editor.
 *
 * 3.1 read-only render → 3.2 the core edit loop: select a box, change its column width / height /
 * name, delete it, then Apply (the guarded SW path). Edits are STAGED in a client-side model (the
 * same pure `edit`/`diff` core the SW uses for apply), shown as deltas over the live page — the
 * live BMP grid can't reflow client-side, so a resize shows as a "6→3" badge rather than a fake
 * reflow. Apply commits + re-fetches, and the real grid reflows for keeps.
 *
 * Render strategy: boxes are anchored to the BASELINE widgets (each has a live DOM element), then
 * styled by their state in the edited model — unchanged / changed (badge) / will-delete (strike).
 * That keeps deletions visible (the DOM widget is still there until apply). Geometry from the DOM,
 * everything else from the model.
 */
import type { LModel, LNode, PlanNote } from './lib/layout/types';
import type { BlueprintCtx } from './lib/layout/sync';
import { findNode, walk, descendantWidgets, hasHeight, isChart } from './lib/layout/model';
import { resize, setHeight, rename, remove, addWidget, moveInto } from './lib/layout/edit';
import { diff } from './lib/layout/diff';
import { compile } from './lib/layout/ec';
import { History } from './lib/layout/history';
import { getAllRidElements, extractUrlRids } from './lib/dom-scanner';
import { sendToSW } from './lib/content-port';
import { showToast } from './lib/toast';
import { log } from './lib/logger';

const LAYER_ID = 'crev-blueprint-layer';
const STYLE_ID = 'crev-blueprint-style';

interface BpState {
  active: boolean;
  baseline: LModel | null;     // the loaded page (boxes anchor to its widgets)
  ctx: BlueprintCtx | null;
  env: string | null;          // env fingerprint from load → echoed on apply
  history: History | null;     // undo/redo over the edited model
  layer: HTMLElement | null;
  selectedId: string | null;
  applying: boolean;
  preview: PlanNote[] | null;   // non-null → the apply-preview modal is open
  picker: string | null;        // containerId the add-widget picker is open for
  movePicker: string | null;    // widgetId the move-destination menu is open for
  onScroll: (() => void) | null;
}
const bp: BpState = {
  active: false, baseline: null, ctx: null, env: null, history: null,
  layer: null, selectedId: null, applying: false, preview: null, picker: null, movePicker: null, onScroll: null,
};

export function isBlueprintActive(): boolean { return bp.active; }

/** Curated add palette — the common, verified-addable widget types grouped for the picker. Display
 *  names are friendly; the key is the BMP className. (A full per-host live-derived palette is a
 *  later refinement — these all add cleanly to a Scorecard/template container.) */
const PALETTE: { group: string; items: { key: string; name: string }[] }[] = [
  { group: 'Status', items: [
    { key: 'SimpleStatus', name: 'Simple Status' }, { key: 'Status', name: 'Status' },
    { key: 'FunctionStatus', name: 'Function Status' }, { key: 'Trend', name: 'Trend' } ] },
  { group: 'Charts', items: [
    { key: 'BarChart', name: 'Bar Chart' }, { key: 'LineChart', name: 'Line Chart' },
    { key: 'BarLineChart', name: 'Bar & Line' }, { key: 'PieChart', name: 'Pie Chart' },
    { key: 'AreaChart', name: 'Area Chart' }, { key: 'RadarChart', name: 'Radar Chart' } ] },
  { group: 'Tables & Lists', items: [
    { key: 'ExtendedTable', name: 'Extended Table' }, { key: 'RiskList', name: 'Risk List' },
    { key: 'CheckList', name: 'Check List' }, { key: 'IssueList', name: 'Issue List' } ] },
  { group: 'Text & Media', items: [
    { key: 'TextElement', name: 'Text' }, { key: 'DescriptionView', name: 'Description' },
    { key: 'ImageView', name: 'Image' }, { key: 'Spacer', name: 'Spacer' } ] },
  { group: 'Input & Action', items: [
    { key: 'InputView', name: 'Input View' }, { key: 'ActionButton', name: 'Action Button' },
    { key: 'CustomVisualization', name: 'Custom (CVO)' }, { key: 'URLView', name: 'URL / Embed' } ] },
];

/** The edited model = history present (baseline + staged edits). */
const model = (): LModel | null => bp.history?.present() ?? null;
const mutate = (next: LModel): void => { bp.history?.push(next); render(); };

const CSS = `
#${LAYER_ID}{position:fixed;inset:0;z-index:2147483600;font:12px/1.3 Inter,system-ui,sans-serif;pointer-events:none}
#${LAYER_ID} *{box-sizing:border-box}
#${LAYER_ID} .bp-cont{position:absolute;border:1px dashed #9D7BFF;border-radius:4px;pointer-events:none}
#${LAYER_ID} .bp-cadd{position:absolute;top:-10px;right:6px;width:20px;height:20px;border-radius:50%;border:1px solid #9D7BFF;background:#0B2138;color:#9D7BFF;font:700 13px Inter;line-height:1;cursor:pointer;pointer-events:auto;padding:0}
#${LAYER_ID} .bp-cadd:hover{background:#9D7BFF;color:#0B2138}
#${LAYER_ID} .bp-box.bp-new{border-style:dashed;border-color:#46C9D6;background:rgba(70,201,214,.07)}
#${LAYER_ID} .bp-lab .newtag{background:#46C9D6;color:#08131f;font-size:9px;font-weight:700;padding:1px 5px;border-radius:3px;letter-spacing:.06em}
#${LAYER_ID} .bp-pick-back{position:fixed;inset:0;pointer-events:auto}
#${LAYER_ID} .bp-pick{position:absolute;width:300px;max-height:400px;display:flex;flex-direction:column;background:#0B2138;border:1px solid #46C9D6;border-radius:9px;box-shadow:0 10px 40px rgba(0,0,0,.55);overflow:hidden}
#${LAYER_ID} .bp-pick-h{padding:10px 12px;font-weight:700;font-size:12px;color:#dbe7f5;border-bottom:1px solid #1c3a56}
#${LAYER_ID} .bp-pick-s{margin:8px 10px;padding:6px 9px;background:#081726;border:1px solid #2a4a66;border-radius:5px;color:#dbe7f5;font:12px Inter;outline:none}
#${LAYER_ID} .bp-pick-s:focus{border-color:#46C9D6}
#${LAYER_ID} .bp-pick-list{overflow:auto;padding:0 6px 8px}
#${LAYER_ID} .bp-pick-grp{padding:6px 8px 2px;color:#7d93a8;font-size:9.5px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
#${LAYER_ID} .bp-pick-it{display:flex;justify-content:space-between;align-items:baseline;width:100%;padding:6px 9px;border:0;border-radius:5px;background:transparent;color:#cfe0f0;font:12px Inter;cursor:pointer;text-align:left}
#${LAYER_ID} .bp-pick-it:hover{background:#16344f}
#${LAYER_ID} .bp-pick-it .k{font:10px ui-monospace,monospace;color:#6f879c}
#${LAYER_ID} .bp-box{position:absolute;border:1.5px solid #82B4DE;border-radius:3px;background:rgba(130,180,222,.06);box-shadow:inset 0 0 22px rgba(130,180,222,.08);pointer-events:auto;cursor:pointer}
#${LAYER_ID} .bp-box.bp-chart{border-color:#93A7E6;background:rgba(147,167,230,.06)}
#${LAYER_ID} .bp-box.sel{border-color:#46C9D6;box-shadow:inset 0 0 0 1px #46C9D6}
#${LAYER_ID} .bp-box.changed{border-style:solid;border-color:#E0A85A}
#${LAYER_ID} .bp-box.moved{opacity:.65;border-style:dashed}
#${LAYER_ID} .bp-box.del{border-color:#E0727A;background:rgba(224,114,122,.08)}
#${LAYER_ID} .bp-box.del .bp-nm{text-decoration:line-through;opacity:.6}
#${LAYER_ID} .bp-lab{position:absolute;top:0;left:0;display:flex;gap:6px;align-items:baseline;max-width:100%;padding:3px 7px;color:#dbe7f5;background:rgba(11,33,56,.85);border-radius:3px 0 4px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#${LAYER_ID} .bp-lab .ty{font-size:10px;letter-spacing:.04em;color:#82B4DE;opacity:.85}
#${LAYER_ID} .bp-lab .wd{font-size:10px;font-weight:600;color:#9fb4c8}
#${LAYER_ID} .bp-lab .delta{font-size:10px;font-weight:700;color:#E0A85A}
#${LAYER_ID} .bp-nm[contenteditable]{outline:1px solid #46C9D6;border-radius:2px;padding:0 2px}
#${LAYER_ID} .bp-tools{position:absolute;z-index:5;display:flex;gap:4px;align-items:center;padding:4px;background:#0B2138;border:1px solid #46C9D6;border-radius:7px;box-shadow:0 4px 16px rgba(0,0,0,.45);pointer-events:auto}
#${LAYER_ID} .bp-seg{display:flex;border:1px solid #2a4a66;border-radius:4px;overflow:hidden}
#${LAYER_ID} .bp-seg button{width:20px;height:22px;border:0;background:#14304a;color:#9fb4c8;font:600 11px Inter;cursor:pointer}
#${LAYER_ID} .bp-seg button.on{background:#46C9D6;color:#08131f}
#${LAYER_ID} .bp-tools .btn{height:22px;padding:0 8px;border:1px solid #2a4a66;border-radius:4px;background:#14304a;color:#cfe0f0;font:600 11px Inter;cursor:pointer}
#${LAYER_ID} .bp-tools .btn.del{color:#E0727A;border-color:#5a2a2e}
#${LAYER_ID} .bp-tools .lbl{color:#7d93a8;font-size:10px;padding:0 2px}
#${LAYER_ID} .bp-chip{position:fixed;top:10px;left:50%;transform:translateX(-50%);display:flex;gap:10px;align-items:center;padding:6px 8px 6px 12px;background:#0B2138;color:#dbe7f5;border:1px solid #9D7BFF;border-radius:9px;box-shadow:0 4px 18px rgba(0,0,0,.45);pointer-events:auto}
#${LAYER_ID} .bp-chip.tmpl{border-color:#E0A85A}
#${LAYER_ID} .bp-chip b{font-weight:700;letter-spacing:.06em;color:#9D7BFF}
#${LAYER_ID} .bp-chip.tmpl b{color:#E0A85A}
#${LAYER_ID} .bp-chip .warn{color:#E0A85A;font-weight:600;font-size:11px}
#${LAYER_ID} .bp-chip .sp{color:#3a5573}
#${LAYER_ID} .bp-chip button{height:24px;padding:0 10px;border-radius:5px;border:1px solid #2a4a66;background:#14304a;color:#cfe0f0;font:600 11px Inter;cursor:pointer}
#${LAYER_ID} .bp-chip button:disabled{opacity:.4;cursor:default}
#${LAYER_ID} .bp-chip button.apply{background:#46C9D6;color:#08131f;border-color:#46C9D6}
#${LAYER_ID} .bp-chip.tmpl button.apply{background:#E0A85A;border-color:#E0A85A}
#${LAYER_ID} .bp-modal-back{position:fixed;inset:0;background:rgba(4,12,22,.55);display:flex;align-items:center;justify-content:center;pointer-events:auto}
#${LAYER_ID} .bp-modal{width:520px;max-width:92vw;max-height:80vh;display:flex;flex-direction:column;background:#0B2138;color:#dbe7f5;border:1px solid #46C9D6;border-radius:10px;box-shadow:0 12px 48px rgba(0,0,0,.6)}
#${LAYER_ID} .bp-modal.tmpl{border-color:#E0A85A}
#${LAYER_ID} .bp-modal-h{padding:14px 16px;font-weight:700;font-size:14px;border-bottom:1px solid #1c3a56}
#${LAYER_ID} .bp-modal-warn{margin:10px 14px 0;padding:8px 10px;background:rgba(224,168,90,.12);border:1px solid #E0A85A;border-radius:6px;color:#E0A85A;font-size:11.5px;font-weight:600}
#${LAYER_ID} .bp-modal-list{overflow:auto;padding:8px 6px;display:flex;flex-direction:column;gap:2px}
#${LAYER_ID} .bp-prow{display:flex;align-items:baseline;gap:8px;padding:6px 10px;border-radius:5px;font-size:12px}
#${LAYER_ID} .bp-prow:hover{background:#0f283f}
#${LAYER_ID} .bp-prow .ic{width:16px;text-align:center;flex:none}
#${LAYER_ID} .bp-prow.v-delete{color:#E0727A}
#${LAYER_ID} .bp-prow.v-create{color:#7fd1a8}
#${LAYER_ID} .bp-prow code{margin-left:auto;font:10.5px ui-monospace,monospace;color:#7d93a8;opacity:.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:48%}
#${LAYER_ID} .bp-modal-foot{display:flex;justify-content:flex-end;gap:8px;padding:12px 14px;border-top:1px solid #1c3a56}
#${LAYER_ID} .bp-modal-foot button{height:30px;padding:0 16px;border-radius:6px;border:1px solid #2a4a66;background:#14304a;color:#cfe0f0;font:600 12px Inter;cursor:pointer}
#${LAYER_ID} .bp-modal-foot button.apply{background:#46C9D6;color:#08131f;border-color:#46C9D6}
#${LAYER_ID} .bp-modal.tmpl .bp-modal-foot button.apply{background:#E0A85A;border-color:#E0A85A}
`;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID; s.textContent = CSS;
  document.head.appendChild(s);
}

export function enableBlueprint(): void {
  if (bp.active) return;
  const { rid } = extractUrlRids();
  if (!rid) { showToast('Blueprint: no BMP object on this page', 'error'); return; }
  bp.active = true;
  ensureStyle();
  const layer = document.createElement('div');
  layer.id = LAYER_ID;
  const c = document.createElement('div'); c.className = 'bp-chip';
  c.innerHTML = '<b>BLUEPRINT</b><span>loading…</span>';
  layer.appendChild(c);
  document.body.appendChild(layer);
  bp.layer = layer;
  bp.onScroll = () => bp.baseline && render();
  window.addEventListener('scroll', bp.onScroll, true);
  window.addEventListener('resize', bp.onScroll, true);
  // click empty space deselects
  layer.addEventListener('mousedown', (e) => { if (e.target === layer) select(null); });
  sendToSW({ type: 'LAYOUT_LOAD', rid });
}

export function disableBlueprint(): void {
  if (!bp.active) return;
  if (bp.onScroll) {
    window.removeEventListener('scroll', bp.onScroll, true);
    window.removeEventListener('resize', bp.onScroll, true);
  }
  bp.layer?.remove();
  Object.assign(bp, { active: false, baseline: null, ctx: null, env: null, history: null, layer: null, selectedId: null, applying: false, preview: null, picker: null, movePicker: null, onScroll: null });
}

export function onLayoutLoaded(msg: { ok: boolean; env?: string; ctx?: BlueprintCtx; model?: LModel; orphans?: unknown[]; error?: string }): void {
  if (!bp.active) return;
  if (!msg.ok || !msg.model || !msg.ctx) {
    showToast(`Blueprint: ${msg.error || 'could not load this page'}`, 'error');
    disableBlueprint();
    return;
  }
  bp.baseline = msg.model;
  bp.ctx = msg.ctx;
  bp.env = msg.env ?? null;
  bp.history = new History(msg.model);
  bp.selectedId = null;
  const orphans = msg.orphans?.length ?? 0;
  if (orphans) showToast(`Blueprint: ${orphans} widget(s) not on any tab (RESULT)`, 'info');
  render();
}

export function onApplyResult(msg: { ok: boolean; noop: boolean; stale?: boolean; model?: LModel; baseline?: LModel; error?: string }): void {
  if (!bp.active) return;
  bp.applying = false;
  if (msg.stale && msg.model) {
    bp.baseline = msg.model; bp.history = new History(msg.model); bp.selectedId = null;
    showToast('Blueprint: the page changed elsewhere — reloaded. Re-apply your edits.', 'error');
    render(); return;
  }
  if (!msg.ok) { showToast(`Blueprint apply failed: ${msg.error || 'unknown'}`, 'error'); render(); return; }
  if (msg.model) { bp.baseline = msg.model; bp.history = new History(msg.model); bp.selectedId = null; }
  showToast(msg.noop ? 'Blueprint: nothing to apply' : 'Blueprint: changes applied', 'success');
  render();
}

// ── editing actions (pure ops → history → re-render) ────────────────────────
function select(id: string | null): void { bp.selectedId = id; render(); }
function setWidth(id: string, n: number): void { const m = model(); if (m) mutate(resize(m, id, 'L', n)); }
function setH(id: string, px: number): void { const m = model(); if (m) mutate(setHeight(m, id, px)); }
function doRename(id: string, name: string): void { const m = model(); if (m) mutate(rename(m, id, name)); }
function doDelete(id: string): void { const m = model(); if (m) { bp.selectedId = null; mutate(remove(m, id)); } }
function openPicker(containerId: string): void { bp.picker = containerId; bp.selectedId = null; render(); }
function closePicker(): void { bp.picker = null; render(); }
function addFromPicker(className: string): void {
  const m = model(); const cid = bp.picker;
  if (!m || !cid) return;
  const f = findNode(m, cid);
  const idx = f ? f.node.children.length : 0;
  const added = addWidget(m, cid, idx, className);
  bp.picker = null;
  bp.selectedId = added.id;
  mutate(added.model);
}
function openMovePicker(id: string): void { bp.movePicker = id; render(); }
function closeMovePicker(): void { bp.movePicker = null; render(); }
function moveTo(id: string, destId: string): void {
  const m = model(); if (!m) return;
  bp.movePicker = null;
  mutate(moveInto(m, id, destId));
}
function undo(): void { const m = bp.history?.undo(); if (m) { bp.selectedId = null; render(); } }
function redo(): void { const m = bp.history?.redo(); if (m) { bp.selectedId = null; render(); } }
function discard(): void { if (bp.baseline) { bp.history = new History(bp.baseline); bp.selectedId = null; render(); } }

/** Apply opens a preview first — never commit blind. The plan is computed with the SAME diff+compile
 *  the SW will run, so the human-readable notes match exactly what gets executed. */
function openApplyPreview(): void {
  const m = model();
  if (!bp.ctx || !bp.baseline || !m || bp.applying) return;
  const plan = diff(bp.baseline, m);
  if (plan.length === 0) { showToast('Blueprint: nothing to apply', 'info'); return; }
  const { notes } = compile(plan, m);
  bp.preview = notes;
  render();
}
function closePreview(): void { bp.preview = null; render(); }

/** Confirmed from the preview modal — fire the guarded SW apply. */
function confirmApply(): void {
  const m = model();
  if (!bp.ctx || !bp.baseline || !bp.env || !m || bp.applying) return;
  bp.preview = null;
  bp.applying = true; render();
  sendToSW({ type: 'LAYOUT_APPLY', env: bp.env, ctx: bp.ctx, baseline: bp.baseline, desired: m });
}

// ── render ──────────────────────────────────────────────────────────────────
function ridElementMap(): Map<string, Element> {
  const map = new Map<string, Element>();
  for (const { element, rid } of getAllRidElements(false)) if (!map.has(rid)) map.set(rid, element);
  return map;
}

function render(): void {
  const layer = bp.layer, base = bp.baseline, m = model(), ctx = bp.ctx;
  if (!layer || !base || !m || !ctx) return;
  layer.textContent = '';
  const byRid = ridElementMap();
  const pending = diff(base, m).length;
  layer.appendChild(renderChip(ctx, pending));

  // container boxes first (behind), sized to the union of their live child-widget rects
  walk(base, (node) => {
    if (node.kind !== 'container') return;
    const rect = unionRect(node, byRid);
    if (!rect) return;
    const state = nodeState(node, m);
    if (state === 'gone') return; // deleted container → its widgets re-home; skip the dashed box
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
  // container's live area, so you can see what will be created and where.
  const stackY = new Map<string, number>();
  walk(m, (node, parent) => {
    if (node.kind !== 'widget' || node.rid || !parent) return; // rid-less ⇒ staged add
    const host = findNode(base, parent.id)?.node;
    const rect = host ? unionRect(host, byRid) : null;
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

function newWidgetBox(node: LNode, r: Rect): HTMLElement {
  const box = document.createElement('div');
  box.className = 'bp-box bp-new' + (isChart(node.className) ? ' bp-chart' : '')
    + (bp.selectedId === node.id ? ' sel' : '');
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

/** The add-widget picker — searchable, grouped. Anchored over the target container. */
function pickerPanel(byRid: Map<string, Element>): HTMLElement {
  const cid = bp.picker!;
  const host = bp.baseline ? findNode(bp.baseline, cid)?.node : null;
  const rect = host ? unionRect(host, byRid) : null;
  const back = document.createElement('div'); back.className = 'bp-pick-back';
  back.addEventListener('mousedown', (e) => { if (e.target === back) closePicker(); });
  const panel = document.createElement('div'); panel.className = 'bp-pick';
  if (rect) { panel.style.left = `${Math.min(rect.left, window.innerWidth - 320)}px`; panel.style.top = `${Math.min(rect.top + 24, window.innerHeight - 420)}px`; }
  else { panel.style.left = '50%'; panel.style.top = '80px'; panel.style.transform = 'translateX(-50%)'; }
  const head = document.createElement('div'); head.className = 'bp-pick-h';
  head.textContent = `Add widget to ${host?.name ?? 'container'}`;
  const search = document.createElement('input'); search.className = 'bp-pick-s'; search.placeholder = 'Search widgets…';
  const list = document.createElement('div'); list.className = 'bp-pick-list';
  const fill = (q: string): void => {
    list.textContent = '';
    const ql = q.trim().toLowerCase();
    for (const grp of PALETTE) {
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

const VERB_ICON: Record<PlanNote['verb'], string> = {
  create: '＋', update: '✎', move: '⇄', reorder: '↕', delete: '🗑',
};

/** The apply-preview: the exact plan (from the same compile the SW runs) as human-readable steps,
 *  with the blast-radius warning, gated behind an explicit confirm. */
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

type State = 'same' | 'changed' | 'gone';
function nodeState(baseNode: LNode, m: LModel): State {
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

function containerBox(baseNode: LNode, rect: Rect, m: LModel): HTMLElement {
  const cur = findNode(m, baseNode.id)?.node;
  const box = document.createElement('div');
  box.className = 'bp-cont';
  Object.assign(box.style, { left: `${rect.left - 3}px`, top: `${rect.top - 3}px`, width: `${rect.width + 6}px`, height: `${rect.height + 6}px` });
  if (cur && cur.cols.L !== baseNode.cols.L) box.style.borderColor = '#E0A85A';
  // "+ widget" affordance — top-right of the container, the only interactive part of the dashed box
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

  // width segmented 1..6
  const lblW = document.createElement('span'); lblW.className = 'lbl'; lblW.textContent = 'W'; t.appendChild(lblW);
  const seg = document.createElement('div'); seg.className = 'bp-seg';
  for (let i = 1; i <= 6; i++) {
    const b = document.createElement('button'); b.textContent = String(i);
    if (node.cols.L === i) b.classList.add('on');
    b.addEventListener('mousedown', (e) => { e.stopPropagation(); setWidth(node.id, i); });
    seg.appendChild(b);
  }
  t.appendChild(seg);

  // height for charts/URLView
  if (node.kind === 'widget' && hasHeight(node.className)) {
    const minus = mkBtn('H−', () => setH(node.id, (node.height ?? 200) - 40));
    const plus = mkBtn('H+', () => setH(node.id, (node.height ?? 200) + 40));
    t.append(minus, plus);
  }

  // move (widgets only — reparent to another container/tab)
  if (node.kind === 'widget') t.appendChild(mkBtn('Move →', () => openMovePicker(node.id)));
  // rename
  t.appendChild(mkBtn('Rename', () => startRename(node.id)));
  // delete
  const del = mkBtn('Delete', () => doDelete(node.id)); del.classList.add('del');
  t.appendChild(del);
  return t;
}

/** Move-destination menu: every container + tab except the widget's current owner. Labels carry the
 *  tab context so "Detail" vs "KPIs" is unambiguous. */
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

function startRename(id: string): void {
  // inline-edit the label's name span
  render();
  const nm = bp.layer?.querySelector(`.bp-box.sel .bp-nm`) as HTMLElement | null;
  if (!nm) return;
  nm.setAttribute('contenteditable', 'true');
  nm.focus();
  const range = document.createRange(); range.selectNodeContents(nm);
  const sel = getSelection(); sel?.removeAllRanges(); sel?.addRange(range);
  const commit = () => { nm.removeAttribute('contenteditable'); doRename(id, nm.textContent ?? ''); };
  nm.addEventListener('blur', commit, { once: true });
  nm.addEventListener('keydown', (e) => {
    if ((e as KeyboardEvent).key === 'Enter') { e.preventDefault(); nm.blur(); }
    if ((e as KeyboardEvent).key === 'Escape') { nm.textContent = findNode(model()!, id)?.node.name ?? ''; nm.blur(); }
  });
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
  return c;
}

// ── geometry + dom helpers ──────────────────────────────────────────────────
interface Rect { left: number; top: number; width: number; height: number; }
function unionRect(node: LNode, byRid: Map<string, Element>): Rect | null {
  let l = Infinity, t = Infinity, rr = -Infinity, bb = -Infinity, any = false;
  for (const w of descendantWidgets(node)) {
    if (!w.rid) continue;
    const el = byRid.get(w.rid); if (!el) continue;
    const r = el.getBoundingClientRect(); if (!r.width && !r.height) continue;
    l = Math.min(l, r.left); t = Math.min(t, r.top); rr = Math.max(rr, r.right); bb = Math.max(bb, r.bottom); any = true;
  }
  return any ? { left: l, top: t, width: rr - l, height: bb - t } : null;
}
function anchorRect(node: LNode, byRid: Map<string, Element>): Rect | null {
  if (node.kind === 'widget' && node.rid) {
    const el = byRid.get(node.rid); if (!el) return null;
    const r = el.getBoundingClientRect(); return { left: r.left, top: r.top, width: r.width, height: r.height };
  }
  return unionRect(node, byRid);
}
function mkBtn(text: string, on: () => void): HTMLButtonElement {
  const b = document.createElement('button'); b.className = 'btn'; b.textContent = text;
  b.addEventListener('mousedown', (e) => { e.stopPropagation(); on(); });
  return b;
}
function delta(text: string): HTMLElement { const s = document.createElement('span'); s.className = 'delta'; s.textContent = text; return s; }
function sp(): HTMLElement { const s = document.createElement('span'); s.className = 'sp'; s.textContent = '|'; return s; }

log.debug('blueprint', 'module loaded');
