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
  const surface = new CodeSurface(parent, { buildExtensions: () => [], onDirtyChange })
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

  it('getRunCode returns the whole doc with no selection', () => {
    const { surface } = mount()
    surface.activate('javascript')
    expect(surface.getRunCode()).toBe('var x=1')
  })
})
