/**
 * @vitest-environment happy-dom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { JsonShapeStore } from '../ec/json-shape-store'
import type { JsonLocator } from '../ec/json-source'

const runtime: JsonLocator = {
  root: { kind: 'runtime', expression: 'this.object.description' },
  steps: [],
}

const response = {
  type: 'JSON_SHAPE_RESULT',
  ok: true,
  shape: {
    kind: 'object',
    truncated: false,
    fields: [{ key: 'name', optional: false, shape: { kind: 'string' } }],
  },
}

beforeEach(() => {
  ;(globalThis as unknown as { chrome: unknown }).chrome = {
    runtime: { sendMessage: vi.fn(() => Promise.resolve(response)) },
  }
})

describe('JSON shape store', () => {
  it('parses raw JSON locally and resolves derived paths', async () => {
    const store = new JsonShapeStore()
    const locator: JsonLocator = {
      root: { kind: 'literal', text: '{"rows":[{"id":1}]}' },
      steps: [{ kind: 'property', key: 'rows' }, { kind: 'element' }],
    }
    expect(store.peek(locator)).toMatchObject({ status: 'ready', shape: { kind: 'object' } })
    expect((await store.load(locator)).kind).toBe('object')
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled()
  })

  it('deduplicates concurrent runtime reads and caches the root for nested paths', async () => {
    const store = new JsonShapeStore()
    const nested: JsonLocator = { ...runtime, steps: [{ kind: 'property', key: 'name' }] }
    const [root, rootAgain] = await Promise.all([store.load(runtime, '9'), store.load(runtime, '9')])
    expect(root.kind).toBe('object')
    expect(rootAgain.kind).toBe('object')
    expect((await store.load(nested, '9')).kind).toBe('string')
    expect(chrome.runtime.sendMessage).toHaveBeenCalledTimes(1)
  })

  it('clears profile/context data and permits explicit refresh after errors', async () => {
    const send = chrome.runtime.sendMessage as ReturnType<typeof vi.fn>
    send.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(response)
    const store = new JsonShapeStore()
    await expect(store.load(runtime, '9')).rejects.toThrow('offline')
    await expect(store.load(runtime, '9')).rejects.toThrow('offline')
    expect(send).toHaveBeenCalledTimes(1)
    await expect(store.refresh(runtime, '9')).resolves.toMatchObject({ kind: 'object' })
    expect(send).toHaveBeenCalledTimes(2)
    store.clear()
    expect(store.peek(runtime, '9')).toEqual({ status: 'idle' })
  })
})
