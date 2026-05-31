/**
 * CodeMirror 6 HighlightStyle for Extended Code.
 *
 * Palette family: Catppuccin Mocha. Single source of truth lives in
 * `src/styles/tokens.css` under the `:root` block as `--ec-*` custom
 * properties — the CSS-based surfaces (sidepanel `.ec-preview`,
 * ObjectView `.ov-code-card-body`, Code Search `.cs-line-text`,
 * Reference View `.ref-match-text`) read them via `var()`. CodeMirror
 * can't `var()` directly inside its tag-based highlight definition, so
 * the hex values are mirrored here. Keep them in sync.
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

const extendedHighlightStyle = HighlightStyle.define([
  // Control flow keywords (IF / THEN / ELSE / ENDIF / AND / OR /
  // SELECT / WHERE / FROM …) — Catppuccin Mauve.
  { tag: tags.keyword, color: '#cba6f7' },
  // Context keywords (root / this / self / parent) — Lavender, adjacent
  // to Mauve in hue so they read as kin to keywords without colliding.
  { tag: tags.special(tags.variableName), color: '#b4befe' },
  // Boolean literals (TRUE / FALSE) — Pink.
  { tag: tags.bool, color: '#f5c2e7' },
  // Null-like values (MISSING / NULL / NA) — Surface2, italic.
  { tag: tags.null, color: '#585b70', fontStyle: 'italic' },

  // Strings — Green.
  { tag: tags.string, color: '#a6e3a1' },
  // Numbers — Peach. The duration suffix forms (1D / 2W / 3M / 1Y)
  // share this colour; the suffix character carries the rest of the
  // visual signal.
  { tag: tags.number, color: '#fab387' },
  // Comments — Overlay1, italic.
  { tag: tags.comment, color: '#7f849c', fontStyle: 'italic' },
  // Operators (:= / :+ / = / < / > / + / − …) — Overlay2.
  { tag: tags.operator, color: '#9399b2' },

  // Style constants (LEFT / RIGHT / BOLD / RED / AMBER …) — Yellow.
  { tag: tags.constant(tags.name), color: '#f9e2af' },
  // Date / period anchor constants (TODAY / BOP / EOP / BOY …) — Sky.
  // Used to share the warm tan with style constants — split out here
  // so a temporal anchor reads as "cool" and a format flag as "warm".
  { tag: tags.atom, color: '#89dceb' },

  // Global functions (LIST / MAP / JSON / output / when / date / str
  // / num …) — Teal.
  { tag: tags.function(tags.variableName), color: '#94e2d5' },
  // Aggregate / KPI engine functions (AGG / AGGAVG / PCmSUM / NOSO …)
  // — Maroon, bold. Bold signals "expensive — runs an engine query"
  // without veering all the way into red (the file-wide "no red for
  // non-errors" rule still applies; Maroon is a soft salmon pink).
  { tag: tags.macroName, color: '#eba0ac', fontWeight: 'bold' },

  // Transactional methods (.add / .delete / .change / .link / .copy)
  // — Peach, bold. Same hue as numbers; the bold weight + after-dot
  // position disambiguates. Bold here signals "this WRITES — be sure".
  { tag: tags.special(tags.name), color: '#fab387', fontWeight: 'bold' },
  // Table-builder methods (.addColumn / .addRow / .style …) — Green.
  // Reuses the string hue; context (after `.`, in a chain) carries
  // the rest.
  { tag: tags.propertyName, color: '#a6e3a1' },
  // Read methods (.filter / .forEach / .children / .size …) — Blue.
  // Standard "function call" colour family.
  { tag: tags.function(tags.name), color: '#89b4fa' },

  // Class names after SELECT / .add(T) / .children(T) / .descendants(T)
  // / .ancestor(T) — Yellow, bold. Bold weight differentiates them
  // from style constants which share the hue.
  { tag: tags.className, color: '#f9e2af', fontWeight: 'bold' },
  // ID-space prefixes (`t.foo`, `o.100`, `d.bar`, `k.x`, `r.id`) —
  // Sapphire. Cool blue distinct from the function-call Blue.
  { tag: tags.namespace, color: '#74c7ec' },

  // Known properties (.name / .id / .rid / .className / .businessId
  // …) — Rosewater. Subtle warm; properties are calmer reads than
  // method calls.
  { tag: tags.attributeName, color: '#f5e0dc' },
  // Bare `.expression` — the eval-vs-text gotcha. Flamingo with
  // underline so the reader gets a different cue from italic
  // `null` / `comment` (was confusable when both used italic in the
  // first palette pass).
  { tag: tags.special(tags.propertyName), color: '#f2cdcd', textDecoration: 'underline' },
])

/** Extension to apply to an EditorView for Extended Code highlighting (dark). */
export const extendedHighlighting = syntaxHighlighting(extendedHighlightStyle)
