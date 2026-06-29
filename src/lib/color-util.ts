/**
 * Small, pure colour/enum helpers shared across surfaces (side panel, blueprint overlay). These were
 * independently re-implemented in swatch-grid, result.ts, property-editors, and sync — consolidated here
 * so there's one rgb parse, one contrast-ink rule, and one BMP-enum normaliser.
 *
 * Note: `bmp-client.parseAwtColor` stays separate on purpose — it uses a STRICT `r=..,g=..,b=..` regex as
 * a safety gate while parsing the colour-set tree (a loose "any 3 ints" parse there could mis-read a
 * non-colour value). This module handles the already-resolved `rgb(r,g,b)` form.
 */

/** Parse an "rgb(r,g,b)" string (or any string whose first three integers are r,g,b) → [r,g,b], else null. */
export function parseRgbTriple(s: string): [number, number, number] | null {
  const m = (s || '').match(/\d+/g);
  return m && m.length >= 3 ? [Number(m[0]), Number(m[1]), Number(m[2])] : null;
}

/** Normalise an rgb string to a "r,g,b" comparison key, so "rgb(255, 0,0)" === "rgb(255,0,0)". '' if unparseable. */
export function rgbKey(rgb: string): string {
  const t = parseRgbTriple(rgb);
  return t ? `${t[0]},${t[1]},${t[2]}` : '';
}

/** Readable ink colour (#1a1a1a / #fff) for text drawn on an rgb background, via Rec. 601 luma. */
export function contrastInk(rgb: string): string {
  const t = parseRgbTriple(rgb);
  if (!t) return '#fff';
  return (0.299 * t[0] + 0.587 * t[1] + 0.114 * t[2]) > 150 ? '#1a1a1a' : '#fff';
}

/** BMP stringifies enums as "EnumName.value" (e.g. "HeaderStyle.inside", "BorderStyle.LINE"). Reduce to
 *  the bare uppercase member ("INSIDE" / "LINE"); a value with no prefix passes through uppercased. */
export function enumMember(raw: string): string {
  const trimmed = (raw || '').trim();
  const dot = trimmed.lastIndexOf('.');
  return (dot >= 0 ? trimmed.slice(dot + 1) : trimmed).toUpperCase();
}
