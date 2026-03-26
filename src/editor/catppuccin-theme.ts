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
const accent   = '#ba0ffe'  // CREV accent, not Catppuccin mauve

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
