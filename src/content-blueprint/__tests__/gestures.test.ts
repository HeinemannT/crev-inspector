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
}))
vi.mock('../view', () => ({ render: vi.fn() }))

import { armBox, cancelGesture } from '../gestures'
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
  document.body.replaceChildren()
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
