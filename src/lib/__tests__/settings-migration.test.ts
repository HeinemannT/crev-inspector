/**
 * Tests for migrateStoredSettings — the v0→v1→v2 schema migration. Pinning this
 * matters: a regression silently reshapes or drops the user's saved profiles.
 */
import { describe, it, expect } from 'vitest';
import { migrateStoredSettings } from '../settings';

describe('migrateStoredSettings', () => {
  it('v0 flat fields → v1 profile → v2 authMode, in one pass', () => {
    const s: any = { bmpUrl: 'https://x/Ws/', bmpUser: 'admin', bmpPass: 'enc:secret' };
    const changed = migrateStoredSettings(s);
    expect(changed).toBe(true);
    expect(s.schemaVersion).toBe(2);
    expect(s.bmpUrl).toBeUndefined();           // flat fields removed
    expect(s.profiles).toHaveLength(1);
    expect(s.profiles[0]).toMatchObject({ bmpUrl: 'https://x/Ws/', bmpUser: 'admin', bmpPass: 'enc:secret', authMode: 'auto' });
    expect(s.activeProfileId).toBe(s.profiles[0].id);
  });

  it('v1 profile WITH a password → auto', () => {
    const s: any = { schemaVersion: 1, profiles: [{ id: 'a', label: 'A', bmpUrl: 'u', bmpUser: 'admin', bmpPass: 'enc:x' }], activeProfileId: 'a' };
    expect(migrateStoredSettings(s)).toBe(true);
    expect(s.schemaVersion).toBe(2);
    expect(s.profiles[0].authMode).toBe('auto');
  });

  it('v1 profile WITHOUT a password → session', () => {
    const s: any = { schemaVersion: 1, profiles: [{ id: 'a', label: 'A', bmpUrl: 'u', bmpUser: '', bmpPass: '' }], activeProfileId: 'a' };
    expect(migrateStoredSettings(s)).toBe(true);
    expect(s.profiles[0].authMode).toBe('session');
  });

  it('is idempotent: a v2 object with explicit authMode is unchanged', () => {
    const s: any = { schemaVersion: 2, profiles: [{ id: 'a', label: 'A', bmpUrl: 'u', bmpUser: 'admin', bmpPass: 'enc:x', authMode: 'password' }], activeProfileId: 'a' };
    expect(migrateStoredSettings(s)).toBe(false);          // no change
    expect(s.profiles[0].authMode).toBe('password');       // preserved, not re-derived
    expect(s.schemaVersion).toBe(2);
  });

  it('a versionless object is treated as v1 and advanced to v2', () => {
    const s: any = { profiles: [{ id: 'a', label: 'A', bmpUrl: 'u', bmpUser: '', bmpPass: '' }], activeProfileId: 'a' };
    expect(migrateStoredSettings(s)).toBe(true);
    expect(s.schemaVersion).toBe(2);
    expect(s.profiles[0].authMode).toBe('session');
  });

  it('does not throw on a malformed (non-array) profiles value', () => {
    const s: any = { schemaVersion: 1, profiles: 'corrupt' };
    expect(() => migrateStoredSettings(s)).not.toThrow();
    // v1→v2 guard requires an array, so it bumps nothing and leaves the bad value
    // for loadSettingsFrom's array-guard to recover.
    expect(s.schemaVersion).toBe(1);
  });
});
