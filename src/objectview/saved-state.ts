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

/**
 * Remove only values that still match the transaction snapshot. A future
 * programmatic edit cannot be erased by a late save response.
 */
export function clearCommittedDraft(
  draft: Record<string, string>,
  resetDraft: Set<string>,
  committedDraft: Readonly<Record<string, string>>,
  committedResetProps: readonly string[],
): void {
  for (const [prop, value] of Object.entries(committedDraft)) {
    if (draft[prop] === value) delete draft[prop];
  }
  for (const prop of committedResetProps) resetDraft.delete(prop);
}
