/**
 * Save -> reload reconciliation — the decision logic, kept pure so it can be
 * unit-tested without a DOM or a live CodeSurface.
 *
 * After a save commits, the studio re-reads the object from BMP to confirm what
 * actually landed (a BMP in-script .change() can return HTTP 200 yet silently
 * roll back). This decides, per saved field:
 *  - rollback: the server value differs from what we wrote -> warn the user.
 *  - reload:   re-seed the editor slot from the server value, but ONLY when the
 *              user hasn't re-edited that field during the (awaited) round-trips
 *              — re-seeding a now-dirty slot would silently discard their edit.
 */
import type { StudioCodeProp } from './studio-types'

export interface SaveReconcileResult {
  /** Slots to re-seed from the server-canonical text (key + its fresh code). */
  reload: Array<{ key: StudioCodeProp; code: string }>
  /** Saved props whose re-fetched value differs from what we wrote. */
  rollbacks: StudioCodeProp[]
}

export function reconcileSavedSlots(
  savedValues: Map<StudioCodeProp, string>,
  fresh: Record<string, string>,
  isDirty: (key: StudioCodeProp) => boolean,
): SaveReconcileResult {
  const reload: SaveReconcileResult['reload'] = []
  const rollbacks: StudioCodeProp[] = []
  for (const [p, value] of savedValues) {
    if ((fresh[p] ?? '') !== value) rollbacks.push(p)
    if (!isDirty(p)) reload.push({ key: p, code: fresh[p] ?? '' })
  }
  return { reload, rollbacks }
}
