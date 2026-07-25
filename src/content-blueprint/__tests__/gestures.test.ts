/** @vitest-environment happy-dom */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LModel, LNode } from '../../lib/layout/types'

vi.mock('../actions', () => ({
  mutate: vi.fn(),
  select: vi.fn(),
  setHint: vi.fn(),
  doSwap: vi.fn(),
  doInsert: vi.fn(),
  doMoveInto: vi.fn(),
  doFlowReorder: vi.fn(),
  brushOnCell: vi.fn(),
  viewEditPage: vi.fn(),
}))
vi.mock('../view', () => ({ render: vi.fn() }))

import { doFlowReorder, viewEditPage } from '../actions'
import { armBox, armFlowRow, cancelGesture } from '../gestures'
import { bp } from '../state'

const node = (id: string, kind: LNode['kind'], children: LNode[] = []): LNode => ({
  id,
  kind,
  className: kind === 'tab' ? 'Tab' : 'ExtendedTable',
  name: id,
  cols: { L: 6 },
  children,
})

afterEach(() => {
  cancelGesture()
  bp.layer = null
  bp.history = null
  bp.viewTabId = null
  vi.mocked(doFlowReorder).mockReset()
  vi.mocked(viewEditPage).mockReset()
  document.body.replaceChildren()
})

describe('EditPage spatial drag', () => {
  const rect = (left: number, top: number, width = 180, height = 60): DOMRect => ({
    x: left, y: top, left, top, right: left + width, bottom: top + height,
    width, height, toJSON: () => ({}),
  } as DOMRect)

  it('uses the column under the pointer before vertical distance', () => {
    bp.mode = 'layout'
    const layer = document.createElement('div')
    const source = document.createElement('div')
    const handle = document.createElement('span')
    source.className = 'bp-ep-field'
    source.dataset.flowkey = 'page'
    source.dataset.flowid = 'source'
    source.appendChild(handle)
    source.getBoundingClientRect = () => rect(0, 100)

    const leftTie = document.createElement('div')
    leftTie.dataset.flowkey = 'page'
    leftTie.dataset.flowid = 'left'
    leftTie.getBoundingClientRect = () => rect(0, 200)
    const rightTarget = document.createElement('div')
    rightTarget.dataset.flowkey = 'page'
    rightTarget.dataset.flowid = 'right'
    rightTarget.getBoundingClientRect = () => rect(220, 200)
    layer.append(source, leftTie, rightTarget)
    document.body.append(layer)
    bp.layer = layer

    armFlowRow(handle, source, 'page', 'source', false, true)
    handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 10, clientY: 110 }))
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 240, clientY: 245 }))
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 240, clientY: 245 }))

    expect(doFlowReorder).toHaveBeenCalledWith('page', 'source', 'right')
  })

  it('moves a field to the start of a page when dropped on its tab', () => {
    bp.mode = 'layout'
    vi.mocked(viewEditPage).mockImplementation((id: string) => { bp.viewTabId = id })
    const layer = document.createElement('div')
    const source = document.createElement('div')
    const handle = document.createElement('span')
    source.className = 'bp-ep-field'
    source.dataset.flowkey = 'page'
    source.dataset.flowid = 'source'
    source.appendChild(handle)
    source.getBoundingClientRect = () => rect(0, 100)
    const pageTab = document.createElement('button')
    pageTab.dataset.flowpagekey = 'assessment'
    pageTab.dataset.flowpageafter = 'page-break-2'
    pageTab.dataset.flowpageoffset = '1'
    pageTab.dataset.flowpagetitle = 'Assessment'
    pageTab.textContent = 'Assessment'
    pageTab.getBoundingClientRect = () => rect(220, 20, 120, 40)
    layer.append(source, pageTab)
    document.body.append(layer)
    bp.layer = layer

    armFlowRow(handle, source, 'page', 'source', false, true)
    handle.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 10, clientY: 110 }))
    document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 240, clientY: 35 }))
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 240, clientY: 35 }))

    expect(doFlowReorder).toHaveBeenCalledWith('page', 'source', 'page-break-2')
    expect(viewEditPage).toHaveBeenCalledWith('assessment', 1)
    expect(bp.viewTabId).toBe('assessment')
  })
})

describe('Blueprint box drag', () => {
  it('clones the layout model once per gesture, not once per mousemove', () => {
    const sourceNode = node('source', 'widget')
    const targetNode = node('target', 'widget')
    const layout: LModel = {
      pageId: 'page',
      pageClass: 'Scorecard',
      tabsetId: 'tabs',
      tabs: [node('tab', 'tab', [sourceNode, targetNode])],
      target: 'instance',
      hasTemplate: false,
    }
    const present = vi.fn(() => layout)
    bp.history = { present } as never
    bp.mode = 'layout'

    const layer = document.createElement('div')
    const source = document.createElement('div')
    source.dataset.bpid = 'source'
    source.dataset.bpkind = 'widget'
    const target = document.createElement('div')
    target.dataset.bpid = 'target'
    target.dataset.bpkind = 'widget'
    target.getBoundingClientRect = () => ({
      x: 20, y: 20, left: 20, top: 20, right: 120, bottom: 120,
      width: 100, height: 100, toJSON: () => ({}),
    })
    layer.append(source, target)
    document.body.append(layer)
    bp.layer = layer
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(() => target) })

    armBox(source, 'source')
    source.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: 0, clientY: 0 }))
    for (const xy of [30, 40, 50, 60]) {
      document.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: xy, clientY: xy }))
    }

    expect(present).toHaveBeenCalledTimes(1)
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: 60, clientY: 60 }))
  })
})
