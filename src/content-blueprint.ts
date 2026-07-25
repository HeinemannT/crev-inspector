/**
 * Blueprint overlay (content script) — the in-browser layout editor's entry point: lifecycle
 * (enable/disable), the load/apply result handlers the content dispatch calls, and the style inject.
 * The editor itself is split across `content-blueprint/`: state (the `bp` singleton + constants),
 * geometry (DOM measurement), view (render), actions (gestures + keyboard).
 *
 * Edits are STAGED in a client-side model (the same pure `edit`/`diff` core the SW uses for apply),
 * shown as deltas over the live page — the live BMP grid can't reflow client-side, so a resize shows
 * as a "6→3" badge. Apply commits + re-fetches, and the real grid reflows for keeps.
 */
import { extractUrlRids } from './lib/dom-scanner';
import { PICK_CURSOR, APPLY_CURSOR } from './lib/cursors';
import { showToast } from './lib/toast';
import BLUEPRINT_CSS from './content-blueprint.css';
import { bp, STYLE_ID, isBlueprintActive, resetState, resetModel } from './content-blueprint/state';
import { render } from './content-blueprint/view';
import { select, onKeydown, clearHintTimer, hasPendingEdits } from './content-blueprint/actions';
import { cancelGesture } from './content-blueprint/gestures';
import { loadPage } from './content-blueprint/service';
import { resetColorSets } from './content-blueprint/colors';

export { isBlueprintActive };

/** Resolver for "what object is this page showing" — registered by content.ts so the overlay uses the
 *  SAME URL ⊕ fiber rule as the Page tab / editor (resolvePageContext). BMP's custom-routed pages
 *  (e.g. a group's landing page) carry no `?rid=` in the URL; only the React fiber knows the bound
 *  object, and the fiber cache lives in content.ts's ContentState. Falls back to the bare URL when
 *  content.ts hasn't registered (unit tests, partial builds). */
let ridResolver: () => string | undefined = () => extractUrlRids().rid;
export function setBlueprintRidResolver(fn: () => string | undefined): void { ridResolver = fn; }
const currentPageRid = (): string | undefined => ridResolver();

// Blueprint can be toggled the instant a page loads, before BMP has rendered its React tree — on a
// landing page (no ?rid=) the page rid comes from the fiber, which isn't populated yet. Rather than
// failing on the first miss, retry a few times (the resolver re-reads the fiber each call) before giving
// up. A pending retry is cancelled if the user toggles Blueprint off while we're still waiting.
const ENABLE_RETRY_MAX = 8;
const ENABLE_RETRY_MS = 180;
let enableRetries = 0;
let enableRetryTimer: ReturnType<typeof setTimeout> | null = null;

/** One-shot edit-target override for the NEXT enable — the post-apply resume restores the session
 *  with the target the user was editing (applying to "This instance" must not reopen the template). */
let resumePrefer: 'template' | 'instance' | null = null;
export function setBlueprintResumePrefer(p: 'template' | 'instance'): void { resumePrefer = p; }

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
  // BLUEPRINT_CSS first, fonts last: the layout rules are parse-order-protected so a
  // malformed @font-face block (which the file-based css-integrity test can't see —
  // fontFaceCss is generated here) can never swallow the overlay's positioning rules.
  // @font-face works regardless of declaration position, so ordering is otherwise moot.
  s.id = STYLE_ID; s.textContent = BLUEPRINT_CSS + fontFaceCss();
  document.head.appendChild(s);
}

