/**
 * In-page floating-frame overlay. Generalizes the editor overlay to mount
 * any extension page (editor / diff / objectview / codesearch) as a
 * draggable, resizable iframe inside the current tab — replaces
 * chrome.windows.create popup windows for code-bearing surfaces.
 *
 * Keyed by `kind`: at most one frame per kind, and switching to a new URL
 * within the same kind swaps the iframe src.
 */

import { h } from './lib/dom';
import { log } from './lib/logger';
import { ICON_ARROWS_OUT_SIMPLE, ICON_ARROWS_IN_SIMPLE } from './lib/icons';
import type { FrameKind } from './lib/types';

const MIN_W = 360;
const MIN_H = 240;
const MARGIN = 16;
/** Keep at least this many pixels of the overlay on-screen when dragging. */
const MIN_VISIBLE = 80;
/** Just below max signed 32-bit; lets us reliably sit on top of page content. */
const MAX_Z = 2_147_483_000;

const BOUNDS_KEY_PREFIX = 'crev_overlay_bounds_';
const HOST_ID_PREFIX = 'crev-frame-overlay-';

interface Bounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface FrameState {
  kind: FrameKind;
  url: string;
  host: HTMLElement;
  iframe: HTMLIFrameElement;
  bounds: Bounds;
  /** Pre-maximize bounds to restore to; set only while maximized. */
  restoreBounds?: Bounds;
  cleanupGestures: () => void;
  onKeydown: (e: KeyboardEvent) => void;
  onViewportResize: () => void;
}

const frames = new Map<FrameKind, FrameState>();

// Kinds with a mount in flight. mountFrameOverlay awaits readBounds()
// before it can register in `frames`, so two MOUNT_FRAME messages for the
// same kind arriving back-to-back would both pass the `frames.get` guard
// and each append a host → two identical overlays. Reserve the slot
// synchronously here to close that window.
const mounting = new Set<FrameKind>();

// Set by teardownFrameOverlayModule(). A mount that was awaiting readBounds()
// when re-injection tore the module down must NOT append its host afterwards —
// that host (and its document/window listeners) would belong to a dead module
// and never get cleaned. Checked right after the await.
let moduleTorn = false;

// ── Geometric overlap gate ────────────────────────────────────────
//
// CREV injects several floating elements onto the BMP page:
//
//   .crev-label          pills (one per inspected widget, BMP's DOM)
//   #crev-tooltip        hover info popup
//   #crev-quick-inspector pinned info card with action buttons
//   #crev-env-tag        bottom-right env/connection status badge
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
// env tag / paint banner → click-through).
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
  { selector: '#crev-quick-inspector' },
  { selector: '#crev-env-tag' },
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
  // CREV's tooltip / inspector / banner appear and disappear with
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
}

// ── Public API ─────────────────────────────────────────────────

