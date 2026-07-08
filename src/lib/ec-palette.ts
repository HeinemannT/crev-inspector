/**
 * The Catppuccin Mocha palette used by the two CodeMirror themes.
 *
 * WHY THIS FILE EXISTS: the CSS surfaces read these colors as `--ec-*`
 * custom properties from src/styles/tokens.css (the canonical, themed
 * definition — it also carries the Latte light remap). CodeMirror's
 * HighlightStyle API takes literal color strings and cannot resolve
 * `var()`, so the JS side needs real hex values. Before this module,
 * `editor/ec/highlight.ts` and `editor-core/theme.ts` each mirrored the
 * palette independently — two drift-prone copies. Now they share ONE.
 *
 * Sync contract: these values mirror the `:root` `--ec-*` block in
 * tokens.css (dark/Mocha). If you change a color, change it in BOTH
 * files — the comment names below match the token names.
 */
export const MOCHA = {
  base:      '#1e1e2e', // --ec-bg
  mauve:     '#cba6f7', // --ec-kw       keywords
  lavender:  '#b4befe', // --ec-ctx      root/this/self/parent
  pink:      '#f5c2e7', // --ec-bool
  surface2:  '#585b70', // --ec-null
  green:     '#a6e3a1', // --ec-str / --ec-tbl
  peach:     '#fab387', // --ec-num / --ec-tx
  overlay1:  '#7f849c', // --ec-cmt
  overlay2:  '#9399b2', // --ec-op
  yellow:    '#f9e2af', // --ec-style / --ec-class
  sky:       '#89dceb', // --ec-date
  teal:      '#94e2d5', // --ec-global
  aggOrange: '#ff9e64', // --ec-agg (not a Catppuccin color — deliberate)
  blue:      '#89b4fa', // --ec-read
  sapphire:  '#74c7ec', // --ec-idspace
  rosewater: '#f5e0dc', // --ec-prop
  flamingo:  '#f2cdcd', // --ec-expr
  red:       '#f38ba8', // definitions (theme.ts)
  text:      '#cdd6f4',
  subtext0:  '#a6adc8',
} as const;
