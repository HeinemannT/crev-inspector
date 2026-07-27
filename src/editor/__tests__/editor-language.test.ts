import { describe, expect, it } from 'vitest'
import { hasCodeProperty, languageForProperty } from '../editor-types'

describe('languageForProperty', () => {
  it('treats defaultExpression as Extended Code', () => {
    expect(languageForProperty('defaultExpression', false)).toBe('ec')
    expect(languageForProperty('initExpression', false)).toBe('ec')
    expect(languageForProperty('afterExpression', false)).toBe('ec')
  })

  it('keeps HTML bodies and unknown properties in their existing modes', () => {
    expect(languageForProperty('text', false)).toBe('html')
    expect(languageForProperty('html', false)).toBe('html')
    expect(languageForProperty('name', false)).toBe('plain')
  })

  it('recognizes an empty requested code property by presence', () => {
    expect(hasCodeProperty({ defaultExpression: '' }, 'defaultExpression')).toBe(true)
    expect(hasCodeProperty({ expression: 'x' }, 'defaultExpression')).toBe(false)
  })
})
