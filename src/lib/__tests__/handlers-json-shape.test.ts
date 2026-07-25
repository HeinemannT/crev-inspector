import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { InspectorMessage } from '../types'

const executeEc = vi.fn()
const record = vi.fn()
const logActivity = vi.fn()

function context(client: unknown = { executeEc }) {
  return {
    client,
    scriptHistory: { record },
    history: { record },
    logActivity,
  }
}

async function handlerFor(ctx: ReturnType<typeof context>) {
  vi.resetModules()
  const sw = await import('../sw-context')
  sw.setSwContext(ctx as never)
  await import('../handlers/json-shape')
  const { getHandler } = await import('../handler-registry')
  return getHandler('JSON_SHAPE_READ')!
}

async function call(ctx: ReturnType<typeof context>, source = 'this.object.description') {
  const responses: InspectorMessage[] = []
  const handler = await handlerFor(ctx)
  await handler(
    { type: 'JSON_SHAPE_READ', source, objectRid: '123' },
    response => responses.push(response),
    { isOneShot: true },
  )
  return responses[0]
}

beforeEach(() => {
  executeEc.mockReset()
  record.mockReset()
  logActivity.mockReset()
})

describe('JSON_SHAPE_READ', () => {
  it('returns a value-free shape without recording an EC run', async () => {
    executeEc.mockResolvedValue({
      ok: true,
      hasError: false,
      hasWarning: false,
      outputEntries: [
        { logType: 'MESSAGE', message: '{"secret":"hidden","rows":[{"id":1}]}', result: false },
        { logType: 'MESSAGE', message: '0', result: true },
        { logType: 'MESSAGE', message: 'Duration : 2ms', result: false },
      ],
    })
    const response = await call(context())
    expect(response).toMatchObject({ type: 'JSON_SHAPE_RESULT', ok: true })
    expect(JSON.stringify(response)).not.toContain('hidden')
    expect(executeEc).toHaveBeenCalledWith('output(this.object.description)', '123', false)
    expect(record).not.toHaveBeenCalled()
    expect(logActivity).not.toHaveBeenCalled()
  })

  it('rejects unsafe expressions before execution', async () => {
    const response = await call(context(), 'this.object.change(name := "bad")')
    expect(response).toMatchObject({ type: 'JSON_SHAPE_RESULT', ok: false, error: 'Unsupported JSON source' })
    expect(executeEc).not.toHaveBeenCalled()
  })

  it('reports disconnected, warnings, ambiguous output, and invalid JSON', async () => {
    expect(await call(context(null))).toMatchObject({ ok: false, error: 'Not connected' })

    executeEc.mockResolvedValueOnce({ ok: true, hasWarning: true, outputEntries: [] })
    expect(await call(context())).toMatchObject({ ok: false })

    executeEc.mockResolvedValueOnce({
      ok: true,
      outputEntries: [
        { logType: 'MESSAGE', message: '{}', result: false },
        { logType: 'MESSAGE', message: '[]', result: false },
      ],
    })
    expect(await call(context())).toMatchObject({ ok: false, error: 'JSON source returned ambiguous output' })

    executeEc.mockResolvedValueOnce({
      ok: true,
      outputEntries: [{ logType: 'MESSAGE', message: '{bad', result: false }],
    })
    expect(await call(context())).toMatchObject({ ok: false, error: 'Invalid JSON' })
  })

  it('returns transport failures without logging data', async () => {
    executeEc.mockRejectedValue(new Error('offline'))
    expect(await call(context())).toMatchObject({ ok: false, error: 'offline' })
    expect(record).not.toHaveBeenCalled()
    expect(logActivity).not.toHaveBeenCalled()
  })
})
