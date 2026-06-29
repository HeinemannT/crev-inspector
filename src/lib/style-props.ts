/**
 * The single catalog of WIDGET STYLE PROPERTIES — the paintable appearance props the side panel, the
 * paintbrush, and the blueprint Style mode all operate on. One source of truth, so adding a style prop
 * is ONE edit here instead of the old hand-maintained fan-out (PAINT_STYLE_PROPS / COLOR_LINK_PROPS /
 * PAINT_PROP_RESET are now DERIVED from this).
 *
 * Lives in lib/ — not sidepanel/pane-schema — so every layer (SW handlers, content scripts, the EC
 * compiler) can import it. pane-schema.ts layers UI metadata (label / kind / options / availableOn) on
 * top and is locked to this catalog by a test (pane-schema.test.ts) so the two can't drift.
 */

export interface StylePropDef {
  /** BMP property name. */
  prop: string;
  /** True for CorpoColor LINK props — set as `prop := t.<bid>`, never a literal value. */
  colorLink: boolean;
  /** EC literal that clears the prop to "no styling" (type-correct, live-verified): colour links → ""
   *  (an empty link clears — verified live 2026-06-29), transparency → 0, shadow → FALSE, the
   *  header/border-style enums → "None". NOTE `:= ""` ERRORS on number/enum props and `:= MISSING` is a
   *  silent no-op, which is why each prop carries its own correct reset literal. */
  reset: string;
}

export const STYLE_PROPS: readonly StylePropDef[] = [
  { prop: 'headerColor',  colorLink: true,  reset: '""' },
  { prop: 'fontColor',    colorLink: true,  reset: '""' },
  { prop: 'transparency', colorLink: false, reset: '0' },
  { prop: 'shadow',       colorLink: false, reset: 'FALSE' },
  { prop: 'headerStyle',  colorLink: false, reset: '"None"' },
  { prop: 'borderStyle',  colorLink: false, reset: '"None"' },
];

/** Paintable style props in canonical order (the paintbrush copy-set + the Style-mode controls). */
export const PAINT_STYLE_PROPS: readonly string[] = STYLE_PROPS.map(s => s.prop);

/** The CorpoColor-link subset — set via `prop := t.<bid>`, cleared via the reset literal "". */
export const COLOR_LINK_PROPS: ReadonlySet<string> = new Set(STYLE_PROPS.filter(s => s.colorLink).map(s => s.prop));

/** prop → EC literal that resets it to "no styling". */
export const PAINT_PROP_RESET: Record<string, string> = Object.fromEntries(STYLE_PROPS.map(s => [s.prop, s.reset]));

/** The reset literal for a style prop ('""' for an unknown colour-ish prop is the safe default). */
export function styleResetLiteral(prop: string): string {
  return PAINT_PROP_RESET[prop] ?? '""';
}