export function enableBlueprint(): void {
  if (bp.active) return;
  const rid = currentPageRid();
  if (!rid) {
    // Page context not resolvable yet — likely a landing page whose fiber hasn't rendered. Retry a few
    // times before giving up (see the ENABLE_RETRY_* note above).
    if (enableRetries < ENABLE_RETRY_MAX) {
      enableRetries++;
      enableRetryTimer = setTimeout(() => { enableRetryTimer = null; enableBlueprint(); }, ENABLE_RETRY_MS);
      return;
    }
    enableRetries = 0;
    showToast('Blueprint: no BMP object on this page', 'error');
    return;
  }
  enableRetries = 0;
  bp.active = true;
  bp.gen += 1; // new session — invalidates any in-flight load/apply from a prior toggle
  ensureStyle();
  const layer = document.createElement('div');
  layer.id = 'crev-blueprint-layer';
  // Critical positioning inline (mirrors #crev-blueprint-layer in BLUEPRINT_CSS) so the layer can never
  // fall into normal page flow if that stylesheet is missing, late, or removed — the "bottom-left leak".
  // The stylesheet still supplies every visual token; this is just the floor. Set per-property (not
  // cssText) so it composes with the cursor CSS vars set below and survives future edits.
  layer.style.position = 'absolute';
  layer.style.top = '0';
  layer.style.left = '0';
  layer.style.width = '100%';
  layer.style.zIndex = '2147483600'; // mirrors #crev-blueprint-layer z-index in BLUEPRINT_CSS
  // The paintbrush cursors are data-URI image-sets built in JS (they carry per-DPI rasters); CSS vars
  // are how the static stylesheet reaches them. Fallback (crosshair) lives in the CSS rules.
  layer.style.setProperty('--bp-cur-pick', PICK_CURSOR);
  layer.style.setProperty('--bp-cur-paint', APPLY_CURSOR);
  document.body.appendChild(layer);
  bp.layer = layer;
  mountLoadingShell();
  // The layer is document-absolute, so the canvas + cards scroll natively with the page — NO scroll
  // re-render (that JS-follow was the lag + header-overshadow). Only a RESIZE needs a re-anchor (BMP
  // reflows its widgets), coalesced to one animation frame.
  const coalescedRender = () => { if (bp.baseline && !bp.raf && !bp.dragging && !bp.renaming) bp.raf = requestAnimationFrame(() => { bp.raf = 0; render(); }); };
  // A genuine viewport resize reflows BMP's widgets, so the frozen canvas anchor must be recomputed; the
  // ResizeObserver path below (lazy table rows growing the page) deliberately does NOT clear it — the
  // canvas TOP is unchanged by content growing beneath it, and re-anchoring there is what shifted it.
  bp.onResize = () => { bp.resultAnchor = null; coalescedRender(); };
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
    // Debounce (trailing): a lazy-loading ExtendedTable grows its height over many frames, and each
    // growth would otherwise fire a full O(n) canvas rebuild. Collapse the burst into ONE rebuild once
    // the height settles. The window-'resize' path stays immediate (a viewport resize must re-anchor
    // promptly); only this content-growth path is debounced. Guarded/cleared on teardown.
    if (bp.bodyResizeTimer) clearTimeout(bp.bodyResizeTimer);
    bp.bodyResizeTimer = window.setTimeout(() => { bp.bodyResizeTimer = 0; coalescedRender(); }, 120);
  });
  bp.resizeObs.observe(document.body);
  bp.onKey = onKeydown;
  window.addEventListener('keydown', bp.onKey, true);
  bp.loadedRid = rid;
  // Navigation in BMP's portal is a soft (pushState/popstate) change — the document stays, so our overlay
  // survives but its loaded model is for the OLD page. handlePageNav() detects a page change and reloads
  // (or tears down off a BMP object); both the popstate handler (back/forward) and the MutationObserver
  // (forward link-navs, which fire no popstate) route through it. Graceful teardown only — staged edits on
  // the old page are dropped, same as a manual reload.
  bp.onPop = () => { handlePageNav(); };
  window.addEventListener('popstate', bp.onPop);
  // Staged edits live only in memory (History + working model) — an accidental Ctrl+R, tab close, or a
  // hard nav would discard the whole session with no recovery. Warn (native "Leave site?" dialog) only
  // when there are actually unsaved edits, so a clean session never nags. Soft in-portal navs route
  // through handlePageNav instead (they can't be vetoed); this covers real unloads.
  bp.onBeforeUnload = (e: BeforeUnloadEvent) => {
    // Skip the nag for our OWN post-apply reload (edits were just committed, nothing is lost) — the
    // `reloading` flag is set at the reload chokepoint. Only a real accidental Ctrl+R/close should warn.
    if (!bp.reloading && hasPendingEdits()) { e.preventDefault(); e.returnValue = ''; }
  };
  window.addEventListener('beforeunload', bp.onBeforeUnload);
  layer.addEventListener('mousedown', (e) => { if (e.target === layer) select(null); }); // empty space deselects
  // Watch BMP content for a tab switch (SPA — no reload): when the set of visible widget rids changes,
  // re-render so the overlay follows to the newly-shown tab. Gated by the rid signature so the overlay's
  // OWN mutations (its nodes carry no data-rid) never re-trigger it, and coalesced to one rAF.
  bp.observer = new MutationObserver(() => {
    if (bp.mutRaf || !bp.active) return;
    bp.mutRaf = requestAnimationFrame(() => {
      bp.mutRaf = 0;
      if (!bp.active || bp.dragging || bp.renaming) return;
      if (handlePageNav()) return; // a different PAGE is showing (link-nav/back-forward) → reloaded; stop
      if (!bp.baseline) return;
      const sig = ridSignature();
      if (sig !== bp.ridSig) { bp.ridSig = sig; bp.viewTabId = null; render(); } // same page → canvas follows the tab switch
    });
  });
  bp.observer.observe(document.body, { childList: true, subtree: true });
  const prefer = resumePrefer ?? 'template';
  resumePrefer = null; // one-shot: only the resume-triggered enable inherits the saved target
  void loadPage(rid, prefer).then((ok) => { if (!ok) disableBlueprint(); });
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

