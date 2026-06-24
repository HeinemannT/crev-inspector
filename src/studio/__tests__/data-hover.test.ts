import { describe, it, expect } from 'vitest'
import { resolvePath, formatValue } from '../data-hover'

const data = {
  expressions: { alpha: '42', beta: '' },
  context: { period: 'M', yearToDate: false },
  tables: { rows: [{ a: 1 }] },
}

describe('resolvePath', () => {
  it('walks a dotted path into the data', () => {
    expect(resolvePath(data, ['expressions', 'alpha'])).toBe('42')
    expect(resolvePath(data, ['context', 'period'])).toBe('M')
    expect(resolvePath(data, ['tables', 'rows'])).toEqual([{ a: 1 }])
  })
  it('returns the whole object for an empty path', () => {
    expect(resolvePath(data, [])).toBe(data)
  })
  it('returns undefined for a missing key or a non-object midway', () => {
    expect(resolvePath(data, ['expressions', 'nope'])).toBeUndefined()
    expect(resolvePath(data, ['expressions', 'alpha', 'x'])).toBeUndefined() // alpha is a string
    expect(resolvePath(data, ['nope', 'deep'])).toBeUndefined()
  })
})

describe('formatValue', () => {
  it('labels absent vs empty vs null distinctly', () => {
    expect(formatValue(undefined)).toBe('(not present in _data)')
    expect(formatValue('')).toBe('(empty string)')
    expect(formatValue(null)).toBe('null')
  })
  it('shows strings as-is and pretty-prints objects', () => {
    expect(formatValue('42')).toBe('42')
    expect(formatValue({ a: 1 })).toBe('{\n  "a": 1\n}')
  })
  it('truncates very long values', () => {
    expect(formatValue('x'.repeat(5000))).toContain('… (truncated)')
    expect(formatValue({ big: 'y'.repeat(5000) })).toContain('… (truncated)')
  })
})
