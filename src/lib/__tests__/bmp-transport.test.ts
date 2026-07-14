import { afterEach, describe, expect, it, vi } from 'vitest'
import { BmpTransport } from '../bmp-transport'

afterEach(() => vi.unstubAllGlobals())

describe('BmpTransport command URL', () => {
  it('uses the cross-version LoginTicket path with required command flags', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const auth = {
      getLoginTicket: vi.fn().mockResolvedValue('ticket value'),
      invalidateJwt: vi.fn(),
    }
    const transport = new BmpTransport('https://bmp.test/Workspace/', auth as never)

    await transport.sendRequest(new Uint8Array([0xac, 0xed]), 1_000)

    expect(fetchMock).toHaveBeenCalledWith(
      'https://bmp.test/Workspace/cs/command?LOGIN_TICKET=ticket%20value&async=false&_noctx=true',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('retains the full command flags on the Bearer compatibility path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([1]), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const auth = { ensureAuth: vi.fn().mockResolvedValue('jwt') }
    const transport = new BmpTransport('https://bmp.test/Workspace/', auth as never)
    transport.useTicketAuth = false

    await transport.sendRequest(new Uint8Array([0xac]), 1_000)

    expect(fetchMock).toHaveBeenCalledWith(
      'https://bmp.test/Workspace/cs/command?async=false&_noctx=true',
      expect.objectContaining({ method: 'POST' }),
    )
  })
})
