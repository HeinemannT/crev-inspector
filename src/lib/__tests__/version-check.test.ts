/**
 * Unit tests for the semver comparator that drives the in-panel update banner.
 *
 * Bugs in `isNewer` would either nag users that they're behind when they
 * aren't, or fail to surface a real update — both undermine trust in the
 * banner, so this gets dedicated coverage.
 */
import { describe, it, expect } from 'vitest';
import { isNewer } from '../version-check';

describe('isNewer (semver comparator)', () => {
  describe('equal versions', () => {
    it('returns false for identical strings', () => {
      expect(isNewer('0.17.5', '0.17.5')).toBe(false);
    });

    it('treats missing patch as zero (0.17 == 0.17.0)', () => {
      expect(isNewer('0.17', '0.17.0')).toBe(false);
      expect(isNewer('0.17.0', '0.17')).toBe(false);
    });
  });

  describe('strict ordering', () => {
    it('detects patch bump', () => {
      expect(isNewer('0.17.6', '0.17.5')).toBe(true);
      expect(isNewer('0.17.5', '0.17.6')).toBe(false);
    });

    it('detects minor bump', () => {
      expect(isNewer('0.18.0', '0.17.99')).toBe(true);
      expect(isNewer('0.17.99', '0.18.0')).toBe(false);
    });

    it('detects major bump', () => {
      expect(isNewer('1.0.0', '0.99.99')).toBe(true);
      expect(isNewer('0.99.99', '1.0.0')).toBe(false);
    });

    it('handles two-digit segments without lexical fallback', () => {
      // "10" < "9" lexically — would break a string comparator. Numeric
      // parsing is the only correct answer here.
      expect(isNewer('0.10.0', '0.9.0')).toBe(true);
      expect(isNewer('0.9.0', '0.10.0')).toBe(false);
    });
  });

  describe('malformed input', () => {
    it('treats non-numeric segments as zero', () => {
      // GitHub release tags sometimes carry weird suffixes — we don't ship
      // them, but parsing shouldn't throw. NaN || 0 → 0, so the comparison
      // collapses to whichever side has more numeric content.
      expect(isNewer('0.17.5-beta', '0.17.5')).toBe(false);
      expect(isNewer('garbage', '0.17.5')).toBe(false);
    });

    it("doesn't crash on empty strings", () => {
      expect(() => isNewer('', '0.17.5')).not.toThrow();
      expect(isNewer('', '0.17.5')).toBe(false);
    });
  });
});
