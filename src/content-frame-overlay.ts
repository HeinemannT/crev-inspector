/**
 * In-page floating-frame overlay. Generalizes the editor overlay to mount
 * any extension page (editor / diff / objectview / codesearch) as a
 * draggable, resizable iframe inside the current tab — replaces
 * chrome.windows.create popup windows for code-bearing surfaces.
 *
 * Keyed by `kind`: at most one frame per kind, and switching to a new URL
 * within the same kind swaps the iframe src.
 */

import { h, svg } from './lib/dom';
import { log } from './lib/logger';
import { ICON_ARROWS_OUT_SIMPLE, ICON_ARROWS_IN_SIMPLE, ICON_X } from './lib/icons';
import { ensureOverlayStyle } from './content-overlay-style';
import type { FrameActivation, FrameKind, FrameMountDisposition } from './lib/types';
import {
  centeredFrameBounds,
  detectFrameSnapZone,
  fitFrameBounds,
  maximizedFrameBounds,
  moveFrameBounds,
  resizeFrameBounds,
  snapFrameBounds,
  type FrameBounds as Bounds,
  type FrameResizeDirection as ResizeDir,
  type FrameSnapZone as SnapZone,
  type FrameViewport,
} from './lib/frame-geometry';
/** Just below max signed 32-bit; lets us reliably sit on top of page content. */
const MAX_Z = 2_147_483_000;

const BOUNDS_KEY_PREFIX = 'crev_overlay_bounds_';
const HOST_ID_PREFIX = 'crev-frame-overlay-';

interface FrameState {
  kind: FrameKind;
  url: string;
  resourceKey: string;
  label: string;
  host: HTMLElement;
  iframe: HTMLIFrameElement;
  bounds: Bounds;
  /** Pre-maximize bounds to restore to; set only while maximized. */
  restoreBounds?: Bounds;
  cleanupGestures: () => void;
  onKeydown: (e: KeyboardEvent) => void;
  onViewportResize: () => void;
  replacementPending: boolean;
  pendingReplacement?: MountFrameOptions;
  ready: boolean;
  pendingActivation?: FrameActivation;
}

const frames = new Map<FrameKind, FrameState>();

// Kinds with a mount in flight. mountFrameOverlay awaits readBounds()
// before it can register in `frames`, so two MOUNT_FRAME messages for the
// same kind arriving back-to-back would both pass the `frames.get` guard
// and each append a host → two identical overlays. Reserve the slot
// synchronously here to close that window.
const mounting = new Set<FrameKind>();
/** Latest request received while a kind is still reading its saved bounds.
 * Replayed after the first mount so rapid clicks never disappear. */
interface PendingMount {
  opts: MountFrameOptions;
  resolve: (disposition: FrameMountDisposition) => void;
}

const pendingMounts = new Map<FrameKind, PendingMount>();

// Set by teardownFrameOverlayModule(). A mount that was awaiting readBounds()
// when re-injection tore the module down must NOT append its host afterwards —
// that host (and its document/window listeners) would belong to a dead module
// and never get cleaned. Checked right after the await.
let moduleTorn = false;

// ── Geometric overlap gate ────────────────────────────────────────
//
// Companion injects several floating elements onto the BMP page:
//
//   .crev-label          pills (one per inspected widget, BMP's DOM)
//   #crev-tooltip        hover info popup
//   #crev-paint-banner   top banner while paint-format is armed
//
// Earlier releases used a blanket rule: when ANY frame overlay was
// open we made every pill click-through, hid the tooltip and quick
// inspector entirely, and left the rest alone — that "fixed" the rare
// case where BMP's transformed ancestors built a stacking context
// that let a pill float visually above the overlay, but it also
// punished every pill / tooltip / inspector that wasn't anywhere near
// the overlay.
//
// `updateOverlayBlockState()` replaces the blanket rule with a per-
// element geometric check: each candidate's bounding rect is tested
// against each open frame's host rect, and we toggle
// `crev-overlay-blocked` accordingly. CSS scopes the response per
// element (pill → click-through; tooltip / quick inspector → hide;
// paint banner → click-through).
//
// We re-run on every overlay mount / unmount / drag tick / resize tick /
// snap / viewport resize, AND on body subtree mutations (BMP re-paints
// the pill DOM on every Inspect refresh and a fresh pill arrives with
// the class unset).

