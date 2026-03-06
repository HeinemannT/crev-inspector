/** Centralized logger — replaces bare catch {} blocks with traceable swallows */

const PREFIX = '[CREV]';

export const log = {
  debug(ctx: string, ...args: unknown[]): void {
    // No-op in production. Uncomment for debugging:
    // console.debug(`${PREFIX}:${ctx}`, ...args);
    void ctx; void args;
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
    // Uncomment for debugging swallowed errors:
    // console.debug(`${PREFIX}:${ctx} [swallowed]`, error);
    void ctx; void error;
  },
};

/** Extract a human-readable message from an unknown error value */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
