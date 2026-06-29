/**
 * Shared pane-edit helpers — the bits of the "edit an object's properties"
 * loop that more than one surface needs, so they can't drift.
 *
 * Today: the draft → typed-`changes` coercion used before APPLY_OBJECT_CHANGES.
 * Both the DetailView (full object pane) and the StyleTab (focused styling
 * surface) stage edits as a `Record<string,string>` draft, then need to turn
 * that into the `Record<string, string|number|boolean>` payload the SW handler
 * + EC serializer expect. The coercion is schema-driven (number/slider → number,
 * boolean → bool, everything else → string), so it lives next to the schema and
 * is reused rather than copy-pasted.
 */
import { findPropDef } from './pane-schema';

/** Coerce a string-valued draft into the typed payload APPLY_OBJECT_CHANGES
 *  wants. Number/slider props become numbers (non-finite → 0), boolean props
 *  become real booleans, and everything else (enums, colour links, text) stays
 *  a string — the client formats EC literals from there. */
export function buildChangesPayload(draft: Record<string, string>): Record<string, string | number | boolean> {
  const changes: Record<string, string | number | boolean> = {};
  for (const prop of Object.keys(draft)) {
    const value = draft[prop];
    const def = findPropDef(prop);
    if (def?.kind === 'number' || def?.kind === 'slider') {
      const n = parseFloat(value);
      changes[prop] = Number.isFinite(n) ? n : 0;
    } else if (def?.kind === 'boolean') {
      changes[prop] = value === 'true' || value === 'TRUE';
    } else {
      changes[prop] = value;
    }
  }
  return changes;
}
