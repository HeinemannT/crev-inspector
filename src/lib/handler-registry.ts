/**
 * Handler registry — owns two parallel maps:
 *
 *   - REQUEST handlers (`register()`): one handler per message type, request/
 *     response. Used by the SW to dispatch FETCH_*, SAVE_*, EC_EXECUTE, etc.
 *     Exactly one handler per type; later registrations replace earlier ones.
 *
 *   - BROADCAST subscribers (`subscribe()`): zero or more listeners per type,
 *     fire-and-forget. Used by content + sidepanel to consume one-way state
 *     pushes (CONNECTION_STATE, ACTIVITY_ENTRY, …). Subscribers
 *     for the same type all run; order is registration order.
 *
 * The two halves were previously a single registry plus raw `onPortMessage`
 * switches. The switches still own routing precedence (reference > detail >
 * shared-state > tab) — they can't trivially be replaced by a registry. The
 * subscribe API lets feature modules opt into the registry pattern for any
 * new broadcasts they introduce, so a renamed message type doesn't silently
 * stop reaching its consumer.
 *
 * To add a new message handler:
 *   1. Create or edit a file in handlers/
 *   2. Call register('MY_TYPE', handler) for request/response, or
 *      subscribe(['MY_TYPE'], listener) for a broadcast subscription.
 *   3. Import the handler file from message-router.ts so register() runs.
 *
 * The one-shot router always keeps the message port open (returns true);
 * handlers don't need to declare sync/async — call respond() whenever ready.
 */

import type { InspectorMessage } from './types';

export interface HandlerMeta {
  senderTabId?: number;
  /** Window the calling panel lives in. Set when the message came from
   *  a panel port that has completed PANEL_HELLO. Handlers that resolve
   *  "the user's active BMP tab" should query this windowId instead of
   *  lastFocusedWindow — that's the whole point of the multi-window
   *  panel refactor. */
  panelWindowId?: number;
  isOneShot: boolean;
}

export type Handler = (
  msg: InspectorMessage,
  respond: (r: InspectorMessage) => void,
  meta: HandlerMeta,
) => void | Promise<void>;

/** A typed handler whose `msg` parameter is narrowed to the matching
 *  variant of `InspectorMessage`. Used by the generic `register<T>()`
 *  below so call sites get `msg.<field>` autocompletion without per-
 *  handler casts. */
export type TypedHandler<T extends InspectorMessage['type']> = (
  msg: Extract<InspectorMessage, { type: T }>,
  respond: (r: InspectorMessage) => void,
  meta: HandlerMeta,
) => void | Promise<void>;

/** Broadcast listeners are simpler — no respond, no meta, just the message. */
export type BroadcastListener = (msg: InspectorMessage) => void;

const registry = new Map<string, Handler>();
const broadcastRegistry = new Map<string, BroadcastListener[]>();

/** Register a handler for a single message type. Type parameter `T`
 *  flows from the string literal to the handler's `msg` parameter, so
 *  `register('NAVIGATE_BMP', (msg) => msg.rid)` typechecks without
 *  the handler needing to narrow with `'rid' in msg`. */
export function register<T extends InspectorMessage['type']>(
  type: T,
  handler: TypedHandler<T>,
): void;
/** Multi-type register — narrow only to the union of those types. */
export function register<T extends InspectorMessage['type']>(
  types: T[],
  handler: TypedHandler<T>,
): void;
/** Test-only escape hatch — accept arbitrary string types so unit
 *  tests can exercise the registry with synthetic message names that
 *  aren't in the production union. */
export function register(types: string | string[], handler: Handler): void;
export function register(types: string | string[], handler: Handler): void {
  for (const t of Array.isArray(types) ? types : [types]) {
    registry.set(t, handler);
  }
}

/** Look up a handler by message type. */
export function getHandler(type: string): Handler | undefined {
  return registry.get(type);
}

/** Subscribe to a broadcast message type. Multiple subscribers are allowed
 *  for the same type; all run on dispatch. Returns an unsubscribe function. */
export function subscribe(types: string | string[], listener: BroadcastListener): () => void {
  const typeList = Array.isArray(types) ? types : [types];
  for (const t of typeList) {
    const list = broadcastRegistry.get(t) ?? [];
    list.push(listener);
    broadcastRegistry.set(t, list);
  }
  return () => {
    for (const t of typeList) {
      const list = broadcastRegistry.get(t);
      if (!list) continue;
      const idx = list.indexOf(listener);
      if (idx >= 0) list.splice(idx, 1);
      if (list.length === 0) broadcastRegistry.delete(t);
    }
  };
}

/** Fan out a broadcast message to every subscribed listener. Returns the
 *  number of listeners that ran — caller can use it to detect "nobody
 *  cared about this message" cases during development. */
export function dispatchBroadcast(msg: InspectorMessage): number {
  const list = broadcastRegistry.get(msg.type);
  if (!list || list.length === 0) return 0;
  for (const listener of list) {
    try { listener(msg); } catch { /* one listener's error shouldn't break others */ }
  }
  return list.length;
}
