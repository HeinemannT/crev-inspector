import { describe, expect, it } from 'vitest'
import { reconcileLostSave } from '../save-reconcile'

describe('reconcileLostSave', () => {
  it('confirms the attempted value when the document has not moved', () => {
    expect(reconcileLostSave('saved', 'saved', 'saved')).toBe('confirmed')
  })

  it('preserves newer edits after confirming the attempted value', () => {
    expect(reconcileLostSave('saved', 'newer edit', 'saved')).toBe('confirmed-with-newer-edits')
  })

  it('distinguishes a different server value from an unavailable verification', () => {
    expect(reconcileLostSave('saved', 'saved', 'server rewrite')).toBe('mismatch')
    expect(reconcileLostSave('saved', 'saved', undefined)).toBe('unverified')
  })
})
