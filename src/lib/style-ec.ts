/**
 * Shared EC emission for SETTING a style/pane property to a value — used by the side-panel apply
 * (bmp-client.applyObjectChanges) and, next, the blueprint Style-mode apply (layout/ec.ts). One place
 * decides the colour-link-vs-literal rule and the clear semantics, so the two "set a style prop" paths
 * can't diverge (the paintbrush is intentionally NOT a consumer — it COPIES a prop from a source widget
 * `_tgt.p := _src.p`, a different operation; it shares only the reset literals via PAINT_PROP_RESET).
 */
import { COLOR_LINK_PROPS, styleResetLiteral } from './style-props';
import { colorLinkBid } from './color-util';

/** A sentinel returned when a colour-link value carries a malformed businessId. */
export const INVALID_COLOR_BID = Symbol('invalid-color-bid');

/** The EC right-hand side for `prop := <rhs>`.
 *  - colour-link props: the value is "<bid> <name>" or a bare bid → `t.<bid>`; an EMPTY value CLEARS the
 *    link via its reset literal `""` (verified live: `headerColor := ""` unsets the colour — the old
 *    code SKIPPED empties on a wrong "MISSING is the only clear, and it's a no-op" assumption, so the
 *    panel silently couldn't unset a colour).
 *  - other props: an EMPTY value ('') is a CLEAR → the prop's own type-correct reset literal
 *    (`styleResetLiteral`, e.g. enum → "None"); `:= ""` ERRORS on enum/number props, so this is the ONE
 *    place that decides clear semantics for scalars too (previously only colour links cleared correctly,
 *    so the blueprint's enum-clear path emitted `headerStyle := ""` and BMP rejected it). A real value is
 *    handed to `formatScalar` (the caller's string/number/bool EC-literal formatter, injected so this
 *    module stays decoupled from BmpClient).
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
  if (value === '') return styleResetLiteral(prop); // enum/scalar clear → "None"/0/FALSE, never `:= ""`
  return formatScalar(value);
}
