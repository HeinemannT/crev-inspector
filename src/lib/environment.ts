import type { SwContext } from './sw-context';

export const ENVIRONMENT_CHANGED_ERROR =
  'The active BMP environment changed after this view was opened. Reload this view before saving.';

/** Stable identity for the currently active BMP profile and resolved server. */
export function environmentToken(ctx: SwContext): string {
  return `${ctx.settings?.activeProfileId ?? ''}@${ctx.client?.serverUrl ?? ''}`;
}

export function environmentMatches(ctx: SwContext, expected: string | undefined): boolean {
  if (expected) return expected === environmentToken(ctx);
  // Unit-test and migration harnesses may provide a deliberately partial
  // SwContext. A real service worker always has an activeProfileId; there,
  // omitting the token remains a hard failure.
  return !ctx.settings?.activeProfileId;
}
