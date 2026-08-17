/**
 * Save -> reload reconciliation. This is the studio's data-integrity hinge:
 * after a save it decides which editor slots to re-seed from the server and
 * which saved fields silently rolled back. The recurring Companion footgun is
 * re-seeding a slot the user edited mid-save (lost work), so that case is
 * covered explicitly.
 */
import { describe, it, expect } from 'vitest'
import { reconcileSavedSlots } from '../studio-save'
import type { StudioCodeProp } from '../studio-types'

const saved = (entries: Array<[StudioCodeProp, string]>) => new Map(entries)
const noneDirty = () => false

describe('reconcileSavedSlots', () => {
  it('reloads every saved slot from the server when nothing is dirty', () => {
    const r = reconcileSavedSlots(
      saved([['html', '<div>a</div>'], ['javascript', 'x()']]),
      { html: '<div>a</div>', javascript: 'x()' },
      noneDirty,
    )
    expect(r.rollbacks).toEqual([])
    expect(r.reload).toEqual([
      { key: 'html', code: '<div>a</div>' },
      { key: 'javascript', code: 'x()' },
    ])
  })

  it('flags a rollback when the server value differs from what was saved', () => {
    const r = reconcileSavedSlots(
      saved([['html', '<div>new</div>']]),
      { html: '<div>OLD</div>' }, // BMP kept the old value (silent rollback)
      noneDirty,
    )
    expect(r.rollbacks).toEqual(['html'])
    // still re-seeds the slot to the server-canonical text
    expect(r.reload).toEqual([{ key: 'html', code: '<div>OLD</div>' }])
  })

  it('does NOT re-seed a slot the user re-edited during the save (no lost work)', () => {
    const r = reconcileSavedSlots(
      saved([['html', '<div>a</div>'], ['javascript', 'x()']]),
      { html: '<div>a</div>', javascript: 'x()' },
      key => key === 'javascript', // user kept typing in javascript while html saved
    )
    expect(r.reload).toEqual([{ key: 'html', code: '<div>a</div>' }])
    expect(r.reload.find(s => s.key === 'javascript')).toBeUndefined()
  })

  it('treats a missing server field as empty string for both compare and reload', () => {
    const r = reconcileSavedSlots(
      saved([['javascript', 'x()']]),
      {}, // server returned no javascript
      noneDirty,
    )
    expect(r.rollbacks).toEqual(['javascript']) // 'x()' !== ''
    expect(r.reload).toEqual([{ key: 'javascript', code: '' }])
  })

  it('a saved-and-still-dirty rollback is reported but not re-seeded', () => {
    const r = reconcileSavedSlots(
      saved([['html', '<div>mine</div>']]),
      { html: '<div>server</div>' },
      () => true, // user re-edited it during the round-trip
    )
    expect(r.rollbacks).toEqual(['html']) // still warned
    expect(r.reload).toEqual([])          // but their in-progress edit is preserved
  })

  it('returns empty results for an empty save set', () => {
    expect(reconcileSavedSlots(saved([]), { html: 'x' }, noneDirty)).toEqual({ reload: [], rollbacks: [] })
  })
})
