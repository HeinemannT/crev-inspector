import { describe, expect, it } from 'vitest';
import { editorLaunchPhases } from '../editor-launch-timing';

describe('editor launch timing', () => {
  it('reports non-overlapping launcher, context, handoff, and editor-boot phases', () => {
    expect(editorLaunchPhases({
      requestedAt: 100,
      settingsReadyAt: 110,
      targetResolvedAt: 130,
      placeholderStoredAt: 135,
      frameMountedAt: 150,
      contextStartedAt: 152,
      contextFinishedAt: 190,
      publishStartedAt: 195,
    }, 205, 230)).toEqual({
      totalMs: 130,
      settingsMs: 10,
      targetMs: 20,
      placeholderMs: 5,
      frameMountMs: 15,
      contextMs: 38,
      publishToAdoptMs: 10,
      editorBootMs: 25,
    });
  });

  it('clamps clock skew and missing early-script time to low-cardinality non-negative values', () => {
    const phases = editorLaunchPhases({
      requestedAt: 200,
      settingsReadyAt: 190,
      targetResolvedAt: 180,
      placeholderStoredAt: 170,
      frameMountedAt: 160,
      contextStartedAt: 150,
      contextFinishedAt: 140,
      publishStartedAt: 130,
    }, 120, 110);
    expect(Object.values(phases).every(value => value === 0)).toBe(true);
  });
});
