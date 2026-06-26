/**
 * Blueprint overlay (content script) — milestone 3.1: READ-ONLY render of a loaded layout model,
 * pixel-aligned to the live BMP DOM.
 *
 * Flow: enable() → request LAYOUT_LOAD for the page rid → onLayoutLoaded() stores the model →
 * render() draws an absolutely-positioned box over every widget whose BMP rid matches a live DOM
 * element (via getAllRidElements, the same rid→element map the inspect overlay uses). The boxes
 * reposition on scroll/resize. No gestures yet — this milestone proves the load path renders
 * faithfully over the real page. Selection/resize/drag land in 3.2+.
 *
 * The model is the source of truth for LABELS (name, type, column width, businessId); the DOM is
 * the source of truth for GEOMETRY. That split is deliberate — the same model drives the apply
 * path, so what you see is what you'll edit.
 */
import type { LModel, LNode } from './lib/layout/types';
import type { BlueprintCtx } from './lib/layout/sync';
import { getAllRidElements } from './lib/dom-scanner';
import { extractUrlRids } from './lib/dom-scanner';
import { sendToSW } from './lib/content-port';
import { showToast } from './lib/toast';
import { log } from './lib/logger';

const LAYER_ID = 'crev-blueprint-layer';
const STYLE_ID = 'crev-blueprint-style';

interface BpState {
  active: boolean;
  loading: boolean;
  model: LModel | null;
  ctx: BlueprintCtx | null;
  layer: HTMLElement | null;
  onScroll: (() => void) | null;
}
const bp: BpState = { active: false, loading: false, model: null, ctx: null, layer: null, onScroll: null };

export function isBlueprintActive(): boolean { return bp.active; }

/** Blueprint palette — matches the validated overlay.js / mockup so the two read identically. */
const CSS = `
#${LAYER_ID}{position:fixed;inset:0;z-index:2147483600;pointer-events:none;font:12px/1.3 Inter,system-ui,sans-serif}
#${LAYER_ID} .bp-box{position:absolute;border:1.5px solid #82B4DE;border-radius:3px;background:rgba(130,180,222,.06);box-shadow:inset 0 0 22px rgba(130,180,222,.08)}
#${LAYER_ID} .bp-box.bp-chart{border-color:#93A7E6;background:rgba(147,167,230,.06)}
#${LAYER_ID} .bp-lab{position:absolute;top:0;left:0;display:flex;gap:6px;align-items:baseline;max-width:100%;padding:3px 7px;color:#dbe7f5;background:rgba(11,33,56,.82);border-radius:3px 0 4px 0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#${LAYER_ID} .bp-lab .ty{font-size:10px;letter-spacing:.04em;color:#82B4DE;opacity:.85}
#${LAYER_ID} .bp-lab .wd{font-size:10px;font-weight:600;color:#9fb4c8}
#${LAYER_ID} .bp-chip{position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:1;display:flex;gap:8px;align-items:center;padding:6px 12px;background:#0B2138;color:#dbe7f5;border:1px solid #9D7BFF;border-radius:8px;box-shadow:0 4px 18px rgba(0,0,0,.4)}
#${LAYER_ID} .bp-chip b{font-weight:600;letter-spacing:.06em;color:#9D7BFF}
#${LAYER_ID} .bp-chip .warn{color:#E0A85A;font-weight:600}
`;

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = CSS;
  document.head.appendChild(s);
}

/** Enable blueprint mode: mount the layer and request the layout model for the current page. */
export function enableBlueprint(): void {
  if (bp.active) return;
  const { rid } = extractUrlRids();
  if (!rid) { showToast('Blueprint: no BMP object on this page', 'error'); return; }
  bp.active = true;
  bp.loading = true;
  ensureStyle();
  const layer = document.createElement('div');
  layer.id = LAYER_ID;
  layer.appendChild(chip('loading…'));
  document.body.appendChild(layer);
  bp.layer = layer;
  bp.onScroll = () => bp.model && render();
  window.addEventListener('scroll', bp.onScroll, true);
  window.addEventListener('resize', bp.onScroll, true);
  sendToSW({ type: 'LAYOUT_LOAD', rid });
  log.debug('blueprint', `enable: requested LAYOUT_LOAD for ${rid}`);
}

