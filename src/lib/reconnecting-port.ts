/**
 * Generic reconnecting chrome.runtime.Port primitive.
 *
 * Both the panel side (sidepanel/state.ts) and the content side
 * (lib/content-port.ts) need the same lifecycle: connect, retry with
 * exponential backoff on disconnect, queue critical messages while down,
 * flush on reconnect. The two only differ in:
 *   - which message types are worth queuing
 *   - how to merge consecutive enqueues of the same type
 *   - what to do after a successful reconnect
 *
 * All three are caller hooks. The lifecycle is owned here.
 */

import type { InspectorMessage } from './types';
import { log } from './logger';
import { RECONNECT_INITIAL_DELAY, RECONNECT_MAX_DELAY } from './constants';
import { traceConnectionDiagnostic } from './connection-trace';

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
  let attemptGeneration = 0;
  let hasConnected = false;
  let reconnectWasDelayed = false;
  let bfcachePaused = false;

  const isInvalidated = (value: unknown): boolean => {
    const message = value instanceof Error
      ? value.message
      : typeof value === 'object' && value !== null && 'message' in value
        ? String((value as { message?: unknown }).message ?? '')
        : String(value ?? '');
    return /extension context invalidated/i.test(message);
  };

  function scheduleReconnect(): void {
    if (destroyed || bfcachePaused || reconnectTimer) return;
    reconnectWasDelayed ||= reconnectDelay > RECONNECT_INITIAL_DELAY;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect(true);
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_DELAY);
  }

  function connect(isReconnect = false): void {
    if (destroyed || bfcachePaused) return;
    const generation = ++attemptGeneration;
    let candidate: chrome.runtime.Port;
    try {
      candidate = chrome.runtime.connect({ name: opts.name });
    } catch (e) {
      // chrome.runtime.connect can throw synchronously during SW restart or
      // extension reload. Without rescheduling, portInstance stays non-null
      // with a dead inner port and queues silently forever.
      log.swallow(`${ctx}:connect`, e);
      // An old content-script world can never reconnect after an extension reload. The newly injected
      // world owns the replacement port, so stop this instance instead of retrying forever.
      if (isInvalidated(e)) { destroy(); return; }
      scheduleReconnect();
      return;
    }

    port = candidate;
    candidate.onMessage.addListener((msg: InspectorMessage) => {
      if (!destroyed && generation === attemptGeneration && port === candidate) opts.onMessage(msg);
    });

    candidate.onDisconnect.addListener(() => {
      // Every callback is bound to its concrete Port + attempt. A late
      // disconnect from a superseded attempt must not null or reconnect the
      // current one.
      if (destroyed || generation !== attemptGeneration || port !== candidate) return;
      let disconnectError: unknown;
      try { disconnectError = chrome.runtime.lastError; }
      catch (e) { if (isInvalidated(e)) { destroy(); return; } }
      if (isInvalidated(disconnectError)) { destroy(); return; }
      port = null;
      traceConnectionDiagnostic({ source: 'port', portName: opts.name, attempt: generation, decision: 'disconnect:retry' });
      scheduleReconnect();
    });

    // Flush queued messages
    while (queue.length > 0 && port === candidate) {
      const msg = queue.shift()!;
      try { candidate.postMessage(msg); }
      catch (e) {
        log.swallow(`${ctx}:flush`, e);
        queue.unshift(msg);
        if (port === candidate) port = null;
        if (isInvalidated(e)) { destroy(); return; }
        scheduleReconnect();
        return;
      }
    }

    // Readiness for this primitive means listeners are attached and the
    // declared idempotent queue flushed successfully. Reset backoff only here,
    // never merely because runtime.connect() returned a Port object.
    if (destroyed || generation !== attemptGeneration || port !== candidate) return;
    reconnectDelay = RECONNECT_INITIAL_DELAY;
    traceConnectionDiagnostic({ source: 'port', portName: opts.name, attempt: generation, decision: 'ready' });
    const notifyReconnect = hasConnected || isReconnect;
    hasConnected = true;
    if (notifyReconnect) {
      const wasDelayed = reconnectWasDelayed;
      reconnectWasDelayed = false;
      opts.onReconnect?.({ wasDelayed });
    }
  }

  function send(msg: InspectorMessage): boolean {
    if (destroyed) return false;
    if (port) {
      try { port.postMessage(msg); return true; }
      catch (e) {
        log.swallow(`${ctx}:send`, e);
        const failedPort = port;
        port = null;
        attemptGeneration++;
        if (isInvalidated(e)) { destroy(); return false; }
        try { failedPort.disconnect(); } catch { /* already gone */ }
        scheduleReconnect();
      }
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
  // Chrome 123+ closes extension channels when a page enters BFCache. Pause
  // retries on pagehide and make persisted pageshow the single reconnect
  // owner, so a resumed timer and the lifecycle event cannot double-connect.
  const onPageHide = (e: PageTransitionEvent) => {
    if (!e.persisted) return;
    bfcachePaused = true;
    attemptGeneration++;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = undefined; }
    const hiddenPort = port;
    port = null;
    try { hiddenPort?.disconnect(); } catch { /* port already gone */ }
  };
  // `pageshow` with `persisted === true` fires when the page comes
  // BACK from bfcache. Frozen timers resume, but we kick the
  // reconnect immediately so panel/content don't sit in the
  // "disconnected" state for the leftover delay.
  const onPageShow = (e: PageTransitionEvent) => {
    if (!e.persisted) return;
    if (!bfcachePaused || port) return;
    bfcachePaused = false;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = undefined; }
    reconnectDelay = RECONNECT_INITIAL_DELAY;
    reconnectWasDelayed = false;
    connect(true);
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
    attemptGeneration++;
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
