/** Reconcile BMP's explicit instance-override set after a confirmed save.
 *
 * A normal instance property write creates/keeps an override. A reset removes
 * it. Keeping this local state current makes the purple reset arrow respond
 * immediately instead of waiting for another object-pane fetch.
 */
export function reconcileInstanceOverrides(
  current: readonly string[],
  changedProps: readonly string[],
  resetProps: readonly string[],
): string[] {
  const next = new Set(current);
  for (const prop of changedProps) next.add(prop);
  for (const prop of resetProps) next.delete(prop);
  return [...next];
}

/** Remove only inheritance resets included in the submitted transaction. */
export function clearCommittedResets(resetDraft: Set<string>, committedResetProps: readonly string[]): void {
  for (const prop of committedResetProps) resetDraft.delete(prop);
}
