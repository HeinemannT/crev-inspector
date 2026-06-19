/**
 * Content script ↔ service worker port. Thin shim over the shared
 * reconnecting-port primitive — defines content-script-specific queue
 * semantics (merge OBJECTS_DISCOVERED / ENRICH_BADGES, replace stale
 * DETECTION_RESULT) and the slow-reconnect label fade.
 */

import type { InspectorMessage } from './types';
import { log } from './logger';
import { createReconnectingPort, type ReconnectingPort } from './reconnecting-port';

let portInstance: ReconnectingPort | null = null;
let messageHandler: ((msg: InspectorMessage) => void) | null = null;
let reconnectHandler: (() => void) | null = null;

/** Register handler for incoming SW messages (called once at init) */
export function onPortMessage(handler: (msg: InspectorMessage) => void): void {
  messageHandler = handler;
}

/** Register handler called after successful reconnect (for re-sync) */
export function onReconnect(handler: () => void): void {
  reconnectHandler = handler;
}

/** Content-script-specific enqueue: dedup OBJECTS_DISCOVERED / ENRICH_BADGES,
 *  replace stale DETECTION_RESULT and BMP_URL_CHANGED, drop everything else. */
function enqueue(queue: InspectorMessage[], msg: InspectorMessage): void {
  if (msg.type === 'DETECTION_RESULT') {
    // Replace any prior detection — only the latest matters
    const idx = queue.findIndex(m => m.type === 'DETECTION_RESULT');
    if (idx >= 0) queue.splice(idx, 1);
    queue.push(msg);
    return;
  }
  if (msg.type === 'BMP_URL_CHANGED') {
    // Coalesce — the panel only needs one refresh trigger after reconnect,
    // even if the user clicked through several BMP tabs while we were down.
    if (queue.some(m => m.type === 'BMP_URL_CHANGED')) return;
    queue.push(msg);
    return;
  }
  if (msg.type === 'OBJECTS_DISCOVERED') {
    const last = queue[queue.length - 1];
    if (last?.type === 'OBJECTS_DISCOVERED') {
      const existing = new Set(last.objects.map(o => o.rid));
      for (const obj of msg.objects) {
        if (!existing.has(obj.rid)) last.objects.push(obj);
      }
      return;
    }
    queue.push(msg);
    return;
  }
  if (msg.type === 'ENRICH_BADGES') {
    const last = queue[queue.length - 1];
    if (last?.type === 'ENRICH_BADGES') {
      const existing = new Set(last.rids);
      for (const rid of msg.rids) {
        if (!existing.has(rid)) last.rids.push(rid);
      }
      return;
    }
    queue.push(msg);
    return;
  }
  // Other message types are dropped while disconnected.
}

/** Permanently tear down the content port — used by the re-injection
 *  teardown so a stale content-script instance's port stops reconnecting
 *  (and receiving INSPECT_STATE) once a fresh instance has taken over.
 *  Idempotent; connectPort() can rebuild afterwards. */
export function disconnectPort(): void {
  portInstance?.destroy();
  portInstance = null;
  messageHandler = null;
  reconnectHandler = null;
}

/** Connect (or reconnect) the content port to the service worker */
export function connectPort(): void {
  if (portInstance) return; // idempotent
  portInstance = createReconnectingPort({
    name: 'content',
    onMessage: (msg) => messageHandler?.(msg),
    onReconnect: ({ wasDelayed }) => {
      if (wasDelayed) {
        // Fade overlay labels briefly so users notice the gap
        for (const label of document.querySelectorAll<HTMLElement>('.crev-label')) {
          label.style.opacity = '0.4';
          setTimeout(() => { label.style.opacity = ''; }, 800);
        }
      }
      reconnectHandler?.();
    },
    enqueueOnDisconnect: enqueue,
  });
}

/** Messages worth retrying via the one-shot runtime channel when the port
 *  is down. State-syncing signals (detection result, SPA URL change) go
 *  here — others are correctly queued or dropped via enqueue() above. */
const ONE_SHOT_FALLBACKS: ReadonlySet<InspectorMessage['type']> = new Set([
  'DETECTION_RESULT',
  'BMP_URL_CHANGED',
]);

/** Send a message to the service worker. If the port is down and the message
 *  is in ONE_SHOT_FALLBACKS, fall back to chrome.runtime.sendMessage so the
 *  SW still hears about state changes even before our port wakes. */
export function sendToSW(msg: InspectorMessage): void {
  const delivered = portInstance?.send(msg) ?? false;
  if (!delivered && ONE_SHOT_FALLBACKS.has(msg.type)) {
    try { chrome.runtime.sendMessage(msg).catch(e => log.swallow('content-port:oneShot', e)); }
    catch (e) { log.swallow('content-port:oneShotOuter', e); }
  }
}
