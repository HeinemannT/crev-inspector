export type LostSaveState = 'confirmed' | 'confirmed-with-newer-edits' | 'mismatch' | 'unverified'

/** Classify a save whose message response disappeared after the request left
 *  the editor. `stored` must come from a fresh BMP read, not local cache. */
export function reconcileLostSave(attempted: string, current: string, stored: string | undefined): LostSaveState {
  if (stored === undefined) return 'unverified'
  if (stored !== attempted) return 'mismatch'
  return current === attempted ? 'confirmed' : 'confirmed-with-newer-edits'
}
