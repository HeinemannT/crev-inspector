/**
 * BMP binary transport — sends serialized commands with JWT auth and retry on 401.
 */

import { serializeCommands, deserializeResponse, deserializeStream } from './java-serial';
import { BmpAuth } from './bmp-auth';
import { AUTH_TIMEOUT, EC_TIMEOUT } from './constants';

export class BmpTransport {
  /** When true, all commands use LOGIN_TICKET instead of JWT Bearer.
   *  Set by the connection layer when BMP version < 5.6.3 is detected. */
  useTicketAuth = false;

  constructor(
    private bmpUrl: string,
    private auth: BmpAuth,
  ) {}

  /** Send serialized body, using JWT Bearer or LOGIN_TICKET depending on useTicketAuth */
  async sendRequest(body: Uint8Array, timeout: number): Promise<ArrayBuffer> {
    if (this.useTicketAuth) {
      const makeTicketReq = async (ticket: string) => {
        const url = `${this.bmpUrl}cs/command?LOGIN_TICKET=${encodeURIComponent(ticket)}`;
        return fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-java-serialized-object' },
          body: body.buffer as ArrayBuffer,
          signal: AbortSignal.timeout(timeout),
        });
      };

      const ticket = await this.auth.getLoginTicket();
      const res = await makeTicketReq(ticket);

      if (res.status === 401 || res.status === 403) {
        // Ticket expired — invalidate cached ticket, get fresh one, retry
        this.auth.invalidateJwt(); // clears both JWT and cached ticket
        const freshTicket = await this.auth.getLoginTicket();
        const retryRes = await makeTicketReq(freshTicket);
        if (!retryRes.ok) throw new Error(`Command failed: HTTP ${retryRes.status}`);
        return retryRes.arrayBuffer();
      }

      if (!res.ok) throw new Error(`Command failed: HTTP ${res.status}`);
      return res.arrayBuffer();
    }

    const jwt = await this.auth.ensureAuth();
    const url = `${this.bmpUrl}cs/command`;

    const makeOpts = (token: string): RequestInit => ({
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-java-serialized-object',
        'Authorization': `Bearer ${token}`,
      },
      body: body.buffer as ArrayBuffer,
      signal: AbortSignal.timeout(timeout),
    });

    const res = await fetch(url, makeOpts(jwt));

    if (res.status === 403) {
      throw new Error('Permission denied (403)');
    }

    if (res.status === 401) {
      this.auth.invalidateJwt();
      const refreshed = await this.auth.refreshAuth();
      if (!refreshed) await this.auth.login();
      const retryRes = await fetch(url, makeOpts(this.auth.jwt!));
      if (!retryRes.ok) throw new Error(`Command failed: HTTP ${retryRes.status}`);
      return retryRes.arrayBuffer();
    }

    if (!res.ok) throw new Error(`Command failed: HTTP ${res.status}`);
    return res.arrayBuffer();
  }

  /** Send one or more serialized commands */
  async sendCommands(commands: any[]): Promise<ArrayBuffer> {
    return this.sendRequest(serializeCommands(commands), AUTH_TIMEOUT);
  }

  /** Send a streaming command (e.g. ExtendedExecuteCommand) */
  async sendStreamingCommand(command: any): Promise<any[]> {
    const buffer = await this.sendRequest(serializeCommands([command]), EC_TIMEOUT);
    return deserializeStream(buffer);
  }

  /** Deserialize a response buffer */
  deserializeResponse(buffer: ArrayBuffer): any {
    return deserializeResponse(buffer);
  }

  /** Translate errors into user-friendly messages */
  formatError(e: unknown): string {
    if (e instanceof TypeError && (e.message.includes('fetch') || e.message.includes('network'))) {
      return `Cannot reach BMP at ${this.bmpUrl}`;
    }
    if (e instanceof DOMException && e.name === 'AbortError') {
      return `BMP at ${this.bmpUrl} timed out`;
    }
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('Bad magic')) return 'Server response is not BMP binary — wrong URL or version mismatch';
    if (msg.includes('Unknown type code')) return 'BMP version mismatch — response contains unknown data types';
    if (msg.includes('Bad handle reference')) return 'BMP protocol error — possible version mismatch';
    return msg;
  }
}
