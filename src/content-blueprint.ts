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
import { cancelGesture } from './content-blueprint/gestures';
import { loadPage } from './content-blueprint/service';

export { isBlueprintActive };

/** The overlay self-hosts its fonts: Inter (latin, bundled in the extension) isn't loaded in BMP's
 *  host page, so a bare `font: … Inter` with no generic fallback dropped <button>s to the UA serif.
 *  We register the bundled woff2s under private family names and the CSS references those (with
 *  sans/mono fallbacks), so the overlay renders identically regardless of the host page's fonts. */
function fontFaceCss(): string {
  const inter = (w: number) => chrome.runtime.getURL(`assets/inter-${w}.woff2`);
  const mono = chrome.runtime.getURL('assets/jetbrains-mono-400.woff2');
  return [400, 500, 600, 700]
    .map(w => `@font-face{font-family:'BPInter';font-weight:${w};font-display:swap;src:url('${inter(w)}') format('woff2')}`)
    .join('') +
    `@font-face{font-family:'BPMono';font-weight:400;font-display:swap;src:url('${mono}') format('woff2')}`;
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID; s.textContent = fontFaceCss() + BLUEPRINT_CSS;
  document.head.appendChild(s);
}

export function enableBlueprint(): void {
  if (bp.active) return;
  const { rid } = extractUrlRids();
  if (!rid) { showToast('Blueprint: no BMP object on this page', 'error'); return; }
  bp.active = true;
  bp.gen += 1; // new session — invalidates any in-flight load/apply from a prior toggle
  ensureStyle();
  const layer = document.createElement('div');
  layer.id = 'crev-blueprint-layer';
  const head = document.createElement('div'); head.className = 'bp-header';
  const c = document.createElement('div'); c.className = 'bp-chip';
  c.innerHTML = '<b>BLUEPRINT</b><span>loading…</span>';
  head.appendChild(c); layer.appendChild(head);
  document.body.appendChild(layer);
  bp.layer = layer;
  // The layer is document-absolute, so the canvas + cards scroll natively with the page — NO scroll
  // re-render (that JS-follow was the lag + header-overshadow). Only a RESIZE needs a re-anchor (BMP
  // reflows its widgets), coalesced to one animation frame.
  bp.onScroll = () => { if (bp.baseline && !bp.raf && !bp.dragging && !bp.renaming) bp.raf = requestAnimationFrame(() => { bp.raf = 0; render(); }); };
  window.addEventListener('resize', bp.onScroll, true);
  bp.onKey = onKeydown;
  window.addEventListener('keydown', bp.onKey, true);
  layer.addEventListener('mousedown', (e) => { if (e.target === layer) select(null); }); // empty space deselects
  // Watch BMP content for a tab switch (SPA — no reload): when the set of visible widget rids changes,
  // re-render so the overlay follows to the newly-shown tab. Gated by the rid signature so the overlay's
  // OWN mutations (its nodes carry no data-rid) never re-trigger it, and coalesced to one rAF.
  bp.observer = new MutationObserver(() => {
    if (bp.mutRaf || !bp.active) return;
    bp.mutRaf = requestAnimationFrame(() => {
      bp.mutRaf = 0;
      if (!bp.active || !bp.baseline || bp.dragging || bp.renaming) return;
      const sig = ridSignature();
      if (sig !== bp.ridSig) { bp.ridSig = sig; bp.viewTabId = null; render(); } // BMP switched tab → canvas follows it
    });
  });
  bp.observer.observe(document.body, { childList: true, subtree: true });
  void loadPage(rid).then((ok) => { if (!ok) disableBlueprint(); });
}

/** Sorted set of the live widget rids — changes exactly when BMP swaps tabs (or otherwise re-renders
 *  its widget set). Cheap; the overlay's own nodes carry data-bpid, not data-rid, so they don't count. */
function ridSignature(): string {
  return [...document.querySelectorAll('[data-rid]')].map((el) => (el as HTMLElement).dataset.rid).sort().join(',');
}

export function disableBlueprint(): void {
  if (!bp.active) return;
  cancelGesture(); // rip out any in-flight drag/resize listeners + body-level ghost/line elements
  if (bp.onScroll) {
    window.removeEventListener('scroll', bp.onScroll, true);
    window.removeEventListener('resize', bp.onScroll, true);
  }
  if (bp.onKey) window.removeEventListener('keydown', bp.onKey, true);
  if (bp.raf) cancelAnimationFrame(bp.raf);
  if (bp.mutRaf) cancelAnimationFrame(bp.mutRaf);
  bp.observer?.disconnect();
  bp.layer?.remove();
  bp.scrollSpacer?.remove(); // drop the page-scroll-extension spacer (it lives on body, outside the layer)
  document.getElementById(STYLE_ID)?.remove(); // don't leak the injected stylesheet past teardown
  Object.assign(bp, { active: false, baseline: null, ctx: null, env: null, history: null, layer: null, selectedId: null, applying: false, preview: null, picker: null, pickerOpts: null, movePicker: null, onScroll: null, onKey: null, raf: 0, hint: null, trayOpen: false, dragging: false, renaming: false, observer: null, ridSig: '', mutRaf: 0, needsTabset: null, creatingTabset: false, flipNext: false, viewTabId: null, scrollSpacer: null, peek: false });
}
// Load/apply results are handled by content-blueprint/service.ts (the sendRequest promises), not by
// a port-dispatched handler — see that module.
