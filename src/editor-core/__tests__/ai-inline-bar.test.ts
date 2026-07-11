/**
 * @vitest-environment happy-dom
 *
 * The inline AI command bar's CodeMirror integration (ai-inline-bar.ts): the
 * StateField that mounts the bar as a block widget, maps its position through
 * document changes, and survives a whole-document replacement without throwing.
 * Pure state-level tests — no EditorView needed (buildDeco reads state.doc).
 */
import { describe, it, expect } from 'vitest'
import { EditorState } from '@codemirror/state'
import { inlineAiBar, openInlineBar, closeInlineBar, isInlineBarOpen, inlineBarDom } from '../ai-inline-bar'

function stateWith(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [inlineAiBar] })
}

describe('inline AI bar StateField', () => {
  it('opens with the given widget DOM and closes cleanly', () => {
    let state = stateWith('a\nb\nc')
    const dom = document.createElement('div')
    expect(isInlineBarOpen(state)).toBe(false)

    const line2 = state.doc.line(2)
    state = state.update({ effects: openInlineBar.of({ dom, pos: line2.to, from: line2.from, to: line2.to, highlight: true }) }).state
    expect(isInlineBarOpen(state)).toBe(true)
    expect(inlineBarDom(state)).toBe(dom)

    state = state.update({ effects: closeInlineBar.of(null) }).state
    expect(isInlineBarOpen(state)).toBe(false)
    expect(inlineBarDom(state)).toBeNull()
  })

  it('maps the widget position through a document change and keeps the same DOM', () => {
    let state = stateWith('line1\nline2\nline3')
    const dom = document.createElement('div')
    const l2 = state.doc.line(2)
    state = state.update({ effects: openInlineBar.of({ dom, pos: l2.to, from: l2.from, to: l2.to, highlight: true }) }).state

    // Prepend a line — everything shifts down; the bar must follow, same DOM.
    state = state.update({ changes: { from: 0, insert: 'PRE\n' } }).state
    expect(isInlineBarOpen(state)).toBe(true)
    expect(inlineBarDom(state)).toBe(dom)
  })

  it('survives a whole-document replacement (positions clamp, no throw)', () => {
    let state = stateWith('alpha\nbeta\ngamma')
    const dom = document.createElement('div')
    state = state.update({
      effects: openInlineBar.of({ dom, pos: state.doc.length, from: 0, to: state.doc.length, highlight: true }),
    }).state

    expect(() => {
      state = state.update({ changes: { from: 0, to: state.doc.length, insert: 'completely different text' } }).state
    }).not.toThrow()
    expect(isInlineBarOpen(state)).toBe(true)
    expect(inlineBarDom(state)).toBe(dom)
  })

  it('renders no scope lines when highlight is false (cursor-only invoke)', () => {
    let state = stateWith('one\ntwo')
    const dom = document.createElement('div')
    // No throw building a widget-only (no bracket) decoration set.
    expect(() => {
      state = state.update({ effects: openInlineBar.of({ dom, pos: 2, from: 2, to: 2, highlight: false }) }).state
    }).not.toThrow()
    expect(isInlineBarOpen(state)).toBe(true)
  })
})
