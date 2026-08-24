/**
 * Custom tool cursors — an eyedropper for "pick a source" and a paintbrush for "apply the held
 * style". Used by the Blueprint style-mode brush (content-blueprint.css,
 * reached through CSS variables set on the overlay layer).
 *
 * Each icon is drawn twice — a white halo underlay then the accent stroke — so it stays legible
 * over any widget background. Hotspot sits on the tool's tip.
 *
 * Chromium rasterises an SVG cursor at its CSS-pixel size and does NOT re-render for
 * devicePixelRatio — a bare 24px cursor is upscaled (blurry) on scaled displays. `image-set`
 * ships pre-scaled rasters; the browser picks the nearest to the effective dpr (which includes
 * page zoom), so the cursor stays sharp on 100%/125%/150%/200% laptop scaling alike. The
 * trailing `crosshair` is the fallback if a data-URI cursor is rejected.
 */

const EYEDROPPER_PATHS =
  '<path d="m2 22 1-1h3l9-9"/><path d="M3 21v-3l9-9"/>' +
  '<path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"/>';

const PAINTBRUSH_PATHS =
  '<path d="M18.37 2.63 14 7l-1.59-1.59a2 2 0 0 0-2.82 0L8 7l9 9 1.59-1.59a2 2 0 0 0 0-2.82L17 10l4.37-4.37a2.12 2.12 0 1 0-3-3Z"/>' +
  '<path d="M9 8c-2 3-4 3.5-7 4l8 10c2-1 6-5 6-7"/><path d="M14.5 17.5 4.5 15"/>';

function svgCursor(paths: string, px: number): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 24 24" ` +
    'fill="none" stroke-linecap="round" stroke-linejoin="round" shape-rendering="geometricPrecision">' +
    `<g stroke="#ffffff" stroke-width="4">${paths}</g>` +
    // Mirrors the --accent token (#8b5cf6). Hardcoded because this cursor is a data:image SVG
    // injected into the BMP page, where the extension's CSS custom properties aren't readable.
    `<g stroke="#8b5cf6" stroke-width="2.25">${paths}</g></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}

/** 24 CSS px cursor with rasters for the common laptop scale factors. Hotspot in CSS px. */
function cursorUrl(paths: string, hotX: number, hotY: number): string {
  const variants = [1, 1.5, 2, 3]
    .map(dpr => `${svgCursor(paths, Math.round(24 * dpr))} ${dpr}x`)
    .join(', ');
  return `-webkit-image-set(${variants}) ${hotX} ${hotY}, crosshair`;
}

/** Eyedropper — sampling a source style. Hotspot on the dropper tip (bottom-left). */
export const PICK_CURSOR = cursorUrl(EYEDROPPER_PATHS, 2, 22);
/** Paintbrush — applying the held style to targets. Hotspot on the bristle tip. */
export const APPLY_CURSOR = cursorUrl(PAINTBRUSH_PATHS, 3, 20);