export async function mountFrameOverlay(opts: MountFrameOptions): Promise<void> {
  const existing = frames.get(opts.kind);
  if (existing) {
    if (existing.url === opts.url) {
      focus(existing);
      return;
    }
    // Same kind, new URL — swap iframe and bring to front
    existing.url = opts.url;
    existing.iframe.src = opts.url;
    focus(existing);
    return;
  }

  // Another mount for this kind is already resolving its bounds — drop the
  // duplicate rather than racing it to append a second host.
  if (mounting.has(opts.kind)) return;
  mounting.add(opts.kind);
  try {
    const bounds = await readBounds(opts);
    // Re-injection tore the module down while we were resolving bounds —
    // drop this mount so we don't append a host to a dead module.
    if (moduleTorn) return;
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
  } finally {
    mounting.delete(opts.kind);
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
 *  attached, so each re-injection would stack another (harmless but
 *  accumulating) listener over a fresh module's `frames` Map. */
export function teardownFrameOverlayModule(): void {
  moduleTorn = true;
  unmountAllFrameOverlays();
  window.removeEventListener('message', onClosePleaseMessage);
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
    style: `left:${bounds.left}px;top:${bounds.top}px;width:${bounds.width}px;height:${bounds.height}px`,
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
      class: 'crev-eo-btn',
      title: 'Close (Esc)',
      'aria-label': `Close ${opts.label}`,
      onClick: () => requestClose(opts.kind),
    }, '✕'),
  );

  const iframe = document.createElement('iframe');
  iframe.className = 'crev-eo-iframe';
  iframe.src = opts.url;
  iframe.setAttribute('allow', 'clipboard-read; clipboard-write');
  iframe.setAttribute('title', opts.label);

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
    host, iframe, bounds,
    cleanupGestures: () => {},
    onKeydown: () => {},
    onViewportResize: () => {},
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
    state.bounds.left = clamp(state.bounds.left, MARGIN - state.bounds.width + MIN_VISIBLE, window.innerWidth - MIN_VISIBLE);
    state.bounds.top = clamp(state.bounds.top, 0, Math.max(0, window.innerHeight - 40));
    state.host.style.left = `${state.bounds.left}px`;
    state.host.style.top = `${state.bounds.top}px`;
    updateOverlayBlockState();
  };

  return state;
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
function onClosePleaseMessage(e: MessageEvent): void {
  const msg = e.data as { type?: string } | undefined;
  if (msg?.type !== 'CREV_OVERLAY_CLOSE_PLEASE') return;
  for (const [kind, state] of frames) {
    if (state.iframe.contentWindow === e.source) {
      requestClose(kind);
      return;
    }
  }
}
window.addEventListener('message', onClosePleaseMessage);

/** Ask the iframe whether it's safe to close.
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
 *  Before the PENDING phase existed the 1.5s timeout would fire
 *  while the iframe's "Discard unsaved changes?" modal was still on
 *  screen and the editor was destroyed mid-confirm.
 */
function requestClose(kind: FrameKind): void {
  const state = frames.get(kind);
  if (!state) return;
  const onMsg = (e: MessageEvent) => {
    if (e.source !== state.iframe.contentWindow) return;
    const type = (e.data as { type?: string } | undefined)?.type;
    if (type === 'CREV_OVERLAY_CLOSE_PENDING') {
      // Iframe is alive + awaiting the user — drop the hung-iframe
      // fallback. Keep listening for the eventual RESPONSE.
      clearTimeout(fallback);
      return;
    }
    if (type !== 'CREV_OVERLAY_CLOSE_RESPONSE') return;
    cleanup();
    if ((e.data as { ok?: boolean }).ok) unmountFrameOverlay(kind);
  };
  const fallback = setTimeout(() => { cleanup(); unmountFrameOverlay(kind); }, 1500);
  const cleanup = () => {
    clearTimeout(fallback);
    window.removeEventListener('message', onMsg);
  };
  window.addEventListener('message', onMsg);
  state.iframe.contentWindow?.postMessage({ type: 'CREV_OVERLAY_CLOSE_REQUEST' }, '*');
}

// ── Drag / resize ─────────────────────────────────────────────

/** Distance from the viewport edge at which snap-to-half kicks in. */
const SNAP_TRIGGER_PX = 24;

type SnapZone = null | 'left' | 'right' | 'top';

function detectSnapZone(clientX: number, clientY: number): SnapZone {
  if (clientY <= SNAP_TRIGGER_PX) return 'top';
  if (clientX <= SNAP_TRIGGER_PX) return 'left';
  if (clientX >= window.innerWidth - SNAP_TRIGGER_PX) return 'right';
  return null;
}

