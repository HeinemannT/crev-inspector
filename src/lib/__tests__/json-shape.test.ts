import { describe, expect, it } from 'vitest'
import {
  inferJsonShape,
  JSON_SHAPE_MAX_BYTES,
  JsonShapeError,
  resolveJsonShapePath,
} from '../json-shape'

describe('bounded JSON shape inference', () => {
  it('infers nested objects without retaining values', () => {
    const shape = inferJsonShape('{"secret":"do-not-keep","user":{"age":42,"active":true}}')
    expect(shape).toEqual({
      kind: 'object',
      truncated: false,
      fields: [
        { key: 'secret', optional: false, shape: { kind: 'string' } },
        {
          key: 'user',
          optional: false,
          shape: {
            kind: 'object',
            truncated: false,
            fields: [
              { key: 'age', optional: false, shape: { kind: 'number' } },
              { key: 'active', optional: false, shape: { kind: 'boolean' } },
            ],
          },
        },
      ],
    })
    expect(JSON.stringify(shape)).not.toContain('do-not-keep')
  })

  it('merges object-array fields and marks missing fields optional', () => {
    const shape = inferJsonShape('[{"id":1,"name":"A"},{"id":2,"enabled":true}]')
    expect(shape).toMatchObject({
      kind: 'array',
      sampled: 2,
      element: {
        kind: 'object',
        fields: [
          { key: 'id', optional: false, shape: { kind: 'number' } },
          { key: 'name', optional: true, shape: { kind: 'string' } },
          { key: 'enabled', optional: true, shape: { kind: 'boolean' } },
        ],
      },
    })
  })

  it('handles empty and mixed arrays', () => {
    expect(inferJsonShape('[]')).toMatchObject({ kind: 'array', element: { kind: 'unknown' } })
    expect(inferJsonShape('[1,"two"]')).toMatchObject({ kind: 'array', element: { kind: 'mixed' } })
  })

  it('resolves nested shape paths', () => {
    const shape = inferJsonShape('{"rows":[{"name":"A"}]}')
    expect(resolveJsonShapePath(shape, [
      { kind: 'property', key: 'rows' },
      { kind: 'element' },
      { kind: 'property', key: 'name' },
    ])).toEqual({ kind: 'string' })
  })

  it('rejects invalid, primitive, and oversized input', () => {
    expect(() => inferJsonShape('{')).toThrowError(JsonShapeError)
    expect(() => inferJsonShape('"value"')).toThrowError(/object or array/)
    expect(() => inferJsonShape(`{"x":"${'a'.repeat(JSON_SHAPE_MAX_BYTES)}"}`)).toThrowError(/too large/)
  })

  it('treats prototype-looking keys as ordinary data', () => {
    const shape = inferJsonShape('{"__proto__":{"x":1},"constructor":"safe"}')
    expect(shape.kind).toBe('object')
    if (shape.kind === 'object') expect(shape.fields.map(field => field.key)).toEqual(['__proto__', 'constructor'])
  })
})
