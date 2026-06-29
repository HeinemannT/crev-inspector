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
import { bp, STYLE_ID, isBlueprintActive, resetState } from './content-blueprint/state';
import { render } from './content-blueprint/view';
import { select, onKeydown, clearHintTimer } from './content-blueprint/actions';
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
  document.body.appendChild(layer);
  bp.layer = layer;
  mountLoadingShell();
  // The layer is document-absolute, so the canvas + cards scroll natively with the page — NO scroll
  // re-render (that JS-follow was the lag + header-overshadow). Only a RESIZE needs a re-anchor (BMP
  // reflows its widgets), coalesced to one animation frame.
  const coalescedRender = () => { if (bp.baseline && !bp.raf && !bp.dragging && !bp.renaming) bp.raf = requestAnimationFrame(() => { bp.raf = 0; render(); }); };
  bp.onResize = coalescedRender;
  window.addEventListener('resize', bp.onResize, true);
  // BMP renders a tall widget's content asynchronously (an ExtendedTable fetches its rows AFTER the tab
  // switches), so a re-render fired on the tab switch alone measures the table before it's grown and the
  // canvas backdrop ends up too short — the real table then peeks out below it. A ResizeObserver on the
  // body's content box catches that later growth (the page reflows taller) and re-renders to re-measure.
  // The overlay's own layer + scroll-spacer are position:absolute (out of flow), so they don't change the
  // content box → no feedback loop. Coalesced through the same rAF as resize.
  let lastBodyH = 0;
  bp.resizeObs = new ResizeObserver((entries) => {
    const h = entries[0]?.contentRect.height ?? 0;
    if (Math.abs(h - lastBodyH) < 2) return; // ignore sub-pixel jitter / animation churn
    lastBodyH = h;
    coalescedRender();
  });
  bp.resizeObs.observe(document.body);
  bp.onKey = onKeydown;
  window.addEventListener('keydown', bp.onKey, true);
  bp.loadedRid = rid;
  // Browser back/forward (popstate) is a soft navigation in BMP's portal — the document stays, so our
  // overlay survives but its loaded model is for the OLD page. Detect a PAGE change (the URL ?rid=
  // changed) and reload the overlay onto the new page; a same-page back (only ?tabrid= changed) is left
  // to the MutationObserver, which follows the tab. Off a BMP object entirely → tear down. (Graceful
  // teardown only — staged edits on the old page are dropped, same as a manual reload.)
  bp.onPop = () => {
    if (!bp.active) return;
    const next = extractUrlRids().rid;
    if (!next) { disableBlueprint(); return; }
    if (next === bp.loadedRid) return; // same page — the observer re-anchors to the new tab
    reloadForRid(next);
  };
  window.addEventListener('popstate', bp.onPop);
  layer.addEventListener('mousedown', (e) => { if (e.target === layer) select(null); }); // empty space deselects
  // Watch BMP content for a tab switch (SPA — no reload): when the set of visible widget rids changes,
  // re-render so the overlay follows to the newly-shown tab. Gated by the rid signature so the overlay's
  // OWN mutations (its nodes carry no data-rid) never re-trigger it, and coalesced to one rAF.
  bp.observer = new MutationObserver(() => {
    if (bp.mutRaf || !bp.active) return;
    bp.mutRaf = requestAnimationFrame(() => {
      bp.mutRaf = 0;
      if (!bp.active || bp.dragging || bp.renaming) return;
      // A different PAGE is now showing — a link-nav (pushState, no popstate) or a back/forward to
      // another object. The loaded model is for the old page, so reload onto the new one rather than
      // painting a stale wireframe over it. (Back/forward also fires popstate, which clears it more
      // immediately; this catches the forward link-navs popstate misses.)
      const urlRid = extractUrlRids().rid;
      if (urlRid && urlRid !== bp.loadedRid) { reloadForRid(urlRid); return; }
      if (!bp.baseline) return;
      const sig = ridSignature();
      if (sig !== bp.ridSig) { bp.ridSig = sig; bp.viewTabId = null; render(); } // same page → canvas follows the tab switch
    });
  });
  bp.observer.observe(document.body, { childList: true, subtree: true });
  void loadPage(rid).then((ok) => { if (!ok) disableBlueprint(); });
}

