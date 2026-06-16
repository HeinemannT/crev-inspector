/**
 * Catppuccin Mocha theme for CodeMirror 6.
 * Only sets editor chrome (background, gutter, cursor, selection, brackets).
 * Syntax highlighting is handled separately by highlight.ts.
 *
 * Palette reference: https://catppuccin.com/palette
 */
import { EditorView } from '@codemirror/view'
import { Extension } from '@codemirror/state'
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'

// ── Catppuccin Mocha palette ────────────────────────────────
const base     = '#1a1a1a'  // Aligned with extension surface-1 (not Mocha's purplish #1e1e2e)
const mantle   = '#151515'  // Slightly darker than base for gutter contrast
const surface0 = '#313244'
const surface1 = '#45475a'
const surface2 = '#585b70'
const overlay0 = '#6c7086'
const text     = '#cdd6f4'
const subtext0 = '#a6adc8'
const accent   = '#8b5cf6'  // CREV accent, not Catppuccin mauve

// ── Theme (editor chrome) ───────────────────────────────────
const theme = EditorView.theme({
  '&': {
    color: text,
    backgroundColor: base,
  },
  '.cm-content': {
    caretColor: accent,
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: accent,
  },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
    backgroundColor: `${surface2}80`,  // 50% opacity
  },
  '.cm-panels': {
    backgroundColor: mantle,
    color: text,
  },
  '.cm-panels.cm-panels-top': {
    borderBottom: `1px solid ${surface0}`,
  },
  '.cm-panels.cm-panels-bottom': {
    borderTop: `1px solid ${surface0}`,
  },
  '.cm-searchMatch': {
    backgroundColor: `${surface1}80`,
    outline: `1px solid ${surface2}`,
  },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: `${surface2}a0`,
  },
  // Search/replace panel controls — inherit the dark chrome instead of the
  // browser default white inputs + CM's light button gradient.
  '.cm-panel.cm-search input[type=text]': {
    backgroundColor: base,
    color: text,
    border: `1px solid ${surface1}`,
    borderRadius: '2px',
    padding: '2px 4px',
  },
  // The three option toggles show compact glyphs (Aa / .* / \b) instead of the
  // jargon "match case / regexp / by word". The glyph TEXT itself comes from CM
  // phrases (see editor.ts) so it's a real text node that always paints; here we
  // only turn each label into a pill that hides the native checkbox and
  // highlights when active.
  '.cm-panel.cm-search label': {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    minWidth: '24px',
    height: '20px',
    margin: '0 4px 0 0',
    padding: '0 6px',
    fontSize: '12px',
    fontFamily: 'monospace',
    fontWeight: '700',
    border: `1px solid ${surface1}`,
    borderRadius: '2px',
    color: text,
    cursor: 'pointer',
    userSelect: 'none',
    verticalAlign: 'middle',
  },
  '.cm-panel.cm-search label input': {  // hide the native checkbox — the pill is the control
    appearance: 'none',
    width: '0',
    height: '0',
    margin: '0',
    position: 'absolute',
  },
  '.cm-panel.cm-search label:hover': { borderColor: surface2 },
  '.cm-panel.cm-search label:has(input:checked)': {
    backgroundColor: `${accent}33`,
    borderColor: accent,
  },
  // next / previous / all / replace buttons (NOT the close ×).
  '.cm-panel.cm-search button:not([name=close]), .cm-button': {
    backgroundImage: 'none',
    backgroundColor: surface0,
    color: text,
    border: `1px solid ${surface1}`,
    borderRadius: '2px',
  },
  '.cm-panel.cm-search button:not([name=close]):hover, .cm-button:hover': {
    backgroundColor: surface1,
  },
  // Close ×: CM's base CSS pins it to top:0 (looks misaligned in the 2-row
  // panel). Centre it vertically and give it a real hit target + hover.
  '.cm-panel.cm-search [name=close]': {
    top: '0',
    bottom: '0',
    right: '6px',
    margin: 'auto 0',
    width: '22px',
    height: '22px',
    padding: '0',
    border: 'none',
    background: 'none',
    color: subtext0,
    fontSize: '18px',
    lineHeight: '1',
    borderRadius: '2px',
    cursor: 'pointer',
  },
  '.cm-panel.cm-search [name=close]:hover': {
    backgroundColor: surface1,
    color: text,
  },
  '.cm-activeLine': {
    backgroundColor: `${surface0}40`,  // 25% opacity
  },
  '.cm-selectionMatch': {
    backgroundColor: `${surface1}60`,
  },
  '&.cm-focused .cm-matchingBracket': {
    backgroundColor: `${surface1}a0`,
    outline: `1px solid ${accent}66`,
  },
  '.cm-gutters': {
    backgroundColor: mantle,
    color: overlay0,
    border: 'none',
  },
  '.cm-activeLineGutter': {
    backgroundColor: surface0,
    color: subtext0,
  },
  '.cm-foldPlaceholder': {
    backgroundColor: surface0,
    border: 'none',
    color: overlay0,
  },
  '.cm-tooltip': {
    border: `1px solid ${surface0}`,
    backgroundColor: mantle,
    color: text,
  },
  '.cm-tooltip .cm-tooltip-arrow:before': {
    borderTopColor: surface0,
    borderBottomColor: surface0,
  },
  '.cm-tooltip .cm-tooltip-arrow:after': {
    borderTopColor: mantle,
    borderBottomColor: mantle,
  },
  '.cm-tooltip-autocomplete': {
    '& > ul > li[aria-selected]': {
      backgroundColor: surface0,
      color: text,
    },
  },
}, { dark: true })

// ── Highlight style (base tokens for non-EC languages) ──────
const highlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: '#cba6f7' },       // mauve
  { tag: tags.operator, color: '#89dceb' },       // sky
  { tag: tags.number, color: '#fab387' },         // peach
  { tag: tags.string, color: '#a6e3a1' },         // green
  { tag: tags.comment, color: overlay0, fontStyle: 'italic' },
  { tag: tags.function(tags.variableName), color: '#89b4fa' }, // blue
  { tag: tags.variableName, color: text },
  { tag: tags.typeName, color: '#f9e2af' },       // yellow
  { tag: tags.bool, color: '#fab387' },           // peach
  { tag: tags.null, color: overlay0, fontStyle: 'italic' },
  { tag: tags.propertyName, color: '#89b4fa' },   // blue
  { tag: tags.definition(tags.variableName), color: '#f38ba8' }, // red (definitions)
])

/** Complete Catppuccin Mocha theme — chrome + base syntax highlighting.
 *  EC files use their own highlight.ts which overrides the base tokens. */
export const catppuccinMocha: Extension = [theme, syntaxHighlighting(highlightStyle)]
