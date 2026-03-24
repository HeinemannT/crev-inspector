/**
 * Handler registry — maps message types to handler functions.
 * Domain modules call register() at import time. The router dispatches.
 *
 * To add a new message handler:
 *   1. Create or edit a file in handlers/
 *   2. Call register('MY_TYPE', handler) or register('MY_TYPE', handler, true) for async response
 *   3. Import the handler file from message-router.ts
 */

import type { InspectorMessage } from './types';

export interface HandlerMeta {
  senderTabId?: number;
  isOneShot: boolean;
}

export type Handler = (
  msg: InspectorMessage,
  respond: (r: any) => void,
  meta: HandlerMeta,
) => void | Promise<void>;

interface Entry {
  handler: Handler;
  async: boolean; // true = handler calls respond() asynchronously (one-shot must return true)
}

const registry = new Map<string, Entry>();

/** Register a handler for one or more message types. */
export function register(types: string | string[], handler: Handler, async = false) {
  for (const t of Array.isArray(types) ? types : [types]) {
    registry.set(t, { handler, async });
  }
}

/** Look up a handler entry by message type. */
export function getHandler(type: string): Entry | undefined {
  return registry.get(type);
}