/** Reset the layer to the "loading…" chip — the initial shell, and what a page-change reload shows
 *  while the new model fetches (render() no-ops with no baseline, so it won't clear the stale canvas). */
function mountLoadingShell(): void {
  const layer = bp.layer; if (!layer) return;
  layer.textContent = '';
  const head = document.createElement('div'); head.className = 'bp-header';
  const c = document.createElement('div'); c.className = 'bp-chip';
  c.innerHTML = '<b>BLUEPRINT</b><span>loading…</span>';
  head.appendChild(c); layer.appendChild(head);
}

/** Reload the overlay for `rid` — drops the stale model + any staged edits, bumps the session gen so an
 *  in-flight load/apply can't land, shows the loading shell, and re-loads — tearing down if it isn't an
 *  editable page. Used by both the page-change handler (C) and the template/instance toggle (F, same rid,
 *  different `prefer`). */
function reloadForRid(rid: string, prefer: 'template' | 'instance' = 'template'): void {
  bp.loadedRid = rid;
  bp.gen += 1; // invalidate any in-flight load/apply for the old page
  bp.baseline = null; bp.ctx = null; bp.history = null; bp.selectedId = null; bp.viewTabId = null; bp.ridSig = '';
  bp.peek = false; bp.layer?.classList.remove('bp-peek');
  mountLoadingShell(); // clear the old page's canvas immediately (render() won't, with no baseline)
  void loadPage(rid, prefer).then((ok) => { if (!ok) disableBlueprint(); });
}

/** F: switch between editing the shared TEMPLATE and THIS instance. Reloads the same page with the
 *  opposite `prefer`; staged edits are dropped (same as any reload — flagged with a toast when present).
 *  No-op when already in the requested mode. Offered only when a templated instance is loaded. */
export function setEditTarget(toTemplate: boolean): void {
  if (!bp.active || bp.editingTemplate === toTemplate) return;
  if (bp.history?.canUndo()) showToast('Blueprint: switched target — unsaved layout edits were discarded', 'info');
  reloadForRid(bp.loadedRid, toTemplate ? 'template' : 'instance');
}

/** Sorted set of the live widget rids — changes exactly when BMP swaps tabs (or otherwise re-renders
 *  its widget set). Cheap; the overlay's own nodes carry data-bpid, not data-rid, so they don't count. */
function ridSignature(): string {
  return [...document.querySelectorAll('[data-rid]')].map((el) => (el as HTMLElement).dataset.rid).sort().join(',');
}

export function disableBlueprint(): void {
  if (!bp.active) return;
  cancelGesture(); // rip out any in-flight drag/resize listeners + body-level ghost/line elements
  clearHintTimer(); // a pending flashHint render() must not fire after teardown
  if (bp.onResize) window.removeEventListener('resize', bp.onResize, true);
  if (bp.onKey) window.removeEventListener('keydown', bp.onKey, true);
  if (bp.onPop) window.removeEventListener('popstate', bp.onPop);
  if (bp.raf) cancelAnimationFrame(bp.raf);
  if (bp.mutRaf) cancelAnimationFrame(bp.mutRaf);
  bp.observer?.disconnect();
  bp.resizeObs?.disconnect();
  bp.layer?.remove();
  bp.scrollSpacer?.remove(); // drop the page-scroll-extension spacer (it lives on body, outside the layer)
  document.getElementById(STYLE_ID)?.remove(); // don't leak the injected stylesheet past teardown
  resetState(); // every per-session field back to idle (one source of truth — see state.ts)
}
// Load/apply results are handled by content-blueprint/service.ts (the sendRequest promises), not by
// a port-dispatched handler — see that module.
