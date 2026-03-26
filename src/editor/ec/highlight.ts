/**
 * CodeMirror 6 HighlightStyle for Extended Code.
 *
 * Design principles:
 * - No red for non-error tokens (red = error only)
 * - Each token category has a unique hue
 * - Higher contrast on Catppuccin Mocha base (#1e1e2e)
 * - Strings own amber exclusively; no other category shares it
 */
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags } from '@lezer/highlight'

const extendedHighlightStyle = HighlightStyle.define([
  // Control flow keywords (IF, THEN, ELSE, ENDIF, AND, OR, SELECT …) — blue
  { tag: tags.keyword, color: '#93c5fd' },
  // Transactional methods (.add, .delete, .change …) — amber/gold ("caution: writes")
  { tag: tags.special(tags.name), color: '#f59e0b', fontWeight: 'bold' },
  // Read methods (.forEach, .filter, .children …) — purple
  { tag: tags.function(tags.name), color: '#a78bfa' },
  // Table methods (.addColumn, .addRow, .table …) — green
  { tag: tags.propertyName, color: '#86efac' },
  // Style constants (LEFT, RIGHT, BOLD, RED …) — warm tan
  { tag: tags.constant(tags.name), color: '#d4a574' },
  // Boolean literals (TRUE, FALSE) — soft pink
  { tag: tags.bool, color: '#f9a8d4' },
  // Null-like values (MISSING, NULL, NA) — muted slate
  { tag: tags.null, color: '#94a3b8', fontStyle: 'italic' },
  // Strings — amber (exclusive owner of this hue)
  { tag: tags.string, color: '#fbbf24' },
  // Comments — muted, italic (tuned for Catppuccin Mocha #1e1e2e background)
  { tag: tags.comment, color: '#6c7086', fontStyle: 'italic' },
  // Numbers — soft lavender
  { tag: tags.number, color: '#c4b5fd' },
  // Operators (:=, =, <, >, + …) — muted slate
  { tag: tags.operator, color: '#94a3b8' },
  // Global functions (createTable, LIST, MAP, JSON …) — teal
  { tag: tags.function(tags.variableName), color: '#5eead4' },
  // Context keywords (root, this, self) — orange
  { tag: tags.special(tags.variableName), color: '#fb923c' },
])

/** Extension to apply to an EditorView for Extended Code highlighting (dark). */
export const extendedHighlighting = syntaxHighlighting(extendedHighlightStyle)


