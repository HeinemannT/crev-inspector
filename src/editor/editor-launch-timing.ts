import type { EditorLaunchTiming } from './editor-types';

export interface EditorLaunchPhases {
  totalMs: number;
  settingsMs: number;
  targetMs: number;
  placeholderMs: number;
  frameMountMs: number;
  contextMs: number;
  publishToAdoptMs: number;
  editorBootMs: number;
}

const elapsed = (end: number, start: number): number => Math.max(0, Math.round(end - start));

/** Convert cross-context wall-clock milestones into redacted, low-cardinality
 * durations. Only phase names and elapsed milliseconds leave the editor. */
export function editorLaunchPhases(
  timing: EditorLaunchTiming,
  adoptedAt: number,
  editorReadyAt: number,
): EditorLaunchPhases {
  return {
    totalMs: elapsed(editorReadyAt, timing.requestedAt),
    settingsMs: elapsed(timing.settingsReadyAt, timing.requestedAt),
    targetMs: elapsed(timing.targetResolvedAt, timing.settingsReadyAt),
    placeholderMs: elapsed(timing.placeholderStoredAt, timing.targetResolvedAt),
    frameMountMs: elapsed(timing.frameMountedAt, timing.placeholderStoredAt),
    contextMs: elapsed(timing.contextFinishedAt, timing.contextStartedAt),
    publishToAdoptMs: elapsed(adoptedAt, timing.publishStartedAt),
    // The iframe script can load in parallel with the BMP query. Count only
    // the critical-path work after context adoption so this phase neither
    // overlaps context/publish nor makes the breakdown exceed totalMs.
    editorBootMs: elapsed(editorReadyAt, adoptedAt),
  };
}
