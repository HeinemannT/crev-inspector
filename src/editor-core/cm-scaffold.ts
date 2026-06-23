/**
 * editor-core / cm-scaffold — the language-agnostic CodeMirror foundation
 * shared by every code surface in the extension (the EC editor and the CVO
 * studio). It owns only what is genuinely common: the base editing extensions,
 * the generic key bindings, the syntax theme, and the grammar plug for the
 * non-EC code languages. App-specific layers (EC language + linter + vars,
 * CVO autocomplete, app keymaps, autocompletion sources) are concatenated on
 * top by each app — core never reaches back into an app.
 */
import { EditorState, type Extension } from '@codemirror/state'
import {
  EditorView, lineNumbers, highlightActiveLineGutter, highlightActiveLine, drawSelection,
} from '@codemirror/view'
import { defaultKeymap, indentWithTab, history, historyKeymap } from '@codemirror/commands'
import { bracketMatching, foldGutter, indentOnInput, foldKeymap, indentUnit } from '@codemirror/language'
import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { highlightSelectionMatches, searchKeymap, search } from '@codemirror/search'
import type { KeyBinding } from '@codemirror/view'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { css } from '@codemirror/lang-css'
import { catppuccinMocha } from './theme'

export { catppuccinMocha }

/** Indent width shared by EC + CVO code. BMP Config Studio defaults to 5-space
 *  indentation (the Architect workflow doc matches it), so copy-pasted code
 *  keeps its alignment when it lands in any of our surfaces. `indentUnit` is
 *  what indentOnInput / Tab insert; `tabSize` is how literal `\t` render —
 *  setting both keeps both forms 5-wide. */
export const INDENT_UNIT = '     '

/** Base editing extensions every code surface wants, in the order the EC editor
 *  has always used them. Grammar, autocomplete sources, linters and app keymaps
 *  are layered on top by the caller. Returns a fresh array per call so each
 *  EditorState owns its own extension instances. */
export function baseEditingExtensions(): Extension[] {
  return [
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    drawSelection(),
    bracketMatching(),
    closeBrackets(),
    indentOnInput(),
    indentUnit.of(INDENT_UNIT),
    EditorState.tabSize.of(5),
    history(),
    foldGutter(),
    highlightSelectionMatches(),
    // CodeMirror's own find/replace panel, docked at the top so it's
    // discoverable. Apps reuse this rather than building a custom find bar.
    search({ top: true }),
    // Replace the search panel's jargon toggle labels with compact glyphs.
    // These become the real label text (so they always paint) and the toggles
    // render as pills via the theme.
    EditorState.phrases.of({ 'match case': 'Aa', 'regexp': '.*', 'by word': 'W' }),
  ]
}

/** Generic key bindings every surface wants: bracket close, default editing,
 *  search (incl. Mod-d select-next-occurrence + Mod-f panel), history, fold,
 *  and indent-with-tab. App-specific keys (Preview / Save / Esc-close, language
 *  wraps) are concatenated by the caller before passing to `keymap.of`. */
export const baseKeymapBindings: readonly KeyBinding[] = [
  ...closeBracketsKeymap,
  ...defaultKeymap,
  ...searchKeymap,
  ...historyKeymap,
  ...foldKeymap,
  indentWithTab,
]

export type CodeLang = 'html' | 'javascript' | 'css'

/** Grammar extension for a non-EC code slot. `lang-html` bundles the embedded
 *  CSS + JS grammars, so `<style>` / `<script>` inside a CVO's html field
 *  highlight too. Token colours come from the base HighlightStyle baked into
 *  `catppuccinMocha`. */
export function languageExtension(lang: CodeLang): Extension {
  switch (lang) {
    case 'html': return html()
    case 'javascript': return javascript()
    case 'css': return css()
  }
}

// Re-exported so apps can build line-wrapping toggles without importing
// @codemirror/view directly alongside the scaffold.
export { EditorView }