interface GateTarget {
  selector: string;
  /** Default `getBoundingClientRect`. Override if a wrapper element
   *  bounds don't match the user-visible region (none today). */
  bounds?: (el: HTMLElement) => DOMRect;
}

const GATE_TARGETS: ReadonlyArray<GateTarget> = [
  { selector: '.crev-label' },
  { selector: '#crev-tooltip' },
  { selector: '#crev-paint-banner' },
];

let overlapGateRafScheduled = false;
let overlapObserver: MutationObserver | null = null;

function rectsIntersect(a: DOMRect, b: DOMRect): boolean {
  return a.right > b.left && a.left < b.right && a.bottom > b.top && a.top < b.bottom;
}

export function updateOverlayBlockState(): void {
  if (overlapGateRafScheduled) return;
  overlapGateRafScheduled = true;
  requestAnimationFrame(() => {
    overlapGateRafScheduled = false;
    // Cheap path — nothing open. Clear stale flags so a leftover
    // class can't persist after the last overlay closes.
    if (frames.size === 0) {
      for (const el of document.querySelectorAll<HTMLElement>('.crev-overlay-blocked')) {
        el.classList.remove('crev-overlay-blocked');
      }
      return;
    }
    const overlayRects: DOMRect[] = [];
    for (const f of frames.values()) overlayRects.push(f.host.getBoundingClientRect());
    for (const target of GATE_TARGETS) {
      for (const el of document.querySelectorAll<HTMLElement>(target.selector)) {
        const r = (target.bounds ?? ((x: HTMLElement) => x.getBoundingClientRect()))(el);
        // Off-screen / collapsed elements never intersect; toggle is
        // a no-op when the class isn't present, so safe to call.
        const blocked = r.width > 0 && r.height > 0 && overlayRects.some(o => rectsIntersect(r, o));
        el.classList.toggle('crev-overlay-blocked', blocked);
      }
    }
  });
}

function ensureOverlapObserver(): void {
  if (overlapObserver) return;
  // BMP re-renders pills + its own DOM on every Inspect refresh, and
  // Companion's tooltip / inspector / banner appear and disappear with
  // user interaction. A subtree childList observer catches both —
  // we recompute on any mutation so newly inserted elements get
  // their initial gate state.
  overlapObserver = new MutationObserver(() => updateOverlayBlockState());
  overlapObserver.observe(document.body, { childList: true, subtree: true });
}

function teardownOverlapObserver(): void {
  if (!overlapObserver) return;
  overlapObserver.disconnect();
  overlapObserver = null;
}

export interface MountFrameOptions {
  kind: FrameKind;
  /** chrome.runtime.getURL(...) of the page to load inside the iframe. */
  url: string;
  /** Used for aria-label and the close-confirmation prompt. */
  label: string;
  defaultWidth: number;
  defaultHeight: number;
  resourceKey?: string;
  replaceExisting?: boolean;
  activation?: FrameActivation;
}

// ── Public API ─────────────────────────────────────────────────

