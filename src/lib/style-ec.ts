/**
 * Shared EC emission for SETTING a style/pane property to a value — used by the side-panel apply
 * (bmp-client.applyObjectChanges) and, next, the blueprint Style-mode apply (layout/ec.ts). One place
 * decides the colour-link-vs-literal rule and the clear semantics, so the two "set a style prop" paths
 * can't diverge (the paintbrush is intentionally NOT a consumer — it COPIES a prop from a source widget
 * `_tgt.p := _src.p`, a different operation; it shares only the reset literals via PAINT_PROP_RESET).
 */
import { COLOR_LINK_PROPS, styleResetLiteral } from './style-props';
import { colorLinkBid } from './types';

/** A sentinel returned when a colour-link value carries a malformed businessId. */
export const INVALID_COLOR_BID = Symbol('invalid-color-bid');

/** The EC right-hand side for `prop := <rhs>`.
 *  - colour-link props: the value is "<bid> <name>" or a bare bid → `t.<bid>`; an EMPTY value CLEARS the
 *    link via its reset literal `""` (verified live: `headerColor := ""` unsets the colour — the old
 *    code SKIPPED empties on a wrong "MISSING is the only clear, and it's a no-op" assumption, so the
 *    panel silently couldn't unset a colour).
 *  - other props: handed to `formatScalar` (the caller's string/number/bool EC-literal formatter, passed
 *    in so this module stays decoupled from BmpClient).
 *  Returns INVALID_COLOR_BID for a malformed colour id so the caller can reject the whole change. */
export function styleAssignRhs(
  prop: string,
  value: string | number | boolean,
  formatScalar: (v: string | number | boolean) => string,
): string | typeof INVALID_COLOR_BID {
  if (COLOR_LINK_PROPS.has(prop)) {
    const bid = colorLinkBid(value);
    if (!bid) return styleResetLiteral(prop); // '' → clear with the type-correct literal ("")
    if (!/^[A-Za-z0-9_]+$/.test(bid)) return INVALID_COLOR_BID;
    return `t.${bid}`;
  }
  return formatScalar(value);
}
