/**
 * Port lifecycle management for content script ↔ service worker communication.
 * Handles: connect, reconnect with backoff, pending queue, flush, send.
 */

import type { InspectorMessage } from './types';
import { log } from './logger';
import { RECONNECT_INITIAL_DELAY, RECONNECT_MAX_DELAY } from './constants';

let port: chrome.runtime.Port | null = null;
let reconnectDelay = RECONNECT_INITIAL_DELAY;
const pendingMessages: InspectorMessage[] = [];

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

/** Connect (or reconnect) the content port to the service worker */
export function connectPort(): void {
  try {
    port = chrome.runtime.connect({ name: 'content' });
    reconnectDelay = RECONNECT_INITIAL_DELAY;
  } catch (e) {
    log.swallow('port:connect', e);
    return;
  }

  port.onMessage.addListener((msg: InspectorMessage) => {
    messageHandler?.(msg);
  });

  flushPendingMessages();

  port.onDisconnect.addListener(() => {
    port = null;
    // Only retry if extension context is still valid
    try {
      chrome.runtime.getURL('');
      const wasDelayed = reconnectDelay > RECONNECT_INITIAL_DELAY;
      setTimeout(() => {
        connectPort();
        // Only fade labels on slow reconnects (not the initial quick one)
        if (wasDelayed) {
          for (const label of document.querySelectorAll<HTMLElement>('.crev-label')) {
            label.style.opacity = '0.4';
            setTimeout(() => { label.style.opacity = ''; }, 800);
          }
        }
        reconnectHandler?.();
      }, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_DELAY);
    } catch (e) {
      log.swallow('port:reconnectCheck', e);
    }
  });
}

/** Send a message to the service worker, with queue fallback for critical messages */
export function sendToSW(msg: InspectorMessage): void {
  if (port) {
    try { port.postMessage(msg); return; }
    catch (e) { log.swallow('port:send', e); port = null; }
  }
  // One-shot fallback for detection (works without port)
  if (msg.type === 'DETECTION_RESULT') {
    try { chrome.runtime.sendMessage(msg).catch(e => log.swallow('port:oneShot', e)); }
    catch (e) { log.swallow('port:oneShotOuter', e); }
  }
  // Queue critical messages for port-based delivery on reconnect
  if (msg.type === 'DETECTION_RESULT' || msg.type === 'OBJECTS_DISCOVERED') {
    // Keep only latest detection (replace older)
    if (msg.type === 'DETECTION_RESULT') {
      const idx = pendingMessages.findIndex(m => m.type === 'DETECTION_RESULT');
      if (idx >= 0) pendingMessages.splice(idx, 1);
    }
    // Merge consecutive OBJECTS_DISCOVERED by deduping RIDs
    if (msg.type === 'OBJECTS_DISCOVERED') {
      const last = pendingMessages[pendingMessages.length - 1];
      if (last?.type === 'OBJECTS_DISCOVERED') {
        const existing = new Set((last as any).objects.map((o: any) => o.rid));
        for (const obj of (msg as any).objects) {
          if (!existing.has(obj.rid)) (last as any).objects.push(obj);
        }
        return;
      }
    }
    pendingMessages.push(msg);
    // Cap queue to prevent unbounded growth
    while (pendingMessages.length > 20) pendingMessages.shift();
  }
}

function flushPendingMessages(): void {
  while (pendingMessages.length > 0) {
    const msg = pendingMessages.shift();
    try { port?.postMessage(msg); } catch (e) { log.swallow('port:flush', e); break; }
  }
}
