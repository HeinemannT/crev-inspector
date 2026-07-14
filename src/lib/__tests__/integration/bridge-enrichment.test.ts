/** Live, read-only bridge integration. No fixed workspace RIDs and no silent skip. */
import { beforeAll, describe, expect, it } from 'vitest'
import { bridgePreview, buildDiscoveryEc, integrationTarget, parseDiscoveryRows, type DiscoveryRow, type IntegrationTarget } from './config'

describe('Bridge integration', () => {
  let target: IntegrationTarget
  let organisations: DiscoveryRow[]

  beforeAll(async () => {
    target = integrationTarget()
    organisations = parseDiscoveryRows(await bridgePreview(target, buildDiscoveryEc('Organisation')))
  })

  it('bridge health check', async () => {
    const res = await fetch(`${target.bridgeUrl}/health`)
    expect(res.ok).toBe(true)
    expect(await res.json()).toMatchObject({ ok: true })
  })

  it('discovers live workspace objects without baked-in RIDs', () => {
    expect(organisations.length).toBeGreaterThan(0)
    expect(organisations[0]).toMatchObject({ type: 'Organisation' })
    expect(organisations[0].rid).toMatch(/^\d+$/)
  })

  it('lookup resolves a dynamically discovered RID', async () => {
    const first = organisations[0]
    const log = await bridgePreview(target, `_o := lookup(${first.rid})\n_o.rid`)
    expect(log).toContain(first.rid)
  })

  it('batch lookup round-trips live RIDs', async () => {
    const sample = organisations.slice(0, 25)
    const code = [
      `_list := LIST(${sample.map(o => `lookup(${o.rid})`).join(', ')})`,
      '_r := ""',
      '_list.forEach(_o:',
      '  _r := _r + _o.rid.whenMissing("SKIP") + "|||" + _o.id.whenMissing("") + "|||" + _o.className.whenMissing("") + "|||" + _o.name.whenMissing("") + "\\n"',
      ')',
      '_r',
    ].join('\n')
    const rows = parseDiscoveryRows(await bridgePreview(target, code))
    expect(rows.length).toBe(sample.length)
    expect(rows.every(row => sample.some(source => source.rid === row.rid))).toBe(true)
  })

  it('nonexistent RIDs do not produce valid discovery rows', async () => {
    const fake = '8999999999999999999'
    const log = await bridgePreview(target, `_o := lookup(${fake})\n_o.rid.whenMissing("SKIP")`)
    expect(parseDiscoveryRows(log)).toEqual([])
  })
})
