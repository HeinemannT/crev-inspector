/**
 * CodeMirror 6 HighlightStyle for Extended Code.
 *
 * Palette family: Catppuccin Mocha. Single source of truth lives in
 * `src/styles/tokens.css` under the `:root` block as `--ec-*` custom
 * properties — the CSS-based surfaces read them via `var()`. CodeMirror
 * can't `var()` inside its tag-based highlight definition, so the hex
 * values come from the shared `lib/ec-palette.ts` MOCHA constants
 * (one JS mirror for both CodeMirror themes; sync contract lives there).
 *
 * Design rules:
 *   - **bold**   for high-signal categories (`tx` writes,
 *                `agg` slow-engine calls, `className` types).
 *   - **italic** for out-of-band semantics (`null`, `comment`).
 *   - **underline** for the `.expression` eval-vs-text gotcha —
 *                   distinct from italic so the reader can tell
 *                   "absent value" from "be careful what this returns"
 *                   at a glance.
 *   - normal weight for everything else.
 *
 * The mono font is self-hosted JetBrains Mono (tokens.css), whose italic
 * is a clean slanted-roman — so the italic cues read as slanted text, not
 * the cursive script some system monospaces (e.g. Cascadia Code on
 * Windows) produce.
 */
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'
import { MOCHA } from '../../lib/ec-palette'

const extendedHighlightStyle = HighlightStyle.define([
  // Control flow keywords (IF / THEN / ELSE / ENDIF / AND / OR /
  // SELECT / WHERE / FROM …) — Catppuccin Mauve.
  { tag: tags.keyword, color: MOCHA.mauve },
  // Context keywords (root / this / self / parent) — Lavender, adjacent
  // to Mauve in hue so they read as kin to keywords without colliding.
  { tag: tags.special(tags.variableName), color: MOCHA.lavender },
  // Boolean literals (TRUE / FALSE) — Pink.
  { tag: tags.bool, color: MOCHA.pink },
  // Null-like values (MISSING / NULL / NA) — Surface2, italic.
  { tag: tags.null, color: MOCHA.surface2, fontStyle: 'italic' },

  // Strings — Green.
  { tag: tags.string, color: MOCHA.green },
  // Numbers — Peach. The duration suffix forms (1D / 2W / 3M / 1Y)
  // share this colour; the suffix character carries the rest of the
  // visual signal.
  { tag: tags.number, color: MOCHA.peach },
  // Comments — Overlay1, italic.
  { tag: tags.comment, color: MOCHA.overlay1, fontStyle: 'italic' },
  // Operators (:= / :+ / = / < / > / + / − …) — Overlay2.
  { tag: tags.operator, color: MOCHA.overlay2 },

  // Style constants (LEFT / RIGHT / BOLD / RED / AMBER …) — Yellow.
  { tag: tags.constant(tags.name), color: MOCHA.yellow },
  // Date / period anchor constants (TODAY / BOP / EOP / BOY …) — Sky.
  // Used to share the warm tan with style constants — split out here
  // so a temporal anchor reads as "cool" and a format flag as "warm".
  { tag: tags.atom, color: MOCHA.sky },

  // Global functions (LIST / MAP / JSON / output / when / date / str
  // / num …) — Teal.
  { tag: tags.function(tags.variableName), color: MOCHA.teal },
  // Aggregate / KPI engine functions (AGG / AGGAVG / PCmSUM / NOSO …)
  // — Maroon, bold. Bold signals "expensive — runs an engine query"
  // without veering all the way into red (the file-wide "no red for
  // non-errors" rule still applies; Maroon is a soft salmon pink).
  { tag: tags.macroName, color: '#eba0ac', fontWeight: 'bold' },

  // Transactional methods (.add / .delete / .change / .link / .copy)
  // — Peach, bold. Same hue as numbers; the bold weight + after-dot
  // position disambiguates. Bold here signals "this WRITES — be sure".
  { tag: tags.special(tags.name), color: MOCHA.peach, fontWeight: 'bold' },
  // Table-builder methods (.addColumn / .addRow / .style …) — Green.
  // Reuses the string hue; context (after `.`, in a chain) carries
  // the rest.
  { tag: tags.propertyName, color: MOCHA.green },
  // Read methods (.filter / .forEach / .children / .size …) — Blue.
  // Standard "function call" colour family.
  { tag: tags.function(tags.name), color: MOCHA.blue },

  // Class names after SELECT / .add(T) / .children(T) / .descendants(T)
  // / .ancestor(T) — Yellow, bold. Bold weight differentiates them
  // from style constants which share the hue.
  { tag: tags.className, color: MOCHA.yellow, fontWeight: 'bold' },
  // ID-space prefixes (`t.foo`, `o.100`, `d.bar`, `k.x`, `r.id`) —
  // Sapphire. Cool blue distinct from the function-call Blue.
  { tag: tags.namespace, color: MOCHA.sapphire },

  // Known properties (.name / .id / .rid / .className / .businessId
  // …) — Rosewater. Subtle warm; properties are calmer reads than
  // method calls.
  { tag: tags.attributeName, color: MOCHA.rosewater },
  // Bare `.expression` — the eval-vs-text gotcha. Flamingo with
  // underline so the reader gets a different cue from italic
  // `null` / `comment` (was confusable when both used italic in the
  // first palette pass).
  { tag: tags.special(tags.propertyName), color: MOCHA.flamingo, textDecoration: 'underline' },
])

/** Extension to apply to an EditorView for Extended Code highlighting (dark). */
export const extendedHighlighting = syntaxHighlighting(extendedHighlightStyle)
