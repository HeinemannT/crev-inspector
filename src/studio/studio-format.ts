/**
 * CVO source formatting. Pretty-prints the html / javascript fields — reflowing
 * a minified or single-line source into clean, indented multi-line.
 *
 * js-beautify is a sizeable dependency, so it's loaded with a dynamic import:
 * it lands in its own chunk that's only fetched the first time the user hits
 * Format, never on studio startup.
 */
import type { StudioCodeProp } from './studio-types'

/** Two-space indent, matching the studio editor (web convention, not EC's 5). */
const INDENT = 2

export async function formatCode(prop: StudioCodeProp, code: string): Promise<string> {
  const mod = await import('js-beautify')
  const beautify = mod.default ?? mod
  if (prop === 'html') {
    // Indent structure, but keep each tag on one line — never hard-wrap or
    // split a tag's attributes onto their own lines (that produced jarring
    // `<div\n  style=…>` breaks). The Wrap toggle handles visual fit in the
    // narrow pane; Format only fixes indentation/structure.
    return beautify.html(code, {
      indent_size: INDENT,
      preserve_newlines: true,
      max_preserve_newlines: 2,
      wrap_line_length: 0,              // 0 = never hard-wrap a line
      wrap_attributes: 'preserve',      // keep attributes on the tag's line
      end_with_newline: false,
    })
  }
  return beautify.js(code, {
    indent_size: INDENT,
    preserve_newlines: true,
    max_preserve_newlines: 2,
    end_with_newline: false,
  })
}
