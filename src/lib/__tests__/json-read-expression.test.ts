import { describe, expect, it } from 'vitest'
import { parseSafeJsonReadExpression } from '../json-read-expression'

describe('safe JSON property reads', () => {
  it.each([
    ['this.object.description', 'this.object.description'],
    [' self . payload . strip ( ) ', 'self.payload.strip()'],
    ['t.ermq_profile.ermq_data', 't.ermq_profile.ermq_data'],
    ['ceras.123_data.config.whenMissing("{}")', 'ceras.123_data.config.whenMissing("{}")'],
    ["r.file_1.text.strip().whenMissing('[]')", "r.file_1.text.strip().whenMissing('[]')"],
  ])('accepts and normalizes %s', (source, normalized) => {
    expect(parseSafeJsonReadExpression(source)).toEqual({ normalized })
  })

  it.each([
    'root.organisations.descendants().first().description',
    'this.object.change(name := "x")',
    't.only_object',
    'o.123.description',
    '_alias.description',
    'this.object.description + "x"',
    'this.object.children()',
    'this.object.description.substring(1)',
    'this.object.description; t.bad.delete()',
    'this.object.description /* comment */',
  ])('rejects %s', source => {
    expect(parseSafeJsonReadExpression(source)).toBeNull()
  })
})
