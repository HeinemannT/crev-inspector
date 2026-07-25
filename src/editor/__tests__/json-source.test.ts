import { describe, expect, it } from 'vitest'
import {
  decodeEcStringLiteral,
  isCompleteExpression,
  jsonCallArgument,
  resolveJsonCall,
  resolveJsonChain,
} from '../ec/json-source'

describe('raw and property-backed JSON sources', () => {
  it('decodes single/double quoted raw JSON and EC newlines', () => {
    expect(decodeEcStringLiteral(`'{"name":"A"}'`)).toBe('{"name":"A"}')
    expect(decodeEcStringLiteral(`"{\\"name\\":\\"A\\"}"`)).toBe('{"name":"A"}')
    expect(decodeEcStringLiteral(`'{\\N  "name": "A"\\N}'`)).toBe('{\n  "name": "A"\n}')
    expect(decodeEcStringLiteral(`'{"text":"a\\\\nb"}'`)).toBe('{"text":"a\\nb"}')
  })

  it('extracts multiline JSON() arguments quote-aware', () => {
    const expression = `JSON(
      '{
        "note": ")",
        "rows": [{"id": 1}]
      }'
    )`
    expect(jsonCallArgument(expression)).toContain('"rows"')
    expect(isCompleteExpression(expression)).toBe(true)
  })

  it('locates inline raw JSON and raw aliases locally', () => {
    expect(resolveJsonCall(`JSON('{"x":1}')`, new Map())).toEqual({
      ok: true,
      locator: { root: { kind: 'literal', text: '{"x":1}' }, steps: [] },
    })
    const aliases = new Map([
      ['_raw', `'{"x":{"name":"A"}}'`],
      ['_copy', '_raw'],
    ])
    expect(resolveJsonCall('JSON(_copy)', aliases)).toMatchObject({
      ok: true,
      locator: { root: { kind: 'literal' } },
    })
  })

  it('normalizes safe property roots and rejects dynamic expressions', () => {
    expect(resolveJsonCall('JSON( this . object . description . strip ( ) )', new Map())).toEqual({
      ok: true,
      locator: { root: { kind: 'runtime', expression: 'this.object.description.strip()' }, steps: [] },
    })
    expect(resolveJsonCall('JSON(root.organisations.descendants().first().description)', new Map()))
      .toMatchObject({ ok: false })
    expect(resolveJsonCall(`JSON('{"' + _key + '":1}')`, new Map())).toMatchObject({ ok: false })
  })

  it('propagates nested properties and array element operations', () => {
    const root = { root: { kind: 'literal' as const, text: '{"rows":[]}' }, steps: [] }
    const resolve = (name: string) => name === '_cfg' ? root : undefined
    expect(resolveJsonChain('_cfg.rows.first().name', resolve)).toEqual({
      root: root.root,
      steps: [
        { kind: 'property', key: 'rows' },
        { kind: 'element' },
        { kind: 'property', key: 'name' },
      ],
    })
    expect(resolveJsonChain('_cfg.rows.filter(id = 1).name', resolve)?.steps).toEqual([
      { kind: 'property', key: 'rows' },
      { kind: 'property', key: 'name' },
    ])
    expect(resolveJsonChain('_cfg.rows.map(id)', resolve)).toBeNull()
    expect(resolveJsonCall('JSON(str(_cfg.rows))', new Map(), resolve)).toEqual({
      ok: true,
      locator: {
        root: root.root,
        steps: [{ kind: 'property', key: 'rows' }],
      },
    })
  })
})
