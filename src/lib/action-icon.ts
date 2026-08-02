/**
 * Toolbar action artwork.
 *
 * Chrome's text badge is intentionally not used for the normal "BMP detected"
 * state: even a single blank character becomes a large coloured block over the
 * 16 DIP icon. Instead, keep the canonical full-colour PNG and add a small,
 * outlined status dot to a cached per-density raster.
 */

export const DEFAULT_ACTION_ICONS: Record<string, string> = {
  16: 'icons/icon-16.png',
  32: 'icons/icon-32.png',
  48: 'icons/icon-48.png',
};

const ACTIVE_DOT = '#42be65';
const ACTIVE_DOT_OUTLINE = '#202124';
const ACTION_ICON_SIZES = [16, 32, 48] as const;

let activeIconDataPromise: Promise<Record<string, ImageData>> | undefined;

function drawActiveDot(context: OffscreenCanvasRenderingContext2D, size: number): void {
  const radius = Math.max(2, Math.round(size / 8));
  const outline = Math.max(1, Math.round(size / 32));
  const outerRadius = radius + outline;
  const center = size - outerRadius - 0.5;

  context.beginPath();
  context.arc(center, center, outerRadius, 0, Math.PI * 2);
  context.fillStyle = ACTIVE_DOT_OUTLINE;
  context.fill();

  context.beginPath();
  context.arc(center, center, radius, 0, Math.PI * 2);
  context.fillStyle = ACTIVE_DOT;
  context.fill();
}

async function renderActiveIcon(size: number): Promise<ImageData> {
  const path = DEFAULT_ACTION_ICONS[String(size)];
  const response = await fetch(chrome.runtime.getURL(path));
  if (!response.ok) throw new Error(`Could not load ${path}`);

  const bitmap = await createImageBitmap(await response.blob());
  try {
    const canvas = new OffscreenCanvas(size, size);
    const context = canvas.getContext('2d');
    if (!context) throw new Error('OffscreenCanvas 2D context unavailable');
    context.drawImage(bitmap, 0, 0, size, size);
    drawActiveDot(context, size);
    return context.getImageData(0, 0, size, size);
  } finally {
    bitmap.close();
  }
}

/** Build once per service-worker lifetime and reuse for every detected tab. */
export function activeActionIconData(): Promise<Record<string, ImageData>> {
  activeIconDataPromise ??= Promise.all(
    ACTION_ICON_SIZES.map(async size => [String(size), await renderActiveIcon(size)] as const),
  ).then(entries => Object.fromEntries(entries));
  return activeIconDataPromise;
}
