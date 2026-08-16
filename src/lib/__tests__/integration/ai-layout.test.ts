/** Live, read-only contract for the lean structure path used by AI read_layout. */
import { expect, it } from 'vitest'
import { bridgePreview, buildDiscoveryEc, integrationTarget, parseDiscoveryRows } from './config'
import { loadStructureModel, resolvePageContext, type LayoutIO } from '../../layout/sync'
import type { LNode } from '../../layout/types'
import { projectAiLayout } from '../../handlers/ai-tools'

const STEADFAST_LANDING_PAGE_RID = '726548820039520945'

const flatten = (nodes: LNode[]): LNode[] => nodes.flatMap(node => [node, ...flatten(node.children)])

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

it('maps Steadfast landing-page instance widgets to their shared template widgets', async () => {
  const target = integrationTarget()
  const io: LayoutIO = { exec: async code => ({ ok: true, log: await bridgePreview(target, code) }) }
  const ctx = await resolvePageContext(io, STEADFAST_LANDING_PAGE_RID)
  expect(ctx?.templateRid).toBeTruthy()
  const result = await loadStructureModel(io, ctx!)
  expect(result.model.templateRid).toBe(ctx!.templateRid)
  const inherited = flatten(result.model.tabs).filter(node => node.kind === 'widget' && node.linkedTemplate)
  expect(inherited.length).toBeGreaterThan(0)
  expect(inherited.every(node => /^\d+$/.test(node.linkedTemplate!.rid) && !!node.linkedTemplate!.id)).toBe(true)
  const projection = projectAiLayout(STEADFAST_LANDING_PAGE_RID, {
    kind: 'page',
    ctx: ctx!,
    load: result,
  })
  const inheritedTargets = projection.targets.filter(target => target.status === 'resolved' && target.reason === 'inherited-widget-default')
  expect(inheritedTargets).toHaveLength(inherited.length)
  const masterIds = new Set(inherited.map(node => node.linkedTemplate!.id))
  expect(inheritedTargets.every(target => target.status === 'resolved' && target.scope === 'shared-template' && masterIds.has(target.target.businessId))).toBe(true)
}, 60_000)
