/**
 * Shared positioning helper for click-anchored popovers.
 *
 * Both the EC editor's `?` help popover (`showEditorHelp` in
 * editor.ts) and the EC editor's Book popover (`showBookPopover` in
 * editor/book.ts) used to duplicate identical viewport-clamp logic.
 * Extracted here so a layout fix lands in both places at once.
 *
 * The popover MUST already be in the DOM when this is called — we
 * read `offsetWidth` / `offsetHeight` for the clamp, so the element
 * needs to have rendered at its natural size first. The caller
 * typically positions it off-screen for the initial paint:
 *
 *   const el = h('div', { style: 'top:-9999px; left:-9999px;', ... })
 *   document.body.appendChild(el)
 *   // … populate el …
 *   anchorPopover(el, anchorButton)
 */

/** Distance kept between the popover and the viewport edge. */
const MARGIN = 8

/** Distance between the anchor's bottom edge and the popover's top. */
const ANCHOR_GAP = 6

/** Position `popover` under `anchor`, right-aligned with the anchor.
 *  Slides back inside the viewport when it would overflow the right
 *  or bottom edge. Flips ABOVE the anchor (preferred) if the popover
 *  would overflow the bottom AND there's space above; falls back to
 *  pinning at the top edge with overflow on the bottom otherwise. */
export function anchorPopover(popover: HTMLElement, anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect()
  const pw = popover.offsetWidth
  const ph = popover.offsetHeight
  const vw = document.documentElement.clientWidth
  const vh = document.documentElement.clientHeight

  // Horizontal: right-align with the anchor, slide left if we'd overflow.
  let left = rect.right - pw
  if (left + pw > vw - MARGIN) left = vw - pw - MARGIN
  if (left < MARGIN) left = MARGIN

  // Vertical: below the anchor by default. Flip above if it'd overflow
  // the bottom AND flipping fits; otherwise pin at the top edge.
  let top = rect.bottom + ANCHOR_GAP
  if (top + ph > vh - MARGIN) {
    const flipped = rect.top - ANCHOR_GAP - ph
    top = flipped >= MARGIN ? flipped : Math.max(MARGIN, vh - ph - MARGIN)
  }

  // Final safety clamp on BOTH axes — the branches above don't cover an anchor
  // scrolled off the top/left edge (negative rect), which would otherwise leave
  // the popover partially outside the viewport. Never place past MARGIN; when
  // the popover is larger than the viewport, pin to MARGIN and let it overflow
  // the far edge (best effort without resizing).
  left = clamp(left, MARGIN, Math.max(MARGIN, vw - pw - MARGIN))
  top = clamp(top, MARGIN, Math.max(MARGIN, vh - ph - MARGIN))

  popover.style.left = `${left}px`
  popover.style.top = `${top}px`
}

/** Constrain `v` to the inclusive `[lo, hi]` range. */
function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi)
}
