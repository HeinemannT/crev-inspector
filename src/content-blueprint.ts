/**
 * Blueprint overlay (content script) — the in-browser layout editor's entry point: lifecycle
 * (enable/disable), the load/apply result handlers the content dispatch calls, and the style inject.
 * The editor itself is split across `content-blueprint/`: state (the `bp` singleton + constants),
 * geometry (DOM measurement), view (render), actions (gestures + keyboard). See docs/blueprint.md.
 *
 * Edits are STAGED in a client-side model (the same pure `edit`/`diff` core the SW uses for apply),
 * shown as deltas over the live page — the live BMP grid can't reflow client-side, so a resize shows
 * as a "6→3" badge. Apply commits + re-fetches, and the real grid reflows for keeps.
 */
import { extractUrlRids } from './lib/dom-scanner';
import { showToast } from './lib/toast';
import BLUEPRINT_CSS from './content-blueprint.css';
import { bp, STYLE_ID, isBlueprintActive } from './content-blueprint/state';
import { render } from './content-blueprint/view';
import { select, onKeydown } from './content-blueprint/actions';
import { loadPage } from './content-blueprint/service';

export { isBlueprintActive };

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID; s.textContent = BLUEPRINT_CSS;
  document.head.appendChild(s);
}

export function enableBlueprint(): void {
  if (bp.active) return;
  const { rid } = extractUrlRids();
  if (!rid) { showToast('Blueprint: no BMP object on this page', 'error'); return; }
  bp.active = true;
  ensureStyle();
  const layer = document.createElement('div');
  layer.id = 'crev-blueprint-layer';
  const c = document.createElement('div'); c.className = 'bp-chip';
  c.innerHTML = '<b>BLUEPRINT</b><span>loading…</span>';
  layer.appendChild(c);
  document.body.appendChild(layer);
  bp.layer = layer;
  // Scroll/resize re-renders are coalesced to one per animation frame (smooth on large pages).
  bp.onScroll = () => { if (bp.baseline && !bp.raf) bp.raf = requestAnimationFrame(() => { bp.raf = 0; render(); }); };
  window.addEventListener('scroll', bp.onScroll, true);
  window.addEventListener('resize', bp.onScroll, true);
  bp.onKey = onKeydown;
  window.addEventListener('keydown', bp.onKey, true);
  layer.addEventListener('mousedown', (e) => { if (e.target === layer) select(null); }); // empty space deselects
  void loadPage(rid).then((ok) => { if (!ok) disableBlueprint(); });
}

export function disableBlueprint(): void {
  if (!bp.active) return;
  if (bp.onScroll) {
    window.removeEventListener('scroll', bp.onScroll, true);
    window.removeEventListener('resize', bp.onScroll, true);
  }
  if (bp.onKey) window.removeEventListener('keydown', bp.onKey, true);
  if (bp.raf) cancelAnimationFrame(bp.raf);
  bp.layer?.remove();
  Object.assign(bp, { active: false, baseline: null, ctx: null, env: null, history: null, layer: null, selectedId: null, applying: false, preview: null, picker: null, movePicker: null, onScroll: null, onKey: null, raf: 0 });
}
// Load/apply results are handled by content-blueprint/service.ts (the sendRequest promises), not by
// a port-dispatched handler — see that module.
