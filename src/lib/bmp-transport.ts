/**
 * BMP binary transport — one LoginTicket command path with bounded,
 * operation-aware recovery.
 */

import { serializeCommands, deserializeResponse, deserializeStream } from './java-serial';
import { BmpAuth } from './bmp-auth';
import { AUTH_TIMEOUT, EC_TIMEOUT } from './constants';

export type CommandIntent = 'read' | 'write';
export type BmpTransportErrorKind =
  | 'auth'
  | 'permission'
  | 'network'
  | 'timeout'
  | 'cancelled'
  | 'http'
  | 'protocol';

export class BmpTransportError extends Error {
  constructor(
    message: string,
    readonly kind: BmpTransportErrorKind,
    readonly attempts: number,
    readonly status?: number,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'BmpTransportError';
  }
}

export type BmpTransportOutcome =
  | { ok: true; intent: CommandIntent }
  | { ok: false; intent: CommandIntent; error: BmpTransportError };

const TRANSIENT_HTTP = new Set([502, 503, 504]);

export class BmpTransport {
  private outcomeObserver: ((outcome: BmpTransportOutcome) => void) | null = null;

  constructor(
    private bmpUrl: string,
    private auth: BmpAuth,
  ) {}

  /** The workspace base URL (trailing slash), e.g. `https://host/Workspace/`.
   *  Used to build non-command servlet URLs like the CVO data servlet. */
  get baseUrl(): string { return this.bmpUrl }

  setOutcomeObserver(observer: ((outcome: BmpTransportOutcome) => void) | null): void {
    this.outcomeObserver = observer;
  }

  /** Send a serialized command body through the cross-version LoginTicket path.
   *  Reads may be replayed once after an expired ticket or transient network/
   *  gateway failure. Writes always make exactly one command POST. */
  async sendRequest(
    body: Uint8Array,
    timeout: number,
    intent: CommandIntent,
    signal?: AbortSignal,
  ): Promise<ArrayBuffer> {
    try {
      const buffer = await this.sendRequestInternal(body, timeout, intent, signal);
      this.emitOutcome({ ok: true, intent });
      return buffer;
    } catch (cause) {
      const error = cause instanceof BmpTransportError
        ? cause
        : this.classifyError(cause, 0, signal);
      this.emitOutcome({ ok: false, intent, error });
      throw error;
    }
  }

  private async sendRequestInternal(
    body: Uint8Array,
    timeout: number,
    intent: CommandIntent,
    signal?: AbortSignal,
  ): Promise<ArrayBuffer> {
    if (signal?.aborted) {
      throw new BmpTransportError('BMP request cancelled', 'cancelled', 0);
    }

    const deadline = Date.now() + timeout;
    const maxAttempts = intent === 'read' ? 2 : 1;
    let ticket: string;
    try {
      ticket = await this.auth.getLoginTicket();
    } catch (cause) {
      throw this.classifyError(cause, 0, signal, 'Could not obtain a BMP login ticket');
    }

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (signal?.aborted) {
        throw new BmpTransportError('BMP request cancelled', 'cancelled', attempt - 1);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new BmpTransportError(`BMP at ${this.bmpUrl} timed out`, 'timeout', attempt - 1);
      }

      try {
        const res = await this.postCommand(body, ticket, remaining, signal);

        if (res.status === 401) {
          if (intent === 'write' || attempt === maxAttempts) {
            this.auth.invalidateLoginTicket();
            throw new BmpTransportError('BMP command authentication expired (401)', 'auth', attempt, 401);
          }
          ticket = await this.auth.refreshLoginTicket();
          continue;
        }

        // A 403 is an authorization decision, not evidence that a ticket
        // expired. Re-authenticating/replaying can duplicate work and cannot
        // grant a permission the user does not have.
        if (res.status === 403) {
          throw new BmpTransportError('Permission denied (403)', 'permission', attempt, 403);
        }

        if (!res.ok) {
          if (intent === 'read' && attempt < maxAttempts && TRANSIENT_HTTP.has(res.status)) {
            continue;
          }
          throw new BmpTransportError(`Command failed: HTTP ${res.status}`, 'http', attempt, res.status);
        }

        return await res.arrayBuffer();
      } catch (cause) {
        const error = cause instanceof BmpTransportError
          ? cause
          : this.classifyError(cause, attempt, signal);
        if (intent === 'read' && attempt < maxAttempts && error.kind === 'network') {
          continue;
        }
        throw error;
      }
    }

