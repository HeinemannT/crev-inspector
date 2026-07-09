/**
 * Single source of truth for "rid-shaped" — the predicate that decides whether
 * a value looks like a BMP rid.
 *
 * BMP rids are crypto-random 64-bit Java longs, so in practice they are always
 * many digits. Both sides of the interceptor CustomEvent boundary must agree on
 * this rule: the MAIN-world producer (`interceptor.ts`, which reads
 * `webParentRid`/`selectedTabRid` off the React fiber) and the ISOLATED/SW-world
 * receivers (`validate-inbound.ts`, `handlers/objects.ts`). They used to carry
 * two byte-identical copies of this regex — a drift hazard where one could be
 * tightened without the other. This module is that copy, shared.
 *
 * Deliberately import-free and side-effect-free: `interceptor.ts` is the minimal
 * MAIN-world bundle, so anything it imports must stay pure (no chrome.* / DOM /
 * heavy deps) to bundle cleanly into that script.
 */
export function isRidShaped(v: unknown): v is string {
  return typeof v === 'string' && /^-?\d{6,}$/.test(v);
}
