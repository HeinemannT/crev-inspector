/**
 * Pure geometry for the in-page task frames.
 *
 * Every operation returns a rectangle that fits inside the current viewport.
 * Keeping this independent from DOM state prevents restore, drag, resize,
 * snap, and browser-resize handling from quietly developing different rules.
 */

export const FRAME_MARGIN = 16;
export const FRAME_MIN_WIDTH = 360;
export const FRAME_MIN_HEIGHT = 240;
export const FRAME_SNAP_TRIGGER = 24;

export interface FrameBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface FrameViewport {
  width: number;
  height: number;
}

export type FrameResizeDirection = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';
export type FrameSnapZone = null | 'left' | 'right' | 'top';

interface FrameLimits {
  insetX: number;
  insetY: number;
  availableWidth: number;
  availableHeight: number;
  minimumWidth: number;
  minimumHeight: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function limitsFor(viewport: FrameViewport): FrameLimits {
  const width = Math.max(1, finiteOr(viewport.width, 1));
  const height = Math.max(1, finiteOr(viewport.height, 1));
  // On an exceptionally small viewport, reduce the margin before reducing the
  // task surface. This keeps the full titlebar and close control reachable.
  const insetX = Math.min(FRAME_MARGIN, Math.max(0, Math.floor((width - 1) / 2)));
  const insetY = Math.min(FRAME_MARGIN, Math.max(0, Math.floor((height - 1) / 2)));
  const availableWidth = Math.max(1, width - insetX * 2);
  const availableHeight = Math.max(1, height - insetY * 2);
  return {
    insetX,
    insetY,
    availableWidth,
    availableHeight,
    minimumWidth: Math.min(FRAME_MIN_WIDTH, availableWidth),
    minimumHeight: Math.min(FRAME_MIN_HEIGHT, availableHeight),
  };
}

/** Repair arbitrary or persisted bounds for the current viewport. Size is
 * constrained first, then position, so the resulting right/bottom edges
 * cannot escape after a browser resize or zoom change. */
export function fitFrameBounds(bounds: FrameBounds, viewport: FrameViewport): FrameBounds {
  const limits = limitsFor(viewport);
  const width = clamp(
    finiteOr(bounds.width, limits.minimumWidth),
    limits.minimumWidth,
    limits.availableWidth,
  );
  const height = clamp(
    finiteOr(bounds.height, limits.minimumHeight),
    limits.minimumHeight,
    limits.availableHeight,
  );
  return {
    left: clamp(
      finiteOr(bounds.left, limits.insetX),
      limits.insetX,
      limits.insetX + limits.availableWidth - width,
    ),
    top: clamp(
      finiteOr(bounds.top, limits.insetY),
      limits.insetY,
      limits.insetY + limits.availableHeight - height,
    ),
    width,
    height,
  };
}

export function centeredFrameBounds(
  desiredWidth: number,
  desiredHeight: number,
  viewport: FrameViewport,
  offset = 0,
): FrameBounds {
  const limits = limitsFor(viewport);
  const width = clamp(desiredWidth, limits.minimumWidth, limits.availableWidth);
  const height = clamp(desiredHeight, limits.minimumHeight, limits.availableHeight);
  return fitFrameBounds({
    left: limits.insetX + (limits.availableWidth - width) / 2 + offset,
    top: limits.insetY + (limits.availableHeight - height) / 2 + offset,
    width,
    height,
  }, viewport);
}

export function maximizedFrameBounds(viewport: FrameViewport): FrameBounds {
  const limits = limitsFor(viewport);
  return {
    left: limits.insetX,
    top: limits.insetY,
    width: limits.availableWidth,
    height: limits.availableHeight,
  };
}

export function moveFrameBounds(
  start: FrameBounds,
  deltaX: number,
  deltaY: number,
  viewport: FrameViewport,
): FrameBounds {
  const fitted = fitFrameBounds(start, viewport);
  return fitFrameBounds({
    ...fitted,
    left: fitted.left + deltaX,
    top: fitted.top + deltaY,
  }, viewport);
}

/** Resize while keeping the opposite edge anchored. This avoids the jump that
 * a generic post-resize clamp causes when an east/south edge reaches the
 * viewport boundary. */
export function resizeFrameBounds(
  start: FrameBounds,
  direction: FrameResizeDirection,
  deltaX: number,
  deltaY: number,
  viewport: FrameViewport,
): FrameBounds {
  const limits = limitsFor(viewport);
  const fitted = fitFrameBounds(start, viewport);
  const right = fitted.left + fitted.width;
  const bottom = fitted.top + fitted.height;
  let { left, top, width, height } = fitted;

  if (direction.includes('e')) {
    width = clamp(
      fitted.width + deltaX,
      limits.minimumWidth,
      limits.insetX + limits.availableWidth - fitted.left,
    );
  } else if (direction.includes('w')) {
    left = clamp(
      fitted.left + deltaX,
      limits.insetX,
      right - limits.minimumWidth,
    );
    width = right - left;
  }

  if (direction.includes('s')) {
    height = clamp(
      fitted.height + deltaY,
      limits.minimumHeight,
      limits.insetY + limits.availableHeight - fitted.top,
    );
  } else if (direction.includes('n')) {
    top = clamp(
      fitted.top + deltaY,
      limits.insetY,
      bottom - limits.minimumHeight,
    );
    height = bottom - top;
  }

  return fitFrameBounds({ left, top, width, height }, viewport);
}

export function detectFrameSnapZone(
  clientX: number,
  clientY: number,
  viewportWidth: number,
): FrameSnapZone {
  if (clientY <= FRAME_SNAP_TRIGGER) return 'top';
  if (clientX <= FRAME_SNAP_TRIGGER) return 'left';
  if (clientX >= viewportWidth - FRAME_SNAP_TRIGGER) return 'right';
  return null;
}

export function snapFrameBounds(zone: FrameSnapZone, viewport: FrameViewport): FrameBounds | null {
  if (!zone) return null;
  const limits = limitsFor(viewport);
  if (zone === 'top') return maximizedFrameBounds(viewport);

  const width = clamp(
    Math.floor((limits.availableWidth - FRAME_MARGIN) / 2),
    limits.minimumWidth,
    limits.availableWidth,
  );
  const left = zone === 'left'
    ? limits.insetX
    : limits.insetX + limits.availableWidth - width;
  return {
    left,
    top: limits.insetY,
    width,
    height: limits.availableHeight,
  };
}