    // The bounded loop always returns or throws. Keep an explicit guard so a
    // future attempt-policy edit cannot make this fall through silently.
    throw new BmpTransportError('BMP command retry exhausted', 'network', maxAttempts);
  }

  private emitOutcome(outcome: BmpTransportOutcome): void {
    try { this.outcomeObserver?.(outcome); } catch { /* telemetry must not break commands */ }
  }

  private postCommand(
    body: Uint8Array,
    ticket: string,
    timeout: number,
    signal?: AbortSignal,
  ): Promise<Response> {
    const timeoutSignal = AbortSignal.timeout(timeout);
    const effectiveSignal = signal ? AbortSignal.any([timeoutSignal, signal]) : timeoutSignal;
    const url = `${this.bmpUrl}cs/command?LOGIN_TICKET=${encodeURIComponent(ticket)}&async=false&_noctx=true`;
    const exactBody = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength) as ArrayBuffer;
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-java-serialized-object' },
      body: exactBody,
      signal: effectiveSignal,
    });
  }

  private classifyError(
    cause: unknown,
    attempts: number,
    callerSignal?: AbortSignal,
    fallback = 'BMP command failed',
  ): BmpTransportError {
    if (cause instanceof BmpTransportError) return cause;
    if (callerSignal?.aborted) {
      return new BmpTransportError('BMP request cancelled', 'cancelled', attempts, undefined, { cause });
    }
    if (cause instanceof DOMException && cause.name === 'TimeoutError') {
      return new BmpTransportError(`BMP at ${this.bmpUrl} timed out`, 'timeout', attempts, undefined, { cause });
    }
    // An AbortError not caused by the caller is the combined deadline signal.
    if (cause instanceof DOMException && cause.name === 'AbortError') {
      return new BmpTransportError(`BMP at ${this.bmpUrl} timed out`, 'timeout', attempts, undefined, { cause });
    }
    if (cause instanceof TypeError) {
      return new BmpTransportError(`Cannot reach BMP at ${this.bmpUrl}`, 'network', attempts, undefined, { cause });
    }
    const message = cause instanceof Error ? cause.message : fallback;
    return new BmpTransportError(message || fallback, 'auth', attempts, undefined, { cause });
  }

  /** Send one or more serialized commands. Intent is mandatory: it is the
   *  replay-safety boundary for this transport. */
  async sendCommands(
    commands: any[],
    intent: CommandIntent,
    signal?: AbortSignal,
  ): Promise<ArrayBuffer> {
    return this.sendRequest(serializeCommands(commands), AUTH_TIMEOUT, intent, signal);
  }

  /** Send a streaming command (e.g. ExtendedExecuteCommand). `timeoutMs`
   *  widens the deadline for known-long reads/writes such as Blueprint. */
  async sendStreamingCommand(
    command: any,
    intent: CommandIntent,
    signal?: AbortSignal,
    timeoutMs?: number,
  ): Promise<any[]> {
    const buffer = await this.sendRequest(serializeCommands([command]), timeoutMs ?? EC_TIMEOUT, intent, signal);
    try {
      return deserializeStream(buffer);
    } catch (cause) {
      const error = new BmpTransportError('BMP protocol error while decoding command response', 'protocol', 1, undefined, { cause });
      this.emitOutcome({ ok: false, intent, error });
      throw error;
    }
  }

  /** Deserialize a response buffer with the same typed protocol boundary. */
  deserializeResponse(buffer: ArrayBuffer, intent: CommandIntent = 'read'): any {
    try {
      return deserializeResponse(buffer);
    } catch (cause) {
      const error = new BmpTransportError('BMP protocol error while decoding command response', 'protocol', 1, undefined, { cause });
      this.emitOutcome({ ok: false, intent, error });
      throw error;
    }
  }

  /** Deserialize a streaming response outside sendStreamingCommand (used by
   *  binary read commands that share the stream envelope). */
  deserializeStream(buffer: ArrayBuffer, intent: CommandIntent = 'read'): any[] {
    try {
      return deserializeStream(buffer);
    } catch (cause) {
      const error = new BmpTransportError('BMP protocol error while decoding command response', 'protocol', 1, undefined, { cause });
      this.emitOutcome({ ok: false, intent, error });
      throw error;
    }
  }

  /** Translate typed failures into concise user-facing messages. */
  formatError(e: unknown): string {
    if (e instanceof BmpTransportError) return e.message;
    if (e instanceof TypeError && (e.message.includes('fetch') || e.message.includes('network'))) {
      return `Cannot reach BMP at ${this.bmpUrl}`;
    }
    if (e instanceof DOMException && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
      return `BMP at ${this.bmpUrl} timed out`;
    }
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('Bad magic')) return 'Server response is not BMP binary: wrong URL or version mismatch';
    if (msg.includes('Unknown type code')) return 'BMP version mismatch: response contains unknown data types';
    if (msg.includes('Bad handle reference')) return 'BMP protocol error: possible version mismatch';
    return msg;
  }
}
