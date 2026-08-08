/**
 * Sanitisation guards for any value interpolated into raw EC source.
 *
 * Background: EC is a stringly-typed language. When we build EC like
 *
 *     _o.change(${property} := "${value}")
 *     _r := _r + _sep + "child_${prop}_" + _c.rid + _sep + output(_c.${prop})
 *
 * the *value* slot is escaped (formatEcLiteral), but the *identifier*
 * slot is bare. A property name like `xyz, hostile := lookup(123)` would
 * close the change() argument and inject arbitrary EC. In practice the
 * inputs are always BMP-derived allowlists (PANE_PROPS_SET, ALL_CODE_
 * FIELDS), but those are runtime data — they can be corrupted by a
 * future refactor or a bug in metadata loading. These guards are
 * defence-in-depth so an injection can't sneak in through that hole.
 *
 * Throws (rather than returning falsy) because every caller wants to
 * fail loud, not silently emit broken EC.
 */

/** Java/EC identifier: a letter or underscore, then letters/digits/underscores.
 *  Matches the same shape that `_o.foo` would accept on the BMP side. */
const ID_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Decimal integer, optionally signed. BMP RIDs are positive `long`s but
 *  the regex is liberal because some derived ids carry signs in tests. */
const RID_RE = /^-?\d+$/;

export function validateEcIdentifier(name: string): string {
  if (!ID_RE.test(name)) throw new Error(`Invalid EC identifier: ${name}`);
  return name;
}

export function validateRid(rid: string): string {
  if (!RID_RE.test(rid)) throw new Error(`Invalid RID: ${rid}`);
  return rid;
}

/** BMP business id (the `t.<id>` namespace key). Unlike an EC identifier it MAY start with a digit
 *  (ids like `4957` are common) — they're generated per-IdSpace and are alphanumeric/underscore. */
const BID_RE = /^[A-Za-z0-9_]+$/;
export function validateBusinessId(id: string): string {
  if (!BID_RE.test(id)) throw new Error(`Invalid business id: ${id}`);
  return id;
}

/** Escape a value for embedding inside a double-quoted EC string literal:
 *  `"...${formatEcLiteral(v)}..."`. This is the *value-slot* guard referenced
 *  in the module comment — it escapes the five metacharacters the BMP EC parser
 *  treats specially (backslash, double-quote, CR, LF, tab) so an attacker-influenced
 *  value (e.g. an uploaded filename) can't break out of the literal. Pair it
 *  with validateEcIdentifier for the identifier slot. Always prefer this over
 *  ad-hoc character-stripping, which protects only by accident. */
export function formatEcLiteral(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
    .replace(/\t/g, '\\t');
}
