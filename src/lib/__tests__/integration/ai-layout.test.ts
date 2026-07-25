/** Live, read-only contract for the lean structure path used by AI read_layout. */
import { expect, it } from 'vitest'
import { bridgePreview, buildDiscoveryEc, integrationTarget, parseDiscoveryRows } from './config'
import { loadStructureModel, resolvePageContext, type LayoutIO } from '../../layout/sync'

it('loads a dynamically discovered page through the lean AI projection', async () => {
  const target = integrationTarget()
  const pages = parseDiscoveryRows(await bridgePreview(target, buildDiscoveryEc('Scorecard')))
  expect(pages.length).toBeGreaterThan(0)
  const io: LayoutIO = {
    exec: async code => ({ ok: true, log: await bridgePreview(target, code) }),
  }

  for (const page of pages.slice(0, 10)) {
    const ctx = await resolvePageContext(io, page.rid)
    if (!ctx) continue
    const result = await loadStructureModel(io, ctx)
    expect(result.model.pageId).toBe(ctx.pageId)
    expect(Array.isArray(result.model.tabs)).toBe(true)
    return
  }
  throw new Error('No discovered Scorecard was a readable page host')
}, 60_000)
