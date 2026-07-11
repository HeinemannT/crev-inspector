/**
 * Tests for the shared popover viewport-clamping logic in
 * `src/lib/popover-anchor.ts`. Used by both the EC editor's `?` help
 * popover and the EC editor's Book popover; if either drifts, this
 * surfaces it.
 *
 * The helper reads `offsetWidth` / `offsetHeight` from the popover
 * and `clientWidth` / `clientHeight` from `document.documentElement`,
 * so the test runs in a happy-dom environment with both stubbed to
 * the geometry of each scenario.
 *
 * @vitest-environment happy-dom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { anchorPopover } from '../../lib/popover-anchor';

const MARGIN = 8;

/** Build a popover element with the given dimensions and attach it to
 *  the document so it's measurable. Returns the element so the test
 *  can read its computed style.* */
function makePopover(pw: number, ph: number): HTMLElement {
  const el = document.createElement('div');
  el.style.position = 'fixed';
  el.style.width = `${pw}px`;
  el.style.height = `${ph}px`;
  // happy-dom doesn't lay out the box, so offsetWidth/Height come from
  // the inline style mirror — explicitly set them too.
  Object.defineProperty(el, 'offsetWidth', { configurable: true, value: pw });
  Object.defineProperty(el, 'offsetHeight', { configurable: true, value: ph });
  document.body.appendChild(el);
  return el;
}

/** Build a faux anchor whose `getBoundingClientRect` returns the given
 *  rect. anchorPopover only touches that one method on the anchor. */
function makeAnchor(rect: { top: number; bottom: number; left: number; right: number }): HTMLElement {
  const el = document.createElement('div');
  el.getBoundingClientRect = () =>
    ({ ...rect, x: rect.left, y: rect.top, width: rect.right - rect.left, height: rect.bottom - rect.top, toJSON: () => rect }) as DOMRect;
  document.body.appendChild(el);
  return el;
}

/** Stub the viewport dimensions on document.documentElement for the
 *  scope of a test. anchorPopover reads `clientWidth` / `clientHeight`. */
function setViewport(vw: number, vh: number): void {
  Object.defineProperty(document.documentElement, 'clientWidth', { configurable: true, value: vw });
  Object.defineProperty(document.documentElement, 'clientHeight', { configurable: true, value: vh });
}

describe('anchorPopover viewport clamping', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('right-aligns with anchor when fully inside viewport', () => {
    setViewport(1000, 700);
    const popover = makePopover(460, 320);
    const anchor = makeAnchor({ top: 30, bottom: 50, left: 700, right: 720 });
    anchorPopover(popover, anchor);
    expect(popover.style.left).toBe(`${720 - 460}px`);   // = 260
    expect(popover.style.top).toBe('56px');               // bottom + 6
  });

  it('slides left when right edge would clip', () => {
    setViewport(1000, 700);
    const popover = makePopover(460, 320);
    const anchor = makeAnchor({ top: 30, bottom: 50, left: 980, right: 1000 });
    anchorPopover(popover, anchor);
    // vw - pw - MARGIN = 1000 - 460 - 8 = 532
    expect(popover.style.left).toBe('532px');
  });

  it('snaps to MARGIN when popover is wider than viewport', () => {
    setViewport(400, 700);
    const popover = makePopover(460, 320);
    const anchor = makeAnchor({ top: 30, bottom: 50, left: 380, right: 400 });
    anchorPopover(popover, anchor);
    expect(popover.style.left).toBe(`${MARGIN}px`);
  });

  it('flips above when popover would clip bottom but fits above', () => {
    setViewport(1000, 400);
    const popover = makePopover(460, 320);
    const anchor = makeAnchor({ top: 330, bottom: 350, left: 700, right: 720 });
    anchorPopover(popover, anchor);
    // Below: 350 + 6 + 320 = 676 > 400 - 8 = 392 → flip.
    // Flipped: 330 - 6 - 320 = 4 < MARGIN → fall through to
    // Math.max(MARGIN, vh - ph - MARGIN) = max(8, 72) = 72.
    expect(popover.style.top).toBe('72px');
  });

  it('flips fully above when there is room there', () => {
    setViewport(1000, 440);
    const popover = makePopover(200, 200);
    const anchor = makeAnchor({ top: 300, bottom: 320, left: 700, right: 720 });
    anchorPopover(popover, anchor);
    // Below: 320 + 6 + 200 = 526 > 432. Flip: 300 - 6 - 200 = 94 >= MARGIN.
    expect(popover.style.top).toBe('94px');
  });

  it('respects horizontal MARGIN at the left edge', () => {
    setViewport(1000, 700);
    const popover = makePopover(460, 320);
    const anchor = makeAnchor({ top: 30, bottom: 50, left: 10, right: 30 });
    anchorPopover(popover, anchor);
    expect(popover.style.left).toBe(`${MARGIN}px`);
  });

  it('never returns a top below MARGIN', () => {
    setViewport(400, 200);
    const popover = makePopover(200, 800);
    const anchor = makeAnchor({ top: 10, bottom: 30, left: 100, right: 120 });
    anchorPopover(popover, anchor);
    expect(popover.style.top).toBe(`${MARGIN}px`);
  });

  it('clamps to MARGIN when the anchor is scrolled above the top edge (negative rect)', () => {
    // Anchor scrolled out of view above the viewport: rect.bottom is negative.
    // The "fits below" branch would otherwise leave top negative → off-screen.
    setViewport(1000, 700);
    const popover = makePopover(340, 160);
    const anchor = makeAnchor({ top: -80, bottom: -60, left: 400, right: 420 });
    anchorPopover(popover, anchor);
    expect(popover.style.top).toBe(`${MARGIN}px`);
  });

  it('clamps to MARGIN when the anchor is scrolled off the left edge', () => {
    setViewport(1000, 700);
    const popover = makePopover(340, 160);
    const anchor = makeAnchor({ top: 40, bottom: 60, left: -200, right: -180 });
    anchorPopover(popover, anchor);
    expect(popover.style.left).toBe(`${MARGIN}px`);
  });
});
