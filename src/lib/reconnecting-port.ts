/**
 * Generic reconnecting chrome.runtime.Port primitive.
 *
 * Both the panel side (sidepanel/state.ts) and the content side
 * (lib/content-port.ts) need the same lifecycle: connect, retry with
 * exponential backoff on disconnect, queue critical messages while down,
 * flush on reconnect. The two only differ in:
 *   - which message types are worth queuing
 *   - how to merge consecutive enqueues of the same type
 *   - what to do after a delayed reconnect (e.g. fade overlay labels)
 *
 * All three are caller hooks. The lifecycle is owned here.
 */

import type { InspectorMessage } from './types';
import { log } from './logger';
import { RECONNECT_INITIAL_DELAY, RECONNECT_MAX_DELAY } from './constants';

export interface ReconnectingPortOptions {
  /** chrome.runtime.connect({ name }) */
  name: string;
  /** Called for each incoming SW message. */
  onMessage: (msg: InspectorMessage) => void;
  /** Called after a (re)connect; useful for re-syncing client state. */
  onReconnect?: (info: { wasDelayed: boolean }) => void;
  /**
   * Hook invoked when send() is called while the port is disconnected.
   * Mutate `queue` to enqueue / merge / replace (or do nothing to drop).
   * Default: drop the message.
   */
  enqueueOnDisconnect?: (queue: InspectorMessage[], msg: InspectorMessage) => void;
  /** Max queue size — older entries are evicted from the front. Default 20. */
  maxQueue?: number;
}

export interface ReconnectingPort {
  /** Send a message. Returns true if delivered to the port, false if the
   *  port was down (caller may then choose a one-shot fallback or accept
   *  the queueing semantics). */
  send: (msg: InspectorMessage) => boolean;
  /** Permanently tear down: cancel any pending reconnect, disconnect the
   *  live port, and detach the bfcache window listeners. Used by the
   *  content-script re-injection teardown so a stale instance's port
   *  doesn't keep reconnecting (and receiving INSPECT_STATE) alongside
   *  the fresh one. After destroy() the port is dead — send() no-ops. */
  destroy: () => void;
}

export function createReconnectingPort(opts: ReconnectingPortOptions): ReconnectingPort {
  const ctx = `port:${opts.name}`;
  const maxQueue = opts.maxQueue ?? 20;
  const queue: InspectorMessage[] = [];

  let port: chrome.runtime.Port | null = null;
  let reconnectDelay = RECONNECT_INITIAL_DELAY;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let destroyed = false;

  function scheduleReconnect(reason: 'initial' | 'disconnect'): void {
    if (destroyed) return;
    const wasDelayed = reconnectDelay > RECONNECT_INITIAL_DELAY;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      connect();
      if (reason === 'disconnect') opts.onReconnect?.({ wasDelayed });
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_DELAY);
  }

  function connect(): void {
    if (destroyed) return;
    try {
      port = chrome.runtime.connect({ name: opts.name });
      reconnectDelay = RECONNECT_INITIAL_DELAY;
    } catch (e) {
      // chrome.runtime.connect can throw synchronously during SW restart or
      // extension reload. Without rescheduling, portInstance stays non-null
      // with a dead inner port and queues silently forever.
      log.swallow(`${ctx}:connect`, e);
      scheduleReconnect('initial');
      return;
    }

    port.onMessage.addListener((msg: InspectorMessage) => opts.onMessage(msg));

    // Flush queued messages
    while (queue.length > 0 && port) {
      const msg = queue.shift()!;
      try { port.postMessage(msg); }
      catch (e) { log.swallow(`${ctx}:flush`, e); port = null; break; }
    }

    // The catch above can null `port` mid-flush; bail if so.
    if (!port) return;
    port.onDisconnect.addListener(() => {
      // Chrome surfaces an unchecked `runtime.lastError` to the console
      // when a port closes due to: extension reload, SW restart, OR the
      // page entering bfcache. Touching the property clears it without
      // logging anything — we don't actually care which of the three
      // happened; the reconnect path covers all of them. Without this
      // read, users see
      //   "Unchecked runtime.lastError: The page keeping the extension
      //    port is moved into back/forward cache, so the message
      //    channel is closed"
      // whenever the browser caches the BMP tab via back/forward.
      void chrome.runtime.lastError;
      port = null;
      scheduleReconnect('disconnect');
    });
  }

  function send(msg: InspectorMessage): boolean {
    if (destroyed) return false;
    if (port) {
      try { port.postMessage(msg); return true; }
      catch (e) { log.swallow(`${ctx}:send`, e); port = null; }
    }
    // Port is down — let the caller decide whether to queue
    if (opts.enqueueOnDisconnect) {
      opts.enqueueOnDisconnect(queue, msg);
      while (queue.length > maxQueue) queue.shift();
    }
    return false;
  }

  // ── bfcache lifecycle (proactive close + restore) ──────────────
  //
  // An open chrome.runtime port disqualifies the page from bfcache, so
  // Chrome force-closes the port AND logs an unchecked-lastError to the
  // user's console when it moves the page into the cache. The
  // `void chrome.runtime.lastError` above silences the message AFTER
  // the fact; the listeners below preempt the close ourselves so the
  // bfcache transition is graceful from both Chrome's and our side.
  //
  // `pagehide` with `persisted === true` is Chrome's "I'm about to
  // bfcache this page" signal. Tear down the port voluntarily —
  // saves Chrome the forced-close + warning. We still get
  // onDisconnect → scheduleReconnect, but the reconnect timer
  // is paused with the rest of the page until pageshow.
  const onPageHide = (e: PageTransitionEvent) => {
    if (!e.persisted) return;
    try { port?.disconnect(); } catch { /* port already gone */ }
    port = null;
  };
  // `pageshow` with `persisted === true` fires when the page comes
  // BACK from bfcache. Frozen timers resume, but we kick the
  // reconnect immediately so panel/content don't sit in the
  // "disconnected" state for the leftover delay.
  const onPageShow = (e: PageTransitionEvent) => {
    if (!e.persisted) return;
    if (port) return; // already reconnected somehow
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectDelay = RECONNECT_INITIAL_DELAY;
    connect();
    opts.onReconnect?.({ wasDelayed: false });
  };
  // Wrapped in a `typeof addEventListener === 'function'` check so this
  // file stays usable in worker contexts (the SW imports the same
  // primitive — there's no DOM there).
  const hasDom = typeof addEventListener === 'function';
  if (hasDom) {
    addEventListener('pagehide', onPageHide);
    addEventListener('pageshow', onPageShow);
  }

  function destroy(): void {
    destroyed = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = undefined; }
    try { port?.disconnect(); } catch { /* already gone */ }
    port = null;
    if (hasDom) {
      removeEventListener('pagehide', onPageHide);
      removeEventListener('pageshow', onPageShow);
    }
  }

  connect();
  return { send, destroy };
}