export async function mountFrameOverlay(opts: MountFrameOptions): Promise<FrameMountDisposition> {
  const existing = frames.get(opts.kind);
  if (existing) {
    const resourceKey = opts.resourceKey ?? opts.url;
    if (!opts.replaceExisting && existing.resourceKey === resourceKey) {
      updateFrameLabel(existing, opts.label);
      activateFrame(existing, opts.activation);
      focus(existing);
      return 'activated';
    }
    requestReplace(existing, opts);
    return 'replacement-pending';
  }

  // Another mount for this kind is already resolving its bounds. Retain only
  // the latest intent and replay it once the reserved frame exists.
  if (mounting.has(opts.kind)) {
    pendingMounts.get(opts.kind)?.resolve('superseded');
    return new Promise(resolve => pendingMounts.set(opts.kind, { opts, resolve }));
  }
  mounting.add(opts.kind);
  let disposition: FrameMountDisposition = 'mounted';
  try {
    const bounds = await readBounds(opts);
    // Re-injection tore the module down while we were resolving bounds —
    // drop this mount so we don't append a host to a dead module.
    if (moduleTorn) {
      disposition = 'dropped';
      return disposition;
    }
    // Guarantee the overlay stylesheet exists before the host enters the DOM: `.crev-eo-host` is
    // position:fixed in that sheet, and a frame surface (EC editor / diff / object view / code
    // search) can be opened WITHOUT Inspect — which is what used to inject it. Without this the host
    // drops into normal page flow at the bottom-left. Idempotent (DOM-guarded).
    ensureOverlayStyle();
    const state = createFrame(opts, bounds);
    frames.set(opts.kind, state);
    document.documentElement.appendChild(state.host);
    document.addEventListener('keydown', state.onKeydown, true);
    window.addEventListener('resize', state.onViewportResize);
    // Mark the body so CSS can hide stacking-context-trapped overlays
    // (the in-page widget labels) that BMP renders inside transformed
    // ancestors. z-index alone can't escape those — the labels would
    // float above the task surface despite our 2147483646 setting.
    document.body.classList.add('crev-task-open');
    ensureOverlapObserver();
    updateOverlayBlockState();
    focus(state);
    return disposition;
  } finally {
    mounting.delete(opts.kind);
    const pending = pendingMounts.get(opts.kind);
    if (pending) {
      pendingMounts.delete(opts.kind);
      if (moduleTorn) pending.resolve('dropped');
      else {
        void mountFrameOverlay(pending.opts).then(pending.resolve, () => pending.resolve('failed'));
      }
    }
  }
}

export function unmountFrameOverlay(kind: FrameKind): void {
  const s = frames.get(kind);
  if (!s) return;
  frames.delete(kind);
  s.cleanupGestures();
  document.removeEventListener('keydown', s.onKeydown, true);
  window.removeEventListener('resize', s.onViewportResize);
  s.host.remove();
  if (frames.size === 0) {
    document.body.classList.remove('crev-task-open');
    teardownOverlapObserver();
  }
  updateOverlayBlockState();
}

export function unmountAllFrameOverlays(): void {
  for (const kind of [...frames.keys()]) unmountFrameOverlay(kind);
}

/** Full module teardown for content-script re-injection: unmount every
 *  overlay AND detach the module-level CREV_OVERLAY_CLOSE_PLEASE message
 *  listener. unmountAllFrameOverlays alone leaves that window listener
 *  attached, so each re-injection would stack another listener over a fresh
 *  module's `frames` Map. */
export function teardownFrameOverlayModule(): void {
  moduleTorn = true;
  unmountAllFrameOverlays();
  window.removeEventListener('message', onFrameMessage);
}

// ── Construction ──────────────────────────────────────────────

