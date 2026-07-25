/** Live, read-only contract for EditPage / CreateObjectView inspection. */
import { expect, it } from 'vitest'
import type { EcResult } from '../../bmp-client'
import { EcQueryService } from '../../ec-query-service'
import { bridgePreview, buildDiscoveryEc, integrationTarget, parseDiscoveryRows } from './config'

function liveService(): { target: ReturnType<typeof integrationTarget>; service: EcQueryService } {
  const target = integrationTarget()
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
  return { target, service }
}

it('loads every discovered EditPage and preserves its ordered direct form elements', async () => {
  const { target, service } = liveService()
  const pages = parseDiscoveryRows(await bridgePreview(target, buildDiscoveryEc('EditPage')))
  expect(pages.length).toBeGreaterThan(0)

  let largest = 0
  for (const page of pages) {
    const chain = await service.fetchFlowChain(page.rid, 'EditPage')
    expect(chain?.steps[0].identity.rid).toBe(page.rid)
    const children = chain?.steps[0].children ?? []
    largest = Math.max(largest, children.length)
    expect(children.every(child => child.identity.rid && child.identity.type)).toBe(true)
  }
  expect(largest).toBeGreaterThan(0)
}, 30_000)

it('follows a discovered CreateObjectView through its linked EditPage', async () => {
  const { target, service } = liveService()
  const views = parseDiscoveryRows(await bridgePreview(target, buildDiscoveryEc('CreateObjectView')))
  expect(views.length).toBeGreaterThan(0)

  for (const view of views) {
    const chain = await service.fetchFlowChain(view.rid, 'CreateObjectView')
    const page = chain?.steps[0].children?.find(step => step.identity.type === 'EditPage')
    if (!page) continue
    expect(page.edgeLabel).toBe('editPage')
    expect(page.children).toBeDefined()
    return
  }
  throw new Error('No discovered CreateObjectView has a linked EditPage')
}, 30_000)
