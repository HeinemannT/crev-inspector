/** Live, read-only contract for the flat workspace-colour query. */
import { expect, it } from 'vitest'
import { BmpClient } from '../../bmp-client'
import { mockChromeStorage } from '../chrome-mock'
import { integrationTarget } from './config'

it('loads complete real workspace colour sets through the production binary transport', async () => {
  const target = integrationTarget()
  mockChromeStorage()
  const client = new BmpClient(
    target.bmpUrl,
    target.bmpUser,
    target.bmpPass,
    'integration-colors',
    'stored',
  )

  const sets = await client.fetchColorSets()
  expect(sets.length).toBeGreaterThan(0)
  expect(sets.flatMap(set => set.colors).length).toBeGreaterThan(0)
  expect(sets.every(set => set.id && set.name && set.colors.every(color =>
    color.bid && color.name && /^rgb\(\d+,\d+,\d+\)$/.test(color.rgb),
  ))).toBe(true)
}, 30_000)
