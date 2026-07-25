import { describe, expect, it } from 'vitest';
import {
  FRAME_MARGIN,
  FRAME_MIN_HEIGHT,
  FRAME_MIN_WIDTH,
  FRAME_SNAP_TRIGGER,
  centeredFrameBounds,
  detectFrameSnapZone,
  fitFrameBounds,
  maximizedFrameBounds,
  moveFrameBounds,
  resizeFrameBounds,
  snapFrameBounds,
  type FrameBounds,
  type FrameViewport,
} from '../lib/frame-geometry';

function expectInside(bounds: FrameBounds, viewport: FrameViewport): void {
  expect(bounds.left).toBeGreaterThanOrEqual(0);
  expect(bounds.top).toBeGreaterThanOrEqual(0);
  expect(bounds.left + bounds.width).toBeLessThanOrEqual(viewport.width);
  expect(bounds.top + bounds.height).toBeLessThanOrEqual(viewport.height);
}

describe('detectFrameSnapZone', () => {
  const width = 1600;

  it('recognises the three edge zones and gives top priority at corners', () => {
    expect(detectFrameSnapZone(800, 400, width)).toBeNull();
    expect(detectFrameSnapZone(FRAME_SNAP_TRIGGER, 400, width)).toBe('left');
    expect(detectFrameSnapZone(width - FRAME_SNAP_TRIGGER, 400, width)).toBe('right');
    expect(detectFrameSnapZone(10, 10, width)).toBe('top');
    expect(detectFrameSnapZone(width - 10, 10, width)).toBe('top');
  });
});

describe('frame geometry', () => {
  it('centres a fresh editor at its preferred size', () => {
    expect(centeredFrameBounds(960, 640, { width: 1600, height: 900 })).toEqual({
      left: 320,
      top: 130,
      width: 960,
      height: 640,
    });
  });

  it('repairs large-screen saved bounds for a smaller viewport as one rectangle', () => {
    const viewport = { width: 1024, height: 700 };
    const restored = fitFrameBounds({
      left: 1100,
      top: 500,
      width: 1200,
      height: 800,
    }, viewport);

    expect(restored).toEqual({
      left: FRAME_MARGIN,
      top: FRAME_MARGIN,
      width: viewport.width - FRAME_MARGIN * 2,
      height: viewport.height - FRAME_MARGIN * 2,
    });
    expectInside(restored, viewport);
  });

  it('keeps the entire frame visible when dragged beyond every edge', () => {
    const viewport = { width: 1366, height: 768 };
    const start = centeredFrameBounds(960, 640, viewport);

    for (const [dx, dy] of [[-5000, 0], [5000, 0], [0, -5000], [0, 5000]] as const) {
      expectInside(moveFrameBounds(start, dx, dy, viewport), viewport);
    }
  });

  it('anchors the opposite edge and caps every resize direction', () => {
    const viewport = { width: 1200, height: 800 };
    const start = { left: 200, top: 120, width: 700, height: 500 };

    const east = resizeFrameBounds(start, 'e', 5000, 0, viewport);
    expect(east.left).toBe(start.left);
    expect(east.left + east.width).toBe(viewport.width - FRAME_MARGIN);

    const west = resizeFrameBounds(start, 'w', -5000, 0, viewport);
    expect(west.left).toBe(FRAME_MARGIN);
    expect(west.left + west.width).toBe(start.left + start.width);

    const south = resizeFrameBounds(start, 's', 0, 5000, viewport);
    expect(south.top).toBe(start.top);
    expect(south.top + south.height).toBe(viewport.height - FRAME_MARGIN);

    const north = resizeFrameBounds(start, 'n', 0, -5000, viewport);
    expect(north.top).toBe(FRAME_MARGIN);
    expect(north.top + north.height).toBe(start.top + start.height);

    for (const bounds of [east, west, south, north]) expectInside(bounds, viewport);
  });

  it('uses normal minimums when possible and shrinks fully inside tiny viewports', () => {
    const normal = fitFrameBounds({ left: 0, top: 0, width: 10, height: 10 }, { width: 800, height: 600 });
    expect(normal.width).toBe(FRAME_MIN_WIDTH);
    expect(normal.height).toBe(FRAME_MIN_HEIGHT);

    const tinyViewport = { width: 280, height: 180 };
    const tiny = fitFrameBounds({ left: 900, top: 900, width: 960, height: 640 }, tinyViewport);
    expect(tiny.width).toBeLessThan(FRAME_MIN_WIDTH);
    expect(tiny.height).toBeLessThan(FRAME_MIN_HEIGHT);
    expectInside(tiny, tinyViewport);
  });

  it('produces fully visible left, right, and maximized snap bounds', () => {
    const viewport = { width: 1600, height: 900 };
    const left = snapFrameBounds('left', viewport)!;
    const right = snapFrameBounds('right', viewport)!;
    const top = snapFrameBounds('top', viewport)!;

    expect(left.left).toBe(FRAME_MARGIN);
    expect(right.left + right.width).toBe(viewport.width - FRAME_MARGIN);
    expect(top).toEqual(maximizedFrameBounds(viewport));
    for (const bounds of [left, right, top]) expectInside(bounds, viewport);
  });

  it('keeps snap bounds inside narrow and short viewports', () => {
    for (const viewport of [{ width: 600, height: 100 }, { width: 300, height: 180 }]) {
      for (const zone of ['left', 'right', 'top'] as const) {
        expectInside(snapFrameBounds(zone, viewport)!, viewport);
      }
    }
  });
});
