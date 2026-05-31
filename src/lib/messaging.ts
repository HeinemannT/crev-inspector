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
