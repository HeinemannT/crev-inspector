/**
 * Unified messaging helpers for one-shot communication with the service
 * worker. Used by extension pages (editor / diff / objectview / codesearch /
 * sidepanel) and by content-script overlays that don't sit on the
 * persistent port. The content-script port itself lives in content-port.ts
 * because it has its own queueing/merging semantics.
 *
 * Both helpers swallow errors at debug level — by the time a one-shot send
 * fails the user has usually navigated or closed the surface. Callers that
 * need a hard guarantee should await sendRequest and inspect the response.
 */

import type { InspectorMessage } from './types';
import { log } from './logger';

/** Fire-and-forget message to the service worker. Use for actions that
 *  don't need a response (OPEN_EDITOR, TOGGLE_FAVORITE, navigation, etc.). */
export function sendFireForget(msg: InspectorMessage): void {
  try {
    chrome.runtime.sendMessage(msg).catch(e => log.swallow('messaging:sendFireForget', e));
  } catch (e) {
    log.swallow('messaging:sendFireForgetOuter', e);
  }
}

/** Request-response one-shot. Returns the SW's reply; undefined on error
 *  or when the SW doesn't reply. Caller is responsible for narrowing the
 *  response shape (typed as the InspectorMessage union; usually a
 *  *_RESULT / *_DATA discriminant). */
export async function sendRequest<R extends InspectorMessage = InspectorMessage>(
  msg: InspectorMessage,
): Promise<R | undefined> {
  try {
    return await chrome.runtime.sendMessage(msg) as R | undefined;
  } catch (e) {
    log.swallow('messaging:sendRequest', e);
    return undefined;
  }
}

export type RequestFailureKind = 'timeout' | 'cancelled' | 'runtime' | 'no-response';

export class RuntimeRequestError extends Error {
  constructor(
    message: string,
    readonly kind: RequestFailureKind,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'RuntimeRequestError';
  }
}

export interface BoundedRequestOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

/** Bounded one-shot request for user-visible data loads. Chrome does not let
 *  callers cancel work already running in the service worker, so abort/timeout
 *  stop waiting locally; callers that own a matching CANCEL_* message should
 *  send it as well. Late replies are ignored by Promise settlement. */
export async function sendRequestBounded<R extends InspectorMessage = InspectorMessage>(
  msg: InspectorMessage,
  options: BoundedRequestOptions,
): Promise<R> {
  if (options.signal?.aborted) {
    throw new RuntimeRequestError('Request cancelled', 'cancelled');
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  let abortHandler: (() => void) | null = null;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new RuntimeRequestError('Request timed out', 'timeout')),
      options.timeoutMs,
    );
    if (options.signal) {
      abortHandler = () => reject(new RuntimeRequestError('Request cancelled', 'cancelled'));
      options.signal.addEventListener('abort', abortHandler, { once: true });
    }
  });

  try {
    let response: R | undefined;
    try {
      response = await Promise.race([
        chrome.runtime.sendMessage(msg) as Promise<R | undefined>,
        deadline,
      ]);
    } catch (cause) {
      if (cause instanceof RuntimeRequestError) throw cause;
      throw new RuntimeRequestError(
        cause instanceof Error ? cause.message : 'Extension service worker unavailable',
        'runtime',
        { cause },
      );
    }
    if (response === undefined) {
      throw new RuntimeRequestError('Extension service worker did not respond', 'no-response');
    }
    return response;
  } finally {
    if (timer) clearTimeout(timer);
    if (options.signal && abortHandler) options.signal.removeEventListener('abort', abortHandler);
  }
}