function createFrame(opts: MountFrameOptions, bounds: Bounds): FrameState {
  const host = h('div', {
    id: HOST_ID_PREFIX + opts.kind,
    class: 'crev-eo-host',
    'data-kind': opts.kind,
    role: 'dialog',
    'aria-modal': 'false', // multiple overlays can be open; not modal
    'aria-label': opts.label,
    tabindex: '-1',
    // `position` is set INLINE (not left to `.crev-eo-host` in the stylesheet) so the host can NEVER fall
    // into normal page flow if that stylesheet is missing, injected late, wiped by the SPA's <head>
    // management, or removed by a re-injection teardown — the "bottom-left leak". z-index uses MAX_Z (the
    // exact value focus() assigns the front frame, called on mount) as a floor until focus() runs. The
    // stylesheet still supplies all the visual chrome (border, shadow, radius, animation).
    style: `position:fixed;z-index:${MAX_Z};left:${bounds.left}px;top:${bounds.top}px;width:${bounds.width}px;height:${bounds.height}px`,
  });

  // Titlebar has `cursor: grab` (set in content-overlay.css), which is
  // the standard desktop-OS affordance for "you can drag this". A
  // native `title="Drag to move"` would paint a redundant tooltip
  // after the half-second hover delay and disappear mid-drag.
  const maxBtn = h('button', {
    class: 'crev-eo-btn crev-eo-max',
    title: 'Maximize',
    'aria-label': `Maximize ${opts.label}`,
    onClick: () => toggleMaximize(opts.kind),
  });
  maxBtn.innerHTML = ICON_ARROWS_OUT_SIMPLE;
  const titlebar = h('div', { class: 'crev-eo-titlebar' },
    h('div', { class: 'crev-eo-grip' }),
    h('div', { class: 'crev-eo-titlebar-label' }, opts.label),
    h('div', { class: 'crev-eo-titlebar-spacer' }),
    maxBtn,
    h('button', {
      class: 'crev-eo-btn crev-eo-close',
      title: 'Close (Esc)',
      'aria-label': `Close ${opts.label}`,
      onClick: () => requestClose(opts.kind),
    }, svg(ICON_X)),
  );

  const iframe = createIframe(opts.url, opts.label);

  // Eight directional resize handles — four edge strips + four
  // corner squares. Corners overlap the edges so they win the
  // hit-test; the absolute positioning + z-index in CSS handles it.
  const RESIZE_DIRS: ResizeDir[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];
  // Each resize handle's CSS already sets the matching directional
  // cursor (e.g. `cursor: ns-resize` / `cursor: nesw-resize`), which
  // is the universal "you can resize from this edge/corner" affordance
  // on every desktop OS. `aria-label` carries the accessible name; a
  // native `title="Resize"` would just paint a redundant tooltip.
  const resizeHandles: Array<{ el: HTMLElement; dir: ResizeDir }> = RESIZE_DIRS.map(dir => ({
    el: h('div', {
      class: `crev-eo-resize crev-eo-resize--${dir}`,
      role: 'separator',
      'aria-label': `Resize ${opts.label} (${dir})`,
    }),
    dir,
  }));

  host.appendChild(titlebar);
  host.appendChild(iframe);
  for (const { el } of resizeHandles) host.appendChild(el);

  // Raise z-order when focus enters the frame (titlebar/resize/close OR the
  // iframe body via cross-frame focus). The browser fires a focus event on
  // the iframe element when its content gains focus, which bubbles as
  // focusin on the host. Without this, a buried frame stayed buried even
  // after the user clicked into it.
  host.addEventListener('focusin', () => {
    const cur = frames.get(opts.kind);
    if (cur === state) focus(state);
  });

  const state: FrameState = {
    kind: opts.kind,
    url: opts.url,
    resourceKey: opts.resourceKey ?? opts.url,
    label: opts.label,
    host, iframe, bounds,
    cleanupGestures: () => {},
    onKeydown: () => {},
    onViewportResize: () => {},
    replacementPending: false,
    ready: false,
    pendingActivation: opts.activation,
  };
  const dragCleanup = wireDrag(state, titlebar);
  const resizeCleanups = resizeHandles.map(({ el, dir }) => wireResize(state, el, dir));
  state.cleanupGestures = () => { dragCleanup(); for (const c of resizeCleanups) c(); };
  state.onKeydown = (e: KeyboardEvent) => {
    // Escape closes only the focused frame — multiple can be open
    if (e.key === 'Escape' && frames.get(opts.kind) === state && isFocused(state)) {
      requestClose(opts.kind);
      e.stopPropagation();
    }
  };
  state.onViewportResize = () => {
    const viewport = currentViewport();
    if (state.restoreBounds) {
      state.restoreBounds = fitFrameBounds(state.restoreBounds, viewport);
      state.bounds = maximizedFrameBounds(viewport);
    } else {
      state.bounds = fitFrameBounds(state.bounds, viewport);
      persistBounds(state.kind, state.bounds);
    }
    applyBounds(state);
    updateOverlayBlockState();
  };

  return state;
}

