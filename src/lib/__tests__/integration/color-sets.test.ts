/** Live, read-only contract for the flat workspace-colour query. */
import { expect, it } from 'vitest'
import type { EcResult } from '../../bmp-client'
import { EcQueryService } from '../../ec-query-service'
import { bridgePreview, integrationTarget } from './config'

it('loads real workspace colour sets through the flat projection', async () => {
  const target = integrationTarget()
  const service = new EcQueryService(
    async code => ({
      ok: true,
      log: await bridgePreview(target, code),
    }) as EcResult,
    async rid => `lookup(${rid})`,
    [],
  )

  const sets = await service.fetchColorSets()
  expect(sets.length).toBeGreaterThan(0)
  expect(sets.flatMap(set => set.colors).length).toBeGreaterThan(0)
  expect(sets.every(set => set.id && set.name && set.colors.every(color =>
    color.bid && color.name && /^rgb\(\d+,\d+,\d+\)$/.test(color.rgb),
  ))).toBe(true)
}, 30_000)
