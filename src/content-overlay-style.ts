/**
 * Shared injection of the single overlay stylesheet.
 *
 * The sheet carries BOTH the inspect-mode rules (badges, hover card) AND the frame-overlay host
 * positioning — `.crev-eo-host` is `position: absolute` in `content-overlay.css`. So every surface that
 * appends `crev-eo-host` to the page (the EC editor, diff, object view, code search) depends on it just
 * as much as Inspect does.
 *
 * It used to be injected ONLY when Inspect turned on (`content.ts` injectStyles). That left a leak: open
 * a frame surface on a page where Inspect was never pressed (e.g. the EC editor from the Steadfast
 * landing page) and the host had no positioning, so it dropped into normal page flow at the bottom-left.
 * Pressing Inspect afterwards injected the sheet and "fixed" it. This module lets any entry point
 * guarantee the sheet first.
 *
 * Idempotency is DOM-based (not a state flag) so it re-injects correctly after a teardown that removed
 * the element (content.ts removes it by id on re-injection), and so it's safe to call from modules that
 * don't share ContentState.
 */
import OVERLAY_CSS from './content-overlay.css';

/** Id of the injected overlay stylesheet — single source of truth for injecting and removing it. */
export const OVERLAY_STYLE_ID = 'crev-inspector-styles';

/** Inject the overlay stylesheet exactly once. Safe to call from Inspect activation or from a frame
 *  overlay mount, in any order. */
export function ensureOverlayStyle(): void {
  if (document.getElementById(OVERLAY_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = OVERLAY_STYLE_ID;
  style.textContent = OVERLAY_CSS;
  document.head.appendChild(style);
}
