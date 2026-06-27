/**
 * Widget thumbnails for the result canvas.
 *
 * The result view is a wireframe; to make it recognisable as the page itself, each cell shows a
 * snapshot of the real widget beneath. We get those WITHOUT a per-element snapshot library and
 * WITHOUT reloading iframes: the SW screenshots the visible viewport (`chrome.tabs.captureVisibleTab`,
 * real pixels — CVO iframes included), and we crop each widget's on-screen rect out of that image.
 *
 * Limits, handled gracefully: captureVisibleTab only sees the VISIBLE viewport, so off-screen widgets
 * aren't captured until scrolled into view (their cells keep the icon + watermark). Captures are
 * debounced + throttled (the API is rate-limited) and cached per rid (layout editing doesn't change
 * widget content, so one shot per widget is enough). The opaque result panel is hidden for the shot
 * so the camera sees the real page, then restored.
 */
import { sendRequest } from '../lib/messaging';
import type { InspectorMessage } from '../lib/types';
import { LAYER_ID } from './state';

type CaptureResult = Extract<InspectorMessage, { type: 'LAYOUT_CAPTURE_RESULT' }>;

const cache = new Map<string, string>();   // rid → thumbnail dataURL ('' = captured but empty/blank)
let capturing = false;
let timer: ReturnType<typeof setTimeout> | undefined;

/** Cached thumbnail for a widget, or undefined if not captured yet. */
export function thumbFor(rid: string): string | undefined { return cache.get(rid); }

/** Drop all thumbnails (session teardown / hard refresh). */
export function clearThumbs(): void { cache.clear(); }

const onScreen = (r: DOMRect): boolean =>
  r.width >= 8 && r.height >= 8 && r.bottom > 0 && r.top < innerHeight && r.right > 0 && r.left < innerWidth;

/** Debounced: capture any VISIBLE widgets that aren't cached yet, then call `onCaptured` to repaint.
 *  Safe to call on every render/scroll — it coalesces and no-ops when there's nothing new to grab. */
export function scheduleThumbs(byRid: Map<string, Element>, onCaptured: () => void): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { void captureMissing(byRid, onCaptured); }, 320);
}

/** Capture the initial viewport NOW (awaitable). Called at load BEFORE the opaque result panel is
 *  rendered, so there's no panel to hide and therefore NO flicker — the bulk of thumbnails are ready
 *  for the first paint. (captureMissing's hide is conditional on the panel existing.) */
export async function captureViewportNow(byRid: Map<string, Element>): Promise<void> {
  await captureMissing(byRid, () => {});
}

async function captureMissing(byRid: Map<string, Element>, onCaptured: () => void): Promise<void> {
  if (capturing) return;
  const targets: { rid: string; rect: DOMRect }[] = [];
  for (const [rid, el] of byRid) {
    if (cache.has(rid)) continue;
    const rect = el.getBoundingClientRect();
    if (onScreen(rect)) targets.push({ rid, rect });
  }
  if (!targets.length) return;

  capturing = true;
  const panel = document.getElementById(LAYER_ID)?.querySelector('.bp-result') as HTMLElement | null;
  try {
    if (panel) panel.style.visibility = 'hidden';            // reveal the real page for the shot
    await nextFrames(2);                                      // let the hide paint before capturing
    const res = await sendRequest<CaptureResult>({ type: 'LAYOUT_CAPTURE' });
    if (panel) panel.style.visibility = '';
    if (res?.ok && res.dataUrl) await crop(res.dataUrl, targets);
  } catch { /* leave uncached → cell keeps icon + watermark */ }
  finally { capturing = false; }
  onCaptured();
}

/** Crop each target rect out of the viewport screenshot into a downscaled per-rid PNG. */
async function crop(dataUrl: string, targets: { rid: string; rect: DOMRect }[]): Promise<void> {
  const img = await loadImage(dataUrl);
  const dpr = img.width / innerWidth || 1;   // capture is viewport × devicePixelRatio
  const MAX_W = 360;                          // cap thumbnail resolution (memory)
  for (const { rid, rect } of targets) {
    const sx = Math.max(0, rect.left * dpr), sy = Math.max(0, rect.top * dpr);
    const sw = Math.min(rect.width * dpr, img.width - sx), sh = Math.min(rect.height * dpr, img.height - sy);
    if (sw < 4 || sh < 4) { cache.set(rid, ''); continue; }
    const scale = Math.min(1, MAX_W / sw);
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(sw * scale));
    c.height = Math.max(1, Math.round(sh * scale));
    const ctx = c.getContext('2d');
    if (!ctx) { cache.set(rid, ''); continue; }
    ctx.drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
    try { cache.set(rid, c.toDataURL('image/png')); } catch { cache.set(rid, ''); }
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((ok, err) => { const i = new Image(); i.onload = () => ok(i); i.onerror = err; i.src = src; });
}
function nextFrames(n: number): Promise<void> {
  return new Promise(res => { const step = () => (--n <= 0 ? res() : requestAnimationFrame(step)); requestAnimationFrame(step); });
}