/** Tear down the overlay. */
export function disableBlueprint(): void {
  if (!bp.active) return;
  if (bp.onScroll) {
    window.removeEventListener('scroll', bp.onScroll, true);
    window.removeEventListener('resize', bp.onScroll, true);
  }
  bp.layer?.remove();
  Object.assign(bp, { active: false, loading: false, model: null, ctx: null, layer: null, onScroll: null });
}

/** Consume a LAYOUT_LOAD_RESULT. Called from the content message dispatch. */
export function onLayoutLoaded(msg: { ok: boolean; ctx?: BlueprintCtx; model?: LModel; orphans?: unknown[]; error?: string }): void {
  if (!bp.active) return;             // toggled off before the result arrived
  bp.loading = false;
  if (!msg.ok || !msg.model || !msg.ctx) {
    showToast(`Blueprint: ${msg.error || 'could not load this page'}`, 'error');
    disableBlueprint();
    return;
  }
  bp.model = msg.model;
  bp.ctx = msg.ctx;
  const orphans = msg.orphans?.length ?? 0;
  if (orphans) showToast(`Blueprint: ${orphans} widget(s) not placed on any tab (RESULT)`, 'info');
  render();
}

const isChartClass = (c: string): boolean => /Chart$/.test(c) || c === 'URLView';

/** Draw the read-only overlay: a box per widget that has a live DOM element. */
function render(): void {
  const layer = bp.layer, model = bp.model, ctx = bp.ctx;
  if (!layer || !model || !ctx) return;
  layer.textContent = '';

  // header chip: page identity + LOUD warning when edits hit a shared template (every instance)
  const shared = ctx.target === 'template';
  layer.appendChild(chip(
    `${ctx.pageClass} ${ctx.pageId} · read-only`,
    shared ? 'edits here change the shared template — all instances' : '',
  ));

  // rid → live element (widgets carry data-rid; the inspect overlay uses the same map)
  const byRid = new Map<string, Element>();
  for (const { element, rid } of getAllRidElements(false)) if (!byRid.has(rid)) byRid.set(rid, element);

  let drawn = 0, missing = 0;
  const walk = (nodes: LNode[]): void => {
    for (const node of nodes) {
      if (node.kind === 'widget' && node.rid) {
        const el = byRid.get(node.rid);
        if (el) { drawBox(layer, el, node); drawn++; } else { missing++; }
      }
      walk(node.children);
    }
  };
  for (const tab of model.tabs) walk(tab.children);
  log.debug('blueprint', `render: ${drawn} boxes drawn, ${missing} widgets off-screen/not-in-DOM`);
}

function drawBox(layer: HTMLElement, el: Element, node: LNode): void {
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return; // not rendered (hidden tab / collapsed)
  const box = document.createElement('div');
  box.className = 'bp-box' + (isChartClass(node.className) ? ' bp-chart' : '');
  box.style.left = `${r.left}px`;
  box.style.top = `${r.top}px`;
  box.style.width = `${r.width}px`;
  box.style.height = `${r.height}px`;

  const lab = document.createElement('div');
  lab.className = 'bp-lab';
  const nm = document.createElement('span');
  nm.textContent = node.name;
  const ty = document.createElement('span');
  ty.className = 'ty';
  ty.textContent = node.className.toUpperCase();
  const wd = document.createElement('span');
  wd.className = 'wd';
  wd.textContent = `${node.cols.L}/6`;
  lab.append(nm, ty, wd);
  box.appendChild(lab);
  layer.appendChild(box);
}

function chip(text: string, warn = ''): HTMLElement {
  const c = document.createElement('div');
  c.className = 'bp-chip';
  const b = document.createElement('b');
  b.textContent = 'BLUEPRINT';
  const t = document.createElement('span');
  t.textContent = text;
  c.append(b, t);
  if (warn) {
    const w = document.createElement('span');
    w.className = 'warn';
    w.textContent = `⚠ ${warn}`;
    c.appendChild(w);
  }
  return c;
}
