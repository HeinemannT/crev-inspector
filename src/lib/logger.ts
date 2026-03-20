/** Centralized logger — replaces bare catch {} blocks with traceable swallows */

const PREFIX = '[CREV]';

export const log = {
  debug(ctx: string, ...args: unknown[]): void {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('crev_debug')) {
      console.debug(`${PREFIX}:${ctx}`, ...args);
    }
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

  /** Swallow an error — logs at debug level for tracing, silent in normal operation */
  swallow(ctx: string, error: unknown): void {
    if (typeof localStorage !== 'undefined' && localStorage.getItem('crev_debug')) {
      console.debug(`${PREFIX}:${ctx} [swallowed]`, error);
    }
  },
};

/** Extract a human-readable message from an unknown error value */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
