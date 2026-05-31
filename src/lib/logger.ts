/** Centralized logger — replaces bare catch {} blocks with traceable swallows.
 *
 *  Debug-level output (debug / swallow) is gated on a flag that lives in:
 *    - `localStorage.crev_debug` for window contexts (panel, editor, etc.)
 *    - `chrome.storage.session.crev_debug` for the service worker (no localStorage)
 *
 *  The flag is read once at module load; toggle then reload. Toggle via the
 *  console: `chrome.storage.session.set({crev_debug:'1'})` in the SW DevTools,
 *  or `localStorage.crev_debug='1'` anywhere else.
 */

const PREFIX = '[CREV]';

let debugEnabled = false;

// Synchronous read for window contexts; async warm-up for SW.
try {
  if (typeof localStorage !== 'undefined') {
    debugEnabled = !!localStorage.getItem('crev_debug');
  }
} catch { /* ignore — security errors on cross-origin storage */ }

try {
  // chrome.storage may not exist in test/Node environments.
  const session = (globalThis as { chrome?: typeof chrome }).chrome?.storage?.session;
  if (session) {
    session.get('crev_debug').then(r => {
      if (r?.crev_debug) debugEnabled = true;
    }).catch(() => {});
  }
} catch { /* ignore */ }

export const log = {
  debug(ctx: string, ...args: unknown[]): void {
    if (debugEnabled) console.debug(`${PREFIX}:${ctx}`, ...args);
  },

  info(ctx: string, ...args: unknown[]): void {
    console.info(`${PREFIX}:${ctx}`, ...args);
  },

  warn(ctx: string, error?: unknown, ...args: unknown[]): void {
    console.warn(`${PREFIX}:${ctx}`, error, ...args);
  },

  error(ctx: string, error?: unknown, ...args: unknown[]): void {
    console.error(`${PREFIX}:${ctx}`, error, ...args);
  },

  /** Swallow an error — debug-level when debug enabled, silent otherwise. */
  swallow(ctx: string, error: unknown): void {
    if (debugEnabled) console.debug(`${PREFIX}:${ctx} [swallowed]`, error);
  },
};

/** Extract a human-readable message from an unknown error value */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
