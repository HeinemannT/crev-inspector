import { describe, it, expect } from 'vitest'
import { cvoApiCandidates, DATA_MEMBERS, CONTEXT_FIELDS } from '../cvo-api'

const keys = { expressions: ['model', 'config'], tables: ['risks'] }

describe('cvoApiCandidates', () => {
  it('offers _data members after _data.', () => {
    expect(cvoApiCandidates('var x = _data.', keys)).toEqual({ word: '', options: DATA_MEMBERS })
  })

  it('prefix word is captured for filtering', () => {
    expect(cvoApiCandidates('_data.exp', keys)).toEqual({ word: 'exp', options: DATA_MEMBERS })
  })

  it('offers context fields after _data.context.', () => {
    expect(cvoApiCandidates('_data.context.', keys)).toEqual({ word: '', options: CONTEXT_FIELDS })
  })

  it('offers the CVO expression keys after _data.expressions.', () => {
    expect(cvoApiCandidates('_data.expressions.', keys)).toEqual({ word: '', options: ['model', 'config'] })
  })

  it('offers the table keys after _data.tables.', () => {
    expect(cvoApiCandidates('_data.tables.', keys)).toEqual({ word: '', options: ['risks'] })
  })

  it('most specific match wins (context over data)', () => {
    expect(cvoApiCandidates('_data.context.or', keys)?.options).toEqual(CONTEXT_FIELDS)
  })

  it('returns null outside a _data member position', () => {
    expect(cvoApiCandidates('var foo = bar.', keys)).toBeNull()
    expect(cvoApiCandidates('_data', keys)).toBeNull()
  })
})