function snapBoundsFor(zone: SnapZone): Bounds | null {
  if (!zone) return null;
  const h = Math.max(MIN_H, window.innerHeight - MARGIN * 2);
  const halfW = Math.max(MIN_W, Math.floor((window.innerWidth - MARGIN * 3) / 2));
  if (zone === 'left') return { left: MARGIN, top: MARGIN, width: halfW, height: h };
  if (zone === 'right') return { left: window.innerWidth - halfW - MARGIN, top: MARGIN, width: halfW, height: h };
  // top → full-width maximised
  return { left: MARGIN, top: MARGIN, width: Math.max(MIN_W, window.innerWidth - MARGIN * 2), height: h };
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
    state.bounds.left = clamp(startLeft + (e.clientX - startX), MARGIN - state.bounds.width + MIN_VISIBLE, window.innerWidth - MIN_VISIBLE);
    state.bounds.top = clamp(startTop + (e.clientY - startY), 0, window.innerHeight - 40);
    state.host.style.left = `${state.bounds.left}px`;
    state.host.style.top = `${state.bounds.top}px`;
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

type ResizeDir = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

function wireResize(state: FrameState, handle: HTMLElement, dir: ResizeDir): () => void {
  let startX = 0, startY = 0;
  let startW = 0, startH = 0, startLeft = 0, startTop = 0;
  let resizing = false;
  let pointerId: number | null = null;

  const onMove = (e: PointerEvent) => {
    if (!resizing) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    let { width, height, left, top } = state.bounds;
    // East / West affect width (and left for west).
    if (dir.includes('e')) {
      width = Math.max(MIN_W, startW + dx);
    } else if (dir.includes('w')) {
      // Width grows by -dx, left moves by dx. Clamp so the host can't
      // shrink past MIN_W (which would otherwise drag `left` past the
      // right edge).
      const proposedWidth = Math.max(MIN_W, startW - dx);
      width = proposedWidth;
      left = startLeft + (startW - proposedWidth);
    }
    // North / South affect height (and top for north).
    if (dir.includes('s')) {
      height = Math.max(MIN_H, startH + dy);
    } else if (dir.includes('n')) {
      const proposedHeight = Math.max(MIN_H, startH - dy);
      height = proposedHeight;
      top = Math.max(0, startTop + (startH - proposedHeight));
    }
    // Viewport clamp — keep at least MIN_VISIBLE of the frame inside
    // the viewport on every side. Same rule onViewportResize already
    // applies; doing it here too means a user can't drag the frame
    // mostly off-screen during a resize, only to have it jerk back
    // when the viewport size changes.
    left = clamp(left, MARGIN - width + MIN_VISIBLE, window.innerWidth - MIN_VISIBLE);
    top = clamp(top, 0, Math.max(0, window.innerHeight - 40));
    state.bounds.width = width;
    state.bounds.height = height;
    state.bounds.left = left;
    state.bounds.top = top;
    state.host.style.width = `${width}px`;
    state.host.style.height = `${height}px`;
    state.host.style.left = `${left}px`;
    state.host.style.top = `${top}px`;
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

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
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
    state.bounds = state.restoreBounds;
    state.restoreBounds = undefined;
    if (btn) { btn.innerHTML = ICON_ARROWS_OUT_SIMPLE; btn.title = 'Maximize'; btn.setAttribute('aria-label', `Maximize ${state.kind}`); }
  } else {
    state.restoreBounds = { ...state.bounds };
    state.bounds = { left: MARGIN, top: MARGIN, width: window.innerWidth - 2 * MARGIN, height: window.innerHeight - 2 * MARGIN };
    if (btn) { btn.innerHTML = ICON_ARROWS_IN_SIMPLE; btn.title = 'Restore'; btn.setAttribute('aria-label', `Restore ${state.kind}`); }
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
      return {
        left: clamp(b.left, 0, Math.max(0, window.innerWidth - MIN_W)),
        top: clamp(b.top, 0, Math.max(0, window.innerHeight - MIN_H)),
        width: clamp(b.width, MIN_W, window.innerWidth),
        height: clamp(b.height, MIN_H, window.innerHeight),
      };
    }
  } catch (e) {
    log.swallow('overlay:readBounds', e);
  }
  const width = Math.min(opts.defaultWidth, window.innerWidth - 80);
  const height = Math.min(opts.defaultHeight, window.innerHeight - 80);
  // Stagger when multiple frames are already open so a second/third overlay
  // doesn't land exactly on top of the first one. Persisted bounds take over
  // on subsequent opens — this only matters the very first time per kind.
  const offset = frames.size * 28;
  return {
    left: clamp(Math.max(MARGIN, (window.innerWidth - width) / 2) + offset, MARGIN, Math.max(MARGIN, window.innerWidth - width - MARGIN)),
    top: clamp(Math.max(MARGIN, (window.innerHeight - height) / 2) + offset, MARGIN, Math.max(MARGIN, window.innerHeight - height - MARGIN)),
    width,
    height,
  };
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