function createIframe(url: string, label: string): HTMLIFrameElement {
  const iframe = document.createElement('iframe');
  iframe.className = 'crev-eo-iframe';
  iframe.src = url;
  iframe.setAttribute('allow', 'clipboard-read; clipboard-write');
  iframe.setAttribute('title', label);
  return iframe;
}

function updateFrameLabel(state: FrameState, label: string): void {
  state.label = label;
  state.host.setAttribute('aria-label', label);
  state.iframe.setAttribute('title', label);
  const title = state.host.querySelector<HTMLElement>('.crev-eo-titlebar-label');
  if (title) title.textContent = label;
  const max = state.host.querySelector<HTMLElement>('.crev-eo-max');
  if (max) max.setAttribute('aria-label', `${state.restoreBounds ? 'Restore' : 'Maximize'} ${label}`);
  const close = state.host.querySelector<HTMLElement>('.crev-eo-close');
  if (close) close.setAttribute('aria-label', `Close ${label}`);
  for (const handle of state.host.querySelectorAll<HTMLElement>('.crev-eo-resize')) {
    const direction = [...handle.classList]
      .find(name => name.startsWith('crev-eo-resize--'))
      ?.slice('crev-eo-resize--'.length);
    handle.setAttribute('aria-label', `Resize ${label}${direction ? ` (${direction})` : ''}`);
  }
}

function activateFrame(state: FrameState, activation?: FrameActivation): void {
  if (!activation) return;
  if (!state.ready) {
    state.pendingActivation = activation;
    return;
  }
  state.iframe.contentWindow?.postMessage({ type: 'CREV_FRAME_ACTIVATE', activation }, '*');
}

function replaceFrame(state: FrameState, opts: MountFrameOptions): void {
  if (frames.get(state.kind) !== state) return;
  const nextIframe = createIframe(opts.url, opts.label);
  state.iframe.replaceWith(nextIframe);
  state.iframe = nextIframe;
  state.url = opts.url;
  state.resourceKey = opts.resourceKey ?? opts.url;
  state.ready = false;
  state.pendingActivation = opts.activation;
  updateFrameLabel(state, opts.label);
  focus(state);
}

function requestReplace(state: FrameState, opts: MountFrameOptions): void {
  state.pendingReplacement = opts;
  if (state.replacementPending) return;
  state.replacementPending = true;
  requestFramePermission(state, (allowed) => {
    state.replacementPending = false;
    if (!allowed || frames.get(state.kind) !== state) {
      state.pendingReplacement = undefined;
      return;
    }
    const latest = state.pendingReplacement;
    state.pendingReplacement = undefined;
    if (latest) replaceFrame(state, latest);
  });
}

function focus(state: FrameState): void {
  // Highest z among the open frames; old top moves down by 1.
  let maxZ = MAX_Z - frames.size;
  for (const f of frames.values()) {
    if (f === state) continue;
    f.host.style.zIndex = String(maxZ);
    maxZ++;
  }
  state.host.style.zIndex = String(MAX_Z);
  // Focus order doesn't change geometry, but it does change which
  // overlay is intuitively "active" — leaving the gate stale here
  // is harmless, just refresh so the user can interact with the
  // newly-fronted frame's region immediately.
  updateOverlayBlockState();
  requestAnimationFrame(() => {
    try { state.iframe.contentWindow?.focus(); } catch (e) { log.swallow('overlay:focus', e); }
  });
}

