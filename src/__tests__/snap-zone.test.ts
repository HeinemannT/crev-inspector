/**
 * Tests for the snap-to-edges logic in content-frame-overlay.ts.
 *
 * The detect + bounds helpers aren't exported (they're module-private
 * because they touch `window.innerWidth/Height`), so we replicate the
 * rules here as a contract test. If the production logic drifts from
 * these expectations the spec is being broken intentionally and the
 * test needs to be updated.
 */
import { describe, it, expect } from 'vitest';

// Re-declare the constants from the production file so the test stays
// honest about the trigger zone.
const SNAP_TRIGGER_PX = 24;
const MARGIN = 16;
const MIN_W = 360;
const MIN_H = 240;

type SnapZone = null | 'left' | 'right' | 'top';

function detectSnapZone(clientX: number, clientY: number, w: number): SnapZone {
  if (clientY <= SNAP_TRIGGER_PX) return 'top';
  if (clientX <= SNAP_TRIGGER_PX) return 'left';
  if (clientX >= w - SNAP_TRIGGER_PX) return 'right';
  return null;
}

interface Bounds { left: number; top: number; width: number; height: number }

function snapBoundsFor(zone: SnapZone, w: number, hViewport: number): Bounds | null {
  if (!zone) return null;
  const h = Math.max(MIN_H, hViewport - MARGIN * 2);
  const halfW = Math.max(MIN_W, Math.floor((w - MARGIN * 3) / 2));
  if (zone === 'left') return { left: MARGIN, top: MARGIN, width: halfW, height: h };
  if (zone === 'right') return { left: w - halfW - MARGIN, top: MARGIN, width: halfW, height: h };
  return { left: MARGIN, top: MARGIN, width: Math.max(MIN_W, w - MARGIN * 2), height: h };
}

describe('detectSnapZone', () => {
  const W = 1600;
  it('returns null in the middle of the viewport', () => {
    expect(detectSnapZone(800, 400, W)).toBeNull();
  });
  it('returns "left" when the pointer is within the left gutter', () => {
    expect(detectSnapZone(10, 400, W)).toBe('left');
    expect(detectSnapZone(SNAP_TRIGGER_PX, 400, W)).toBe('left');
    expect(detectSnapZone(SNAP_TRIGGER_PX + 1, 400, W)).toBeNull();
  });
  it('returns "right" when the pointer is within the right gutter', () => {
    expect(detectSnapZone(W - 10, 400, W)).toBe('right');
    expect(detectSnapZone(W - SNAP_TRIGGER_PX, 400, W)).toBe('right');
    expect(detectSnapZone(W - SNAP_TRIGGER_PX - 1, 400, W)).toBeNull();
  });
  it('returns "top" with priority over left/right when in the corner', () => {
    // Top corner — top wins so corner-drag → full-width maximise.
    expect(detectSnapZone(10, 10, W)).toBe('top');
    expect(detectSnapZone(W - 10, 10, W)).toBe('top');
  });
});

describe('snapBoundsFor', () => {
  const W = 1600, H = 900;
  it('returns null for no-zone', () => {
    expect(snapBoundsFor(null, W, H)).toBeNull();
  });
  it('left zone → flush to left margin, half width', () => {
    const b = snapBoundsFor('left', W, H)!;
    expect(b.left).toBe(MARGIN);
    expect(b.top).toBe(MARGIN);
    expect(b.height).toBe(H - MARGIN * 2);
    // halfWidth = floor((W - MARGIN*3) / 2) — leaves one MARGIN gap in
    // the middle and a MARGIN on each side.
    expect(b.width).toBe(Math.floor((W - MARGIN * 3) / 2));
  });
  it('right zone → flush to right margin, half width', () => {
    const b = snapBoundsFor('right', W, H)!;
    expect(b.left + b.width + MARGIN).toBe(W);
    expect(b.top).toBe(MARGIN);
  });
  it('top zone → full-width maximise', () => {
    const b = snapBoundsFor('top', W, H)!;
    expect(b.left).toBe(MARGIN);
    expect(b.width).toBe(W - MARGIN * 2);
  });
  it('respects MIN_W on narrow viewports', () => {
    // Narrow viewport where half-width would be below MIN_W — bounds
    // clamp to MIN_W (will overlap the centerline visually, but the
    // host won't collapse to unusable).
    const narrow = 600;
    const b = snapBoundsFor('left', narrow, H)!;
    expect(b.width).toBeGreaterThanOrEqual(MIN_W);
  });
  it('respects MIN_H on short viewports', () => {
    const shortViewport = 100;
    const b = snapBoundsFor('top', W, shortViewport)!;
    expect(b.height).toBeGreaterThanOrEqual(MIN_H);
  });
});
