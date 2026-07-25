/** Live, read-only contracts for Code Search's bounded scan and code fetch. */
import { expect, it } from 'vitest'
import type { EcResult } from '../../bmp-client'
import { buildRidScanEc, parseRidScanLog } from '../../code-search'
import { EcQueryService } from '../../ec-query-service'
import { bridgePreview, integrationTarget } from './config'

it('returns a completion-marked inventory for a real code-bearing type', async () => {
  const target = integrationTarget()
  const log = await bridgePreview(target, buildRidScanEc('ExtendedExpression', null))
  const scan = parseRidScanLog(log)

  expect(scan.total).toBeGreaterThan(0)
  expect(scan.rids.length).toBeGreaterThan(0)
  expect(scan.rids.length).toBeLessThanOrEqual(scan.total)
  expect(new Set(scan.rids).size).toBe(scan.rids.length)
}, 30_000)

it('fetches complete code batches for discovered ExtendedExpressions', async () => {
  const target = integrationTarget()
  const scan = parseRidScanLog(
    await bridgePreview(target, buildRidScanEc('ExtendedExpression', null)),
  )
  const rids = scan.rids.slice(0, 5)
  expect(rids.length).toBeGreaterThan(0)

  const service = new EcQueryService(
    async code => ({
      ok: true,
      log: await bridgePreview(target, code),
      hasError: false,
      hasWarning: false,
    }) as EcResult,
    async rid => `lookup(${rid})`,
    [],
  )
  const code = await service.batchFetchCode(rids, ['expression'])
  expect(code.size).toBe(rids.length)
  expect([...code.keys()]).toEqual(rids)
}, 30_000)