function isFocused(state: FrameState): boolean {
  // If the iframe owns the active element, treat as focused.
  return document.activeElement === state.iframe;
}

// Iframes can ASK to be closed (e.g. Esc inside CodeMirror, which never
// bubbles to the outer document because keyboard events don't cross
// frame boundaries). They post CREV_OVERLAY_CLOSE_PLEASE; we look up
// which kind owns the source contentWindow and run the normal close
// handshake. Without this, the help text "Close (Esc)" lies — the
// shortcut only works when the iframe DOESN'T have focus.
function onFrameMessage(e: MessageEvent): void {
  const msg = e.data as { type?: string } | undefined;
  for (const [kind, state] of frames) {
    if (state.iframe.contentWindow === e.source) {
      if (msg?.type === 'CREV_FRAME_READY') {
        state.ready = true;
        const activation = state.pendingActivation;
        state.pendingActivation = undefined;
        activateFrame(state, activation);
      } else if (msg?.type === 'CREV_OVERLAY_CLOSE_PLEASE') {
        requestClose(kind);
      }
      return;
    }
  }
}
window.addEventListener('message', onFrameMessage);

/** Ask the iframe whether it is safe to close or replace its content.
 *
 *  Two-phase handshake:
 *   1. We start a 1.5s fallback timeout. If we hear nothing back,
 *      the iframe is genuinely dead and we force-close so the user
 *      isn't stranded with an unresponsive overlay.
 *   2. If the iframe sends CREV_OVERLAY_CLOSE_PENDING (it's alive
 *      and asking the user via a modal), we clear the fallback.
 *      The user might take seconds or minutes to decide — we wait.
 *   3. CREV_OVERLAY_CLOSE_RESPONSE carries the final yes/no.
 *
 *  Before the PENDING phase existed the fallback could fire while the
 *  iframe's "Discard unsaved changes?" modal was still open.
 */
function requestFramePermission(state: FrameState, done: (allowed: boolean) => void): void {
  let settled = false;
  const finish = (allowed: boolean) => {
    if (settled) return;
    settled = true;
    cleanup();
    done(allowed);
  };
  const onMsg = (e: MessageEvent) => {
    if (e.source !== state.iframe.contentWindow) return;
    const type = (e.data as { type?: string } | undefined)?.type;
    if (type === 'CREV_OVERLAY_CLOSE_PENDING') {
      clearTimeout(fallback);
      return;
    }
    if (type !== 'CREV_OVERLAY_CLOSE_RESPONSE') return;
    finish(!!(e.data as { ok?: boolean }).ok);
  };
  const fallback = setTimeout(() => finish(true), 1500);
  const cleanup = () => {
    clearTimeout(fallback);
    window.removeEventListener('message', onMsg);
  };
  window.addEventListener('message', onMsg);
  state.iframe.contentWindow?.postMessage({ type: 'CREV_OVERLAY_CLOSE_REQUEST' }, '*');
}

function requestClose(kind: FrameKind): void {
  const state = frames.get(kind);
  if (!state) return;
  requestFramePermission(state, (allowed) => {
    if (allowed) unmountFrameOverlay(kind);
  });
}

// ── Drag / resize ─────────────────────────────────────────────

function currentViewport(): FrameViewport {
  return { width: window.innerWidth, height: window.innerHeight };
}

function detectSnapZone(clientX: number, clientY: number): SnapZone {
  return detectFrameSnapZone(clientX, clientY, window.innerWidth);
}

function snapBoundsFor(zone: SnapZone): Bounds | null {
  return snapFrameBounds(zone, currentViewport());
}

