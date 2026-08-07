/**
 * Explicit command-auth strategies. There is no runtime fallback: portal mode
 * never submits a password and stored mode never touches /cs/authentication.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockChromeStorage } from './chrome-mock';
import { JavaEnum, JavaWriter, type JavaClassDesc } from '../java-serial';
import { registerBmpTypes } from '../bmp-types';

const enumDesc = (name: string): JavaClassDesc => ({
  name,
  uid: 0n,
  flags: 0x12,
  fields: [],
  parent: null,
});

function directTicketBytes(user = 'config.user'): Uint8Array {
  registerBmpTypes();
  const writer = new JavaWriter();
  writer.writeStreamHeader();
  writer.writeObject({
    $type: 'com.corporater.bmp.base.system.auth.LoginTicket',
    key: 9223372036854775707n,
    clientUserAgent: new JavaEnum(enumDesc('com.corporater.bmp.base.system.auth.ClientUserAgent'), 'STUDIO'),
    onBehalfOfId: user,
    onBehalfOfType: new JavaEnum(enumDesc('com.corporater.bmp.base.system.auth.OnBehalfOfType'), 'USER'),
    principalId: user,
    principalType: new JavaEnum(enumDesc('com.corporater.bmp.base.system.auth.PrincipalType'), 'USER'),
  });
  return writer.toBytes();
}

beforeEach(() => {
  mockChromeStorage();
  vi.restoreAllMocks();
});

describe('BmpAuth explicit strategies', () => {
  it('portal mode borrows the browser session and never posts stored credentials', async () => {
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = input.toString();
      if (url.endsWith('graphql')) {
        return { ok: true, status: 200, redirected: false, url,
          json: async () => ({ data: { authorizationCode: { code: 'code-1' } } }) } as Response;
      }
      if (url.endsWith('cstoken')) {
        return { ok: true, status: 200, json: async () => ({ accessToken: 'jwt-1', refreshToken: 'rt-1' }) } as Response;
      }
      if (url.endsWith('ticket')) return new Response('portal.user;STUDIO;42');
      return new Response('', { status: 404 });
    });
    globalThis.fetch = fetchSpy;
    const { BmpAuth } = await import('../bmp-auth');
    const auth = new BmpAuth('https://bmp.test/', 'dormant', 'secret', 'p1', 'portal');

    expect(await auth.getLoginTicket()).toBe('portal.user;STUDIO;42');
    expect(auth.commandUser).toBe('portal.user');
    expect(fetchSpy.mock.calls.some(([url]) => url.toString().includes('cs/authentication'))).toBe(false);
    expect(fetchSpy.mock.calls.some(([url]) => url.toString().includes('cs/login'))).toBe(false);
  });

  it('stored mode obtains a direct ticket with cookies omitted and never probes portal auth', async () => {
    const bytes = directTicketBytes();
    const fetchSpy = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(init?.credentials).toBe('omit');
      return new Response(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, { status: 200 });
    });
    globalThis.fetch = fetchSpy;
    const { BmpAuth } = await import('../bmp-auth');
    const auth = new BmpAuth('https://bmp.test/', 'config.user', 'secret', 'p2', 'stored', 'rev-1');

    expect(await auth.getLoginTicket()).toBe('config.user;STUDIO;9223372036854775707');
    expect(auth.commandUser).toBe('config.user');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [input, init] = fetchSpy.mock.calls[0];
    const loginUrl = new URL(input.toString());
    expect(loginUrl.pathname).toBe('/cs/login');
    expect(loginUrl.searchParams.get('username')).toBe('config.user');
    expect(loginUrl.searchParams.get('password')).toBe('secret');
    expect(init?.body).toBeUndefined();
    expect(fetchSpy.mock.calls.some(([url]) => url.toString().includes('cs/authentication'))).toBe(false);
    expect(fetchSpy.mock.calls.some(([url]) => url.toString().includes('graphql'))).toBe(false);
  });

  it('stored mode rejects HTML without falling back to the portal identity', async () => {
    const fetchSpy = vi.fn(async () => new Response('<html>login</html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    }));
    globalThis.fetch = fetchSpy;
    const { BmpAuth } = await import('../bmp-auth');
    const auth = new BmpAuth('https://bmp.test/', 'config.user', 'wrong', 'p3', 'stored', 'rev-1');

    await expect(auth.getLoginTicket()).rejects.toMatchObject({ code: 'auth-failed' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('deduplicates direct login and restores only the matching credential revision', async () => {
    const bytes = directTicketBytes('config.user');
    const fetchSpy = vi.fn(async () =>
      new Response(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer));
    globalThis.fetch = fetchSpy;
    const { BmpAuth } = await import('../bmp-auth');
    const first = new BmpAuth('https://bmp.test/', 'config.user', 'secret', 'p5', 'stored', 'rev-1');

    const tickets = await Promise.all([
      first.getLoginTicket(),
      first.getLoginTicket(),
      first.getLoginTicket(),
    ]);
    expect(new Set(tickets)).toEqual(new Set(['config.user;STUDIO;9223372036854775707']));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    await vi.waitFor(async () => {
      const stored = await chrome.storage.session.get('crev_command_auth_v2_p5');
      expect(stored.crev_command_auth_v2_p5).toMatchObject({ kind: 'direct-ticket' });
    });

    const restored = new BmpAuth('https://bmp.test/', 'config.user', 'secret', 'p5', 'stored', 'rev-1');
    expect(await restored.getLoginTicket()).toBe(tickets[0]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const rotated = new BmpAuth('https://bmp.test/', 'config.user', 'new-secret', 'p5', 'stored', 'rev-2');
    expect(await rotated.getLoginTicket()).toBe(tickets[0]);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('portal mode reports the browser-session problem instead of using dormant credentials', async () => {
    const fetchSpy = vi.fn(async () => ({
      ok: false,
      status: 401,
      redirected: false,
      url: 'https://bmp.test/graphql',
    } as Response));
    globalThis.fetch = fetchSpy;
    const { BmpAuth } = await import('../bmp-auth');
    const auth = new BmpAuth('https://bmp.test/', 'dormant', 'secret', 'p4', 'portal');

    await expect(auth.getLoginTicket()).rejects.toMatchObject({ code: 'needs-login' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('portal mode rejects a successful HTML ticket response', async () => {
    const fetchSpy = vi.fn(async (input: string | URL | Request) => {
      const url = input.toString();
      if (url.endsWith('graphql')) {
        return { ok: true, status: 200, redirected: false, url,
          json: async () => ({ data: { authorizationCode: { code: 'code-1' } } }) } as Response;
      }
      if (url.endsWith('cstoken')) {
        return { ok: true, status: 200, json: async () => ({ accessToken: 'jwt-1' }) } as Response;
      }
      return new Response('<html>sign in</html>', { status: 200 });
    });
    globalThis.fetch = fetchSpy;
    const { BmpAuth } = await import('../bmp-auth');
    const auth = new BmpAuth('https://bmp.test/', '', '', 'p6', 'portal');

    await expect(auth.getLoginTicket()).rejects.toMatchObject({
      code: 'exchange-failed',
      message: expect.stringContaining('invalid command ticket'),
    });
  });
});
