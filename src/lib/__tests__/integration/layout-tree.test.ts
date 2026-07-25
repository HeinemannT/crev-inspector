/** Live, read-only contract for Workshop's bounded portal layout tree. */
import { expect, it } from 'vitest'
import type { EcResult } from '../../bmp-client'
import { EcQueryService } from '../../ec-query-service'
import { bridgePreview, buildDiscoveryEc, integrationTarget, parseDiscoveryRows } from './config'

it('loads a discovered TabSet through the bounded structural projection', async () => {
  const target = integrationTarget()
  const tabsets = parseDiscoveryRows(await bridgePreview(target, buildDiscoveryEc('TabSet')))
  expect(tabsets.length).toBeGreaterThan(0)
  const service = new EcQueryService(
    async code => ({
      ok: true,
      log: await bridgePreview(target, code),
    }) as EcResult,
    async rid => `lookup(${rid})`,
    [],
  )

  const result = await service.fetchLayoutTree(tabsets[0].rid)
  expect(result.nodes.length).toBeGreaterThan(0)
  expect(result.nodes.every(node =>
    node.type === 'TabSet' || node.type === 'Tab' || node.type === 'Container',
  )).toBe(true)
}, 30_000)