function wireDrag(state: FrameState, handle: HTMLElement): () => void {
  let startX = 0, startY = 0, startLeft = 0, startTop = 0;
  let dragging = false;
  let pointerId: number | null = null;
  let snapGhost: HTMLElement | null = null;
  let pendingSnap: SnapZone = null;

  const ensureGhost = (): HTMLElement => {
    if (snapGhost) return snapGhost;
    const g = document.createElement('div');
    g.className = 'crev-eo-snap-ghost';
    g.style.position = 'fixed'; // leak floor — never fall into page flow if the stylesheet is absent
    document.documentElement.appendChild(g);
    snapGhost = g;
    return g;
  };
  const removeGhost = () => {
    if (snapGhost) { snapGhost.remove(); snapGhost = null; }
    pendingSnap = null;
  };
  const updateSnapPreview = (zone: SnapZone) => {
    pendingSnap = zone;
    if (!zone) { removeGhost(); return; }
    const bounds = snapBoundsFor(zone);
    if (!bounds) return;
    const g = ensureGhost();
    g.style.left = `${bounds.left}px`;
    g.style.top = `${bounds.top}px`;
    g.style.width = `${bounds.width}px`;
    g.style.height = `${bounds.height}px`;
  };

  const onMove = (e: PointerEvent) => {
    if (!dragging) return;
    state.bounds = moveFrameBounds(
      { ...state.bounds, left: startLeft, top: startTop },
      e.clientX - startX,
      e.clientY - startY,
      currentViewport(),
    );
    applyBounds(state);
    updateSnapPreview(detectSnapZone(e.clientX, e.clientY));
    updateOverlayBlockState();
  };

  const finish = () => {
    if (!dragging) return;
    dragging = false;
    if (pointerId != null) {
      try { handle.releasePointerCapture(pointerId); } catch { /* already released */ }
      pointerId = null;
    }
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', finish);
    document.removeEventListener('pointercancel', finish);
    // Commit snap if the pointer ended in a snap zone — apply the
    // ghost bounds to the host. Otherwise keep wherever the user
    // dragged to.
    if (pendingSnap) {
      const target = snapBoundsFor(pendingSnap);
      if (target) {
        Object.assign(state.bounds, target);
        state.host.style.left = `${target.left}px`;
        state.host.style.top = `${target.top}px`;
        state.host.style.width = `${target.width}px`;
        state.host.style.height = `${target.height}px`;
      }
    }
    removeGhost();
    persistBounds(state.kind, state.bounds);
    state.host.classList.remove('crev-eo--dragging');
    state.iframe.style.pointerEvents = '';
    // Final position may differ from the last `onMove` tick (snap
    // commit jumped the host to the snap-zone rect). Recompute so
    // pills inside the new region pick up the gate state.
    updateOverlayBlockState();
  };

  handle.addEventListener('pointerdown', (e: PointerEvent) => {
    if ((e.target as HTMLElement).closest('.crev-eo-btn')) return;
    dragging = true;
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    startLeft = state.bounds.left;
    startTop = state.bounds.top;
    handle.setPointerCapture(e.pointerId);
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', finish);
    document.addEventListener('pointercancel', finish);
    state.host.classList.add('crev-eo--dragging');
    state.iframe.style.pointerEvents = 'none';
    focus(state);
  });

  return finish;
}

function wireResize(state: FrameState, handle: HTMLElement, dir: ResizeDir): () => void {
  let startX = 0, startY = 0;
  let startW = 0, startH = 0, startLeft = 0, startTop = 0;
  let resizing = false;
  let pointerId: number | null = null;

  const onMove = (e: PointerEvent) => {
    if (!resizing) return;
    state.bounds = resizeFrameBounds(
      { left: startLeft, top: startTop, width: startW, height: startH },
      dir,
      e.clientX - startX,
      e.clientY - startY,
      currentViewport(),
    );
    applyBounds(state);
    updateOverlayBlockState();
  };

  const finish = () => {
    if (!resizing) return;
    resizing = false;
    if (pointerId != null) {
      try { handle.releasePointerCapture(pointerId); } catch { /* already released */ }
      pointerId = null;
    }
    document.removeEventListener('pointermove', onMove);
    document.removeEventListener('pointerup', finish);
    document.removeEventListener('pointercancel', finish);
    persistBounds(state.kind, state.bounds);
    state.host.classList.remove('crev-eo--resizing');
    state.iframe.style.pointerEvents = '';
    updateOverlayBlockState();
  };

  handle.addEventListener('pointerdown', (e: PointerEvent) => {
    resizing = true;
    pointerId = e.pointerId;
    startX = e.clientX;
    startY = e.clientY;
    startW = state.bounds.width;
    startH = state.bounds.height;
    startLeft = state.bounds.left;
    startTop = state.bounds.top;
    handle.setPointerCapture(e.pointerId);
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', finish);
    document.addEventListener('pointercancel', finish);
    state.host.classList.add('crev-eo--resizing');
    state.iframe.style.pointerEvents = 'none';
    focus(state);
  });

  return finish;
}

