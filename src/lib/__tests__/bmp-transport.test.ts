import { afterEach, describe, expect, it, vi } from 'vitest'
import { BmpTransport, BmpTransportError } from '../bmp-transport'

afterEach(() => vi.unstubAllGlobals())

function mockAuth() {
  return {
    getLoginTicket: vi.fn().mockResolvedValue('ticket value'),
    refreshLoginTicket: vi.fn().mockResolvedValue('fresh ticket'),
    invalidateLoginTicket: vi.fn(),
  }
}

describe('BmpTransport command requests', () => {
  it('uses the cross-version LoginTicket path with required command flags', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const auth = mockAuth()
    const transport = new BmpTransport('https://bmp.test/Workspace/', auth as never)

    await transport.sendRequest(new Uint8Array([0xac, 0xed]), 1_000, 'read')

    expect(fetchMock).toHaveBeenCalledWith(
      'https://bmp.test/Workspace/cs/command?LOGIN_TICKET=ticket%20value&async=false&_noctx=true',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('replays a read once with a refreshed ticket after 401', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const auth = mockAuth()
    const transport = new BmpTransport('https://bmp.test/Workspace/', auth as never)

    await transport.sendRequest(new Uint8Array([0xac]), 1_000, 'read')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(auth.refreshLoginTicket).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[1][0]).toContain('LOGIN_TICKET=fresh%20ticket')
  })

  it('never replays a write after 401', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    const auth = mockAuth()
    const transport = new BmpTransport('https://bmp.test/Workspace/', auth as never)

    const error = await transport.sendRequest(new Uint8Array([0xac]), 1_000, 'write').catch(e => e)

    expect(error).toBeInstanceOf(BmpTransportError)
    expect(error).toMatchObject({ kind: 'auth', status: 401, attempts: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(auth.invalidateLoginTicket).toHaveBeenCalledTimes(1)
    expect(auth.refreshLoginTicket).not.toHaveBeenCalled()
  })

  it('classifies 403 as permission failure without retrying', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 403 }))
    vi.stubGlobal('fetch', fetchMock)
    const auth = mockAuth()
    const transport = new BmpTransport('https://bmp.test/Workspace/', auth as never)

    const error = await transport.sendRequest(new Uint8Array([0xac]), 1_000, 'read').catch(e => e)

    expect(error).toMatchObject({ kind: 'permission', status: 403, attempts: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(auth.refreshLoginTicket).not.toHaveBeenCalled()
  })

  it('replays a read once after a transient network failure', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const auth = mockAuth()
    const transport = new BmpTransport('https://bmp.test/Workspace/', auth as never)

    await transport.sendRequest(new Uint8Array([0xac]), 1_000, 'read')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(auth.refreshLoginTicket).not.toHaveBeenCalled()
  })

  it('never replays a write after a transient network failure', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    vi.stubGlobal('fetch', fetchMock)
    const auth = mockAuth()
    const transport = new BmpTransport('https://bmp.test/Workspace/', auth as never)

    const error = await transport.sendRequest(new Uint8Array([0xac]), 1_000, 'write').catch(e => e)

    expect(error).toMatchObject({ kind: 'network', attempts: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('reports retry exhaustion with two attempts', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    vi.stubGlobal('fetch', fetchMock)
    const auth = mockAuth()
    const transport = new BmpTransport('https://bmp.test/Workspace/', auth as never)

    const error = await transport.sendRequest(new Uint8Array([0xac]), 1_000, 'read').catch(e => e)

    expect(error).toMatchObject({ kind: 'network', attempts: 2 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('distinguishes caller cancellation from timeout and does not retry either', async () => {
    const auth = mockAuth()
    const transport = new BmpTransport('https://bmp.test/Workspace/', auth as never)
    const controller = new AbortController()
    controller.abort()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const cancelled = await transport.sendRequest(
      new Uint8Array([0xac]),
      1_000,
      'read',
      controller.signal,
    ).catch(e => e)
    expect(cancelled).toMatchObject({ kind: 'cancelled', attempts: 0 })
    expect(fetchMock).not.toHaveBeenCalled()

    fetchMock.mockRejectedValueOnce(new DOMException('timed out', 'TimeoutError'))
    const timedOut = await transport.sendRequest(new Uint8Array([0xac]), 1_000, 'read').catch(e => e)
    expect(timedOut).toMatchObject({ kind: 'timeout', attempts: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries transient 503 only for reads', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const auth = mockAuth()
    const transport = new BmpTransport('https://bmp.test/Workspace/', auth as never)

    await transport.sendRequest(new Uint8Array([0xac]), 1_000, 'read')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('classifies malformed binary responses as protocol failures', () => {
    const transport = new BmpTransport('https://bmp.test/Workspace/', mockAuth() as never)
    const malformed = new Uint8Array([0x00, 0x01]).buffer
    const outcomes: any[] = []
    transport.setOutcomeObserver(outcome => outcomes.push(outcome))

    expect(() => transport.deserializeResponse(malformed)).toThrow(
      expect.objectContaining({ kind: 'protocol' }),
    )
    expect(() => transport.deserializeStream(malformed)).toThrow(
      expect.objectContaining({ kind: 'protocol' }),
    )
    expect(outcomes).toHaveLength(2)
    expect(outcomes[0]).toMatchObject({ ok: false, intent: 'read', error: { kind: 'protocol' } })
  })
})
