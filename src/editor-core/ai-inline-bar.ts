/**
 * Inline AI command bar — a CodeMirror block-widget shell for the verb-at-send
 * AI invoke UI (see ai-assist.ts for the interaction). The bar DOM is built by
 * ai-assist (it owns the input + verb buttons + wiring); this module only
 * handles CodeMirror integration:
 *
 *   - a StateField holding the open bar (its DOM, the block-widget position, and
 *     the scope line-range) and the DecorationSet it renders;
 *   - a block widget (Decoration.widget, block: true, side below the target
 *     line) that injects the bar into the editor directly under the selection —
 *     the code shifts down, nothing is occluded;
 *   - a per-line decoration (`cm-ai-scope`) over the target lines that draws the
 *     persistent highlight + the 2px purple gutter bracket. It stands in for the
 *     native selection while CodeMirror is blurred (focus lives in the bar's
 *     input) and doubles as the scope indicator.
 *
 * Positions map through document changes like any StateField range, so the bar
 * survives edits, the merge-view overlay reconfiguration, and even a whole-doc
 * replacement (positions clamp rather than throw). The widget INSTANCE is kept
 * stable across maps, so CodeMirror never recreates the DOM — the input keeps
 * focus while the user types.
 *
 * This extension is installed by CodeSurface (once, in its base config), so both
 * the EC editor and the CVO studio get the inline bar for free. ai-assist drives
 * it by dispatching `openInlineBar` / `closeInlineBar` against `surface.view`.
 */
import { Decoration, WidgetType, EditorView } from '@codemirror/view'
import type { DecorationSet } from '@codemirror/view'
import { StateField, StateEffect } from '@codemirror/state'
import type { EditorState, Extension } from '@codemirror/state'

/** Payload for opening the bar. `pos` is any position on the line the bar
 *  should sit below (the last selected line, or the cursor line). `from`/`to`
 *  bound the scope highlight; `highlight` is false when there's no selection
 *  (scope is the whole script, communicated by the placeholder instead). */
export interface OpenInlineBar {
  dom: HTMLElement
  pos: number
  from: number
  to: number
  highlight: boolean
}

export const openInlineBar = StateEffect.define<OpenInlineBar>()
export const closeInlineBar = StateEffect.define<null>()

/** Block widget wrapping the (externally built) bar DOM. `eq` is identity by a
 *  monotonic id so a mapped field value reuses the SAME widget → CodeMirror
 *  keeps the DOM (and the input's focus) instead of recreating it. */
class InlineBarWidget extends WidgetType {
  constructor(readonly id: number, readonly dom: HTMLElement) { super() }
  eq(other: InlineBarWidget): boolean { return other.id === this.id }
  toDOM(): HTMLElement { return this.dom }
  updateDOM(): boolean { return true }
  ignoreEvent(): boolean { return true }
  get estimatedHeight(): number { return 34 }
  coordsAt(): null { return null }
}

const scopeLine = Decoration.line({ class: 'cm-ai-scope' })

interface BarState {
  id: number
  widget: InlineBarWidget
  pos: number
  from: number
  to: number
  highlight: boolean
  deco: DecorationSet
}

let nextId = 1

/** Build the decoration set for the current bar geometry: the block widget
 *  below `pos`'s line, plus one line decoration per scoped line. Positions are
 *  clamped to the live document so a collapsed/whole-doc-replaced range renders
 *  something valid rather than throwing. */
function buildDeco(state: EditorState, s: Pick<BarState, 'widget' | 'pos' | 'from' | 'to' | 'highlight'>): DecorationSet {
  const docLen = state.doc.length
  const ranges = []
  if (s.highlight) {
    const startNo = state.doc.lineAt(Math.max(0, Math.min(s.from, docLen))).number
    const endNo = state.doc.lineAt(Math.max(0, Math.min(s.to, docLen))).number
    for (let n = startNo; n <= endNo; n++) {
      ranges.push(scopeLine.range(state.doc.line(n).from))
    }
  }
  const boundary = state.doc.lineAt(Math.max(0, Math.min(s.pos, docLen))).to
  ranges.push(Decoration.widget({ widget: s.widget, block: true, side: 1 }).range(boundary))
  return Decoration.set(ranges, true)
}

const inlineBarField = StateField.define<BarState | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(openInlineBar)) {
        const widget = new InlineBarWidget(nextId++, e.value.dom)
        const meta = { id: widget.id, widget, pos: e.value.pos, from: e.value.from, to: e.value.to, highlight: e.value.highlight }
        return { ...meta, deco: buildDeco(tr.state, meta) }
      }
      if (e.is(closeInlineBar)) return null
    }
    if (!value) return null
    if (tr.docChanged) {
      const pos = tr.changes.mapPos(value.pos, 1)
      const from = tr.changes.mapPos(value.from, -1)
      const to = tr.changes.mapPos(value.to, 1)
      const meta = { id: value.id, widget: value.widget, pos, from, to, highlight: value.highlight }
      return { ...meta, deco: buildDeco(tr.state, meta) }
    }
    return value
  },
  provide: (f) => EditorView.decorations.from(f, (v) => (v ? v.deco : Decoration.none)),
})

/** The extension CodeSurface installs. */
export const inlineAiBar: Extension = [inlineBarField]

/** True while an inline bar is mounted in this state. */
export function isInlineBarOpen(state: EditorState): boolean {
  return state.field(inlineBarField, false) != null
}

/** The mounted bar's DOM (for focus/dismiss handling in ai-assist), or null. */
export function inlineBarDom(state: EditorState): HTMLElement | null {
  return state.field(inlineBarField, false)?.widget.dom ?? null
}