// ── Maximize / restore ────────────────────────────────────────

/** Push the frame's bounds to its host's style. */
function applyBounds(state: FrameState): void {
  state.host.style.left = `${state.bounds.left}px`;
  state.host.style.top = `${state.bounds.top}px`;
  state.host.style.width = `${state.bounds.width}px`;
  state.host.style.height = `${state.bounds.height}px`;
}

/** Toggle a frame between its current size and (near-)full viewport. The
 *  pre-maximize bounds are remembered for restore. Not persisted — maximize is
 *  a transient view state, so reopening uses the last manually-sized bounds. */
function toggleMaximize(kind: FrameKind): void {
  const state = frames.get(kind);
  if (!state) return;
  const btn = state.host.querySelector<HTMLElement>('.crev-eo-max');
  if (state.restoreBounds) {
    state.bounds = fitFrameBounds(state.restoreBounds, currentViewport());
    state.restoreBounds = undefined;
    if (btn) { btn.innerHTML = ICON_ARROWS_OUT_SIMPLE; btn.title = 'Maximize'; btn.setAttribute('aria-label', `Maximize ${state.label}`); }
  } else {
    state.restoreBounds = { ...state.bounds };
    state.bounds = maximizedFrameBounds(currentViewport());
    if (btn) { btn.innerHTML = ICON_ARROWS_IN_SIMPLE; btn.title = 'Restore'; btn.setAttribute('aria-label', `Restore ${state.label}`); }
  }
  applyBounds(state);
}

// ── Bounds persistence ────────────────────────────────────────

async function readBounds(opts: MountFrameOptions): Promise<Bounds> {
  const key = BOUNDS_KEY_PREFIX + opts.kind;
  try {
    const stored = await chrome.storage.local.get(key);
    const b = stored[key] as Partial<Bounds> | undefined;
    if (b && typeof b.left === 'number' && typeof b.top === 'number'
        && typeof b.width === 'number' && typeof b.height === 'number') {
      const restored = fitFrameBounds(b as Bounds, currentViewport());
      if (restored.left !== b.left || restored.top !== b.top
          || restored.width !== b.width || restored.height !== b.height) {
        persistBounds(opts.kind, restored);
      }
      return restored;
    }
  } catch (e) {
    log.swallow('overlay:readBounds', e);
  }
  // Stagger when multiple frames are already open so a second/third overlay
  // doesn't land exactly on top of the first one. Persisted bounds take over
  // on subsequent opens — this only matters the very first time per kind.
  const offset = frames.size * 28;
  return centeredFrameBounds(opts.defaultWidth, opts.defaultHeight, currentViewport(), offset);
}

const persistTimers = new Map<FrameKind, ReturnType<typeof setTimeout>>();
function persistBounds(kind: FrameKind, bounds: Bounds): void {
  const prev = persistTimers.get(kind);
  if (prev) clearTimeout(prev);
  persistTimers.set(kind, setTimeout(() => {
    chrome.storage.local.set({ [BOUNDS_KEY_PREFIX + kind]: bounds })
      .catch(e => log.swallow('overlay:persistBounds', e));
  }, 400));
}
