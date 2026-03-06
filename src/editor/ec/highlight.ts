/**
 * CodeMirror 6 HighlightStyle for Extended Code.
 *
 * Design principles:
 * - No red for non-error tokens (red = error only)
 * - Each token category has a unique hue
 * - Higher contrast on dark #161616 background
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
  // Comments — dark grey, italic
  { tag: tags.comment, color: '#555', fontStyle: 'italic' },
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

/** Light theme highlight style — higher contrast colors for white backgrounds. */
const extendedHighlightStyleLight = HighlightStyle.define([
  { tag: tags.keyword, color: '#1d4ed8' },
  { tag: tags.special(tags.name), color: '#b45309', fontWeight: 'bold' },
  { tag: tags.function(tags.name), color: '#7c3aed' },
  { tag: tags.propertyName, color: '#15803d' },
  { tag: tags.constant(tags.name), color: '#92400e' },
  { tag: tags.bool, color: '#be185d' },
  { tag: tags.null, color: '#64748b', fontStyle: 'italic' },
  { tag: tags.string, color: '#a16207' },
  { tag: tags.comment, color: '#94a3b8', fontStyle: 'italic' },
  { tag: tags.number, color: '#6d28d9' },
  { tag: tags.operator, color: '#64748b' },
  { tag: tags.function(tags.variableName), color: '#0d9488' },
  { tag: tags.special(tags.variableName), color: '#c2410c' },
])

/** Extension for light theme. */
const extendedHighlightingLight = syntaxHighlighting(extendedHighlightStyleLight)
