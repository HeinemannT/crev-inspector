/**
 * @vitest-environment happy-dom
 *
 * CodeSurface — the multi-slot editing engine shared by the EC editor and the
 * CVO studio. Locks the cross-slot behaviour both depend on: per-slot dirty,
 * stash-on-switch so an inactive slot's edits survive, restore-on-return,
 * save (loaded baseline moves) and discard (revert to loaded).
 */
import { describe, it, expect, vi } from 'vitest'
import { CodeSurface } from '../code-surface'

function mount() {
  const parent = document.createElement('div')
  document.body.appendChild(parent)
  const onDirtyChange = vi.fn()
  const surface = new CodeSurface(() => parent, { buildExtensions: () => [], onDirtyChange })
  surface.setSlots([
    { key: 'html', lang: 'html', code: '<p>a</p>' },
    { key: 'javascript', lang: 'javascript', code: 'var x=1' },
  ])
  return { surface, onDirtyChange }
}

describe('CodeSurface', () => {
  it('activates a slot and shows its code, clean', () => {
    const { surface } = mount()
    surface.activate('html')
    expect(surface.getDoc()).toBe('<p>a</p>')
    expect(surface.isDirty()).toBe(false)
    expect(surface.current).toBe('html')
  })

  it('marks the active slot dirty on edit and notifies', () => {
    const { surface, onDirtyChange } = mount()
    surface.activate('html')
    surface.insertAtCursor('X')
    expect(surface.getDoc()).toBe('X<p>a</p>')
    expect(surface.isDirty('html')).toBe(true)
    expect(surface.isDirty()).toBe(true)
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)
  })

  it('stashes an inactive slot edit and restores it on return', () => {
    const { surface } = mount()
    surface.activate('html')
    surface.insertAtCursor('X')
    surface.activate('javascript')
    expect(surface.getDoc()).toBe('var x=1')
    // The html edit is preserved for the inactive slot...
    expect(surface.textFor('html')).toBe('X<p>a</p>')
    expect(surface.isDirty('javascript')).toBe(false)
    // ...and restored (text + dirty) when we come back.
    surface.activate('html')
    expect(surface.getDoc()).toBe('X<p>a</p>')
    expect(surface.isDirty('html')).toBe(true)
  })

  it('markSaved moves the baseline so the slot reads clean', () => {
    const { surface } = mount()
    surface.activate('html')
    surface.insertAtCursor('X')
    surface.markSaved()
    expect(surface.isDirty('html')).toBe(false)
    expect(surface.textFor('html')).toBe('X<p>a</p>')
  })

  it('discard reverts to the saved baseline, not the original load', () => {
    const { surface } = mount()
    surface.activate('html')
    surface.insertAtCursor('X')
    surface.markSaved()          // baseline is now 'X<p>a</p>'
    surface.insertAtCursor('Y')  // 'YX<p>a</p>'
    expect(surface.isDirty('html')).toBe(true)
    surface.discard()
    expect(surface.getDoc()).toBe('X<p>a</p>')
    expect(surface.isDirty('html')).toBe(false)
  })

  it('records a completed save without clearing edits typed while it was in flight', () => {
    const { surface } = mount()
    surface.activate('html')
    surface.insertAtCursor('saved-')
    const sent = surface.getDoc()
    surface.insertAtCursor('newer-')

    surface.markValueSaved('html', sent)

    expect(surface.getDoc()).toBe('newer-saved-<p>a</p>')
    expect(surface.isDirty('html')).toBe(true)
    surface.discard()
    expect(surface.getDoc()).toBe('saved-<p>a</p>')
  })

  it('getRunCode returns the whole doc with no selection', () => {
    const { surface } = mount()
    surface.activate('javascript')
    expect(surface.getRunCode()).toBe('var x=1')
  })

  it('setSlots re-seed clears dirty on an already-dirty active slot', () => {
    const { surface, onDirtyChange } = mount()
    surface.activate('html')
    surface.insertAtCursor('X')
    expect(surface.isDirty('html')).toBe(true)
    // A fresh load from BMP for the same key resets the baseline + clears dirty.
    surface.setSlots([{ key: 'html', lang: 'html', code: '<p>fresh</p>' }])
    expect(surface.isDirty('html')).toBe(false)
    expect(surface.textFor('html')).toBe('<p>fresh</p>')
    onDirtyChange.mockClear()
  })

  it('reloadSlots moves the baseline, clears dirty, and replaces the active doc', () => {
    const { surface, onDirtyChange } = mount()
    surface.activate('html')
    surface.insertAtCursor('X')
    expect(surface.isDirty('html')).toBe(true)
    surface.reloadSlots([{ key: 'html', lang: 'html', code: '<p>server</p>' }])
    expect(surface.isDirty('html')).toBe(false)
    expect(surface.getDoc()).toBe('<p>server</p>')        // live view replaced
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
  })

  it('markSaved on a NON-active slot pins its last-stashed text as the baseline', () => {
    const { surface } = mount()
    surface.activate('html')
    surface.insertAtCursor('X')        // html now 'X<p>a</p>', dirty
    surface.activate('javascript')     // stashes html
    surface.markSaved('html')          // non-active: baseline := stashed text
    expect(surface.isDirty('html')).toBe(false)
    surface.activate('html')
    expect(surface.getDoc()).toBe('X<p>a</p>')
    expect(surface.isDirty('html')).toBe(false)
  })

  it('jumpTo lands on the occurrence nearest the hinted line, not the first', async () => {
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const surface = new CodeSurface(() => parent, { buildExtensions: () => [] })
    // 'x' appears on lines 1 and 5; hint near line 5 should pick line 5.
    surface.setSlots([{ key: 'doc', lang: 'javascript', code: 'x\n\n\n\nx' }])
    surface.activate('doc', { scrollToLine: 5, scrollToText: 'x' })
    await new Promise<void>(r => requestAnimationFrame(() => r()))
    const head = surface.view!.state.selection.main.head
    const line = surface.view!.state.doc.lineAt(head).number
    expect(line).toBe(5)
  })
})

describe('isProgrammaticSwap', () => {
  it('a slot switch does not mark the destination dirty', () => {
    const parent = document.createElement('div')
    document.body.appendChild(parent)
    const onDirtyChange = vi.fn()
    const surface = new CodeSurface(() => parent, { buildExtensions: () => [], onDirtyChange })
    surface.setSlots([
      { key: 'a', lang: 'x', code: 'aaa' },
      { key: 'b', lang: 'x', code: 'bbb' },  // same lang family → swapDoc, not rebuild
    ])
    surface.activate('a')
    onDirtyChange.mockClear()
    surface.activate('b')  // programmatic swap of the doc
    expect(surface.isDirty('b')).toBe(false)
    expect(onDirtyChange).not.toHaveBeenCalled()
  })
})