/** Reload the overlay for `rid` — used by the page-change handler (C) and the template/instance toggle
 *  (F, same rid, different `prefer`). Drops the stale model + any staged edits. */
function reloadForRid(rid: string, prefer: 'template' | 'instance' = 'template'): void {
  bp.loadedRid = rid;
  bp.gen += 1;                            // 1. invalidate any in-flight load/apply for the old page
  resetModel();                           // 2. clear the loaded model + page-specific view state
  bp.layer?.classList.remove('bp-peek');
  mountLoadingShell();                    // 3. clear the old canvas to a loading chip (render() won't, with no baseline)
  void loadPage(rid, prefer).then((ok) => { if (!ok) disableBlueprint(); }); // 4. fetch the new page
}

/** Reload onto the page the URL now points at, or tear down if it left BMP entirely. Returns true when it
 *  handled a page change (caller should stop) — false for a same-page tab switch. Routed to by both the
 *  popstate handler (back/forward) and the MutationObserver (forward link-navs that fire no popstate). */
function handlePageNav(): boolean {
  if (!bp.active) return true;
  const next = currentPageRid();
  if (!next) {
    // Unresolvable. On a landing page mid-render the fiber can be transiently blank — a later
    // mutation re-runs this and resolves — so only tear down when the page has genuinely left BMP
    // content behind (no rid-bearing elements at all). Keeps the overlay from dying on re-renders.
    if (document.querySelector('[data-rid]')) return false;
    disableBlueprint(); return true;
  }
  if (next === bp.loadedRid) return false;        // same page — let the observer follow the tab
  reloadForRid(next);
  return true;
}

/** F: switch between editing the shared TEMPLATE and THIS instance. Reloads the same page with the
 *  opposite `prefer`; staged edits are dropped (same as any reload — flagged with a toast when present).
 *  No-op when already in the requested mode. Offered only when a templated instance is loaded. */
export function setEditTarget(toTemplate: boolean): void {
  if (!bp.active || bp.editingTemplate === toTemplate) return;
  if (bp.history?.canUndo()) showToast('Blueprint: switched target. Unsaved layout edits were discarded.', 'info');
  reloadForRid(bp.loadedRid, toTemplate ? 'template' : 'instance');
}

/** Sorted set of the live widget rids — changes exactly when BMP swaps tabs (or otherwise re-renders
 *  its widget set). Cheap; the overlay's own nodes carry data-bpid, not data-rid, so they don't count. */
function ridSignature(): string {
  return [...document.querySelectorAll('[data-rid]')].map((el) => (el as HTMLElement).dataset.rid).sort().join(',');
}

export function disableBlueprint(): void {
  // Cancel a pending enable-retry even when we never went active (user toggled off mid-wait).
  if (enableRetryTimer) { clearTimeout(enableRetryTimer); enableRetryTimer = null; }
  enableRetries = 0;
  if (!bp.active) return;
  cancelGesture(); // rip out any in-flight drag/resize listeners + body-level ghost/line elements
  clearHintTimer(); // a pending flashHint render() must not fire after teardown
  if (bp.onResize) window.removeEventListener('resize', bp.onResize, true);
  if (bp.onKey) window.removeEventListener('keydown', bp.onKey, true);
  if (bp.onPop) window.removeEventListener('popstate', bp.onPop);
  if (bp.onBeforeUnload) window.removeEventListener('beforeunload', bp.onBeforeUnload);
  if (bp.raf) cancelAnimationFrame(bp.raf);
  if (bp.mutRaf) cancelAnimationFrame(bp.mutRaf);
  if (bp.bodyResizeTimer) clearTimeout(bp.bodyResizeTimer);
  if (bp.discardTimer) clearTimeout(bp.discardTimer);
  bp.observer?.disconnect();
  bp.resizeObs?.disconnect();
  bp.layer?.remove();
  bp.scrollSpacer?.remove(); // drop the page-scroll-extension spacer (it lives on body, outside the layer)
  document.getElementById(STYLE_ID)?.remove(); // don't leak the injected stylesheet past teardown
  resetColorSets(); // colour ids are workspace-scoped; never carry a cache into the next session/profile
  resetState(); // every per-session field back to idle (one source of truth — see state.ts)
}
// Load/apply results are handled by content-blueprint/service.ts (the sendRequest promises), not by
// a port-dispatched handler — see that module.
