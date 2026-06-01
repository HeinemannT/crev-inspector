/**
 * Shared "Layout ↗" routing.
 *
 * The side-panel detail view and the Object View popout both offer a
 * "Layout ↗" shortcut that opens a layout-bearing object in the Workshop's
 * Layout view. Both must route identically — open the object itself if it's
 * layout-bearing, otherwise its containing parent (Container/Tab), with the
 * original object highlighted. This module is the single source of truth for
 * that decision so the two surfaces can't drift.
 */

/** Types that can be the target of a "Layout ↗" shortcut. A Scorecard is
 *  included here (it's a valid Layout-view target) even though it doesn't
 *  render a container grid — see LAYOUT_TREE_TYPES in workshop-layout-pane
 *  for the narrower "renders a draggable grid tree" set. */
export const LAYOUT_BEARING_TYPES: ReadonlySet<string> = new Set([
  'Scorecard', 'TabSet', 'Tab', 'Container',
]);

export interface LayoutShortcut {
  /** The layout-bearing object to open in the Layout view. */
  target: string;
  /** The target's type (e.g. "Tab", "Container") — so callers can label the
   *  button without reaching back into the parent identity themselves. */
  targetType: string;
  /** The row to flash in the resulting tree — the original object. Undefined
   *  when the target IS the original object (nothing to disambiguate). */
  highlight?: string;
  /** True when the object itself is layout-bearing (vs. routed to its parent). */
  selfIsLayout: boolean;
}

/** Resolve the "Layout ↗" target for an object given its parent.
 *  Returns null when neither the object nor its parent is layout-bearing
 *  (in which case the shortcut should be hidden). */
export function resolveLayoutShortcut(
  self: { rid: string; type?: string | null },
  parent: { rid: string; type?: string | null } | null | undefined,
): LayoutShortcut | null {
  if (self.type && LAYOUT_BEARING_TYPES.has(self.type)) {
    return { target: self.rid, targetType: self.type, selfIsLayout: true };
  }
  if (parent?.type && LAYOUT_BEARING_TYPES.has(parent.type)) {
    return { target: parent.rid, targetType: parent.type, highlight: self.rid, selfIsLayout: false };
  }
  return null;
}
