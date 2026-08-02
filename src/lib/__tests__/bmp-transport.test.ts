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
  it('serializes concurrent command posts sharing one transport session', async () => {
    let releaseFirst: ((response: Response) => void) | undefined
    const firstResponse = new Promise<Response>((resolve) => {
      releaseFirst = resolve
    })
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => firstResponse)
      .mockResolvedValueOnce(new Response(new Uint8Array([2]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const transport = new BmpTransport(
      'https://bmp.test/Workspace/',
      mockAuth() as never,
    )

    const first = transport.sendRequest(new Uint8Array([1]), 1_000, 'read')
    const second = transport.sendRequest(new Uint8Array([2]), 1_000, 'read')

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    releaseFirst?.(new Response(new Uint8Array([1]), { status: 200 }))
    await first
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2))
    await second

    expect(new Uint8Array(fetchMock.mock.calls[0][1].body as ArrayBuffer)).toEqual(
      new Uint8Array([1]),
    )
    expect(new Uint8Array(fetchMock.mock.calls[1][1].body as ArrayBuffer)).toEqual(
      new Uint8Array([2]),
    )
  })

  it('drops a cancelled queued command before it posts to BMP', async () => {
    let releaseFirst: ((response: Response) => void) | undefined
    const firstResponse = new Promise<Response>((resolve) => {
      releaseFirst = resolve
    })
    const fetchMock = vi.fn().mockImplementationOnce(() => firstResponse)
    vi.stubGlobal('fetch', fetchMock)
    const transport = new BmpTransport(
      'https://bmp.test/Workspace/',
      mockAuth() as never,
    )
    const controller = new AbortController()

    const first = transport.sendRequest(new Uint8Array([1]), 1_000, 'read')
    const queued = transport.sendRequest(new Uint8Array([2]), 1_000, 'read', controller.signal)
      .catch(error => error)

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1))
    controller.abort()
    releaseFirst?.(new Response(new Uint8Array([1]), { status: 200 }))
    await first

    await expect(queued).resolves.toMatchObject({ kind: 'cancelled', attempts: 0 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('continues the request queue after a failed command', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response(new Uint8Array([2]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const transport = new BmpTransport(
      'https://bmp.test/Workspace/',
      mockAuth() as never,
    )

    const failed = transport.sendRequest(new Uint8Array([1]), 1_000, 'write').catch(error => error)
    const succeeded = transport.sendRequest(new Uint8Array([2]), 1_000, 'read')

    await expect(failed).resolves.toMatchObject({ kind: 'network', attempts: 1 })
    await expect(succeeded).resolves.toBeInstanceOf(ArrayBuffer)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

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

  it('reports command identity, queue pressure, sizes, and retry count', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const transport = new BmpTransport('https://bmp.test/Workspace/', mockAuth() as never)
    const outcomes: any[] = []
    transport.setOutcomeObserver(outcome => outcomes.push(outcome))

    await transport.sendRequest(
      new Uint8Array([0xac]),
      1_000,
      'read',
      undefined,
      { operation: 'TreeItemCommand', commandCount: 1 },
    )

    expect(outcomes).toHaveLength(1)
    expect(outcomes[0]).toMatchObject({
      ok: true,
      intent: 'read',
      operation: 'TreeItemCommand',
      commandCount: 1,
      queueDepth: 0,
      attempts: 2,
      responseBytes: 3,
    })
    expect(outcomes[0].requestBytes).toBeGreaterThan(0)
    expect(outcomes[0].queueWaitMs).toBeGreaterThanOrEqual(0)
    expect(outcomes[0].durationMs).toBeGreaterThanOrEqual(0)
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
