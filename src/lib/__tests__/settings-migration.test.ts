/**
 * Tests for migrateStoredSettings — the v0→v1→v2→v3 schema migration. Pinning
 * this matters: a regression silently reshapes or drops the user's saved
 * profiles. v3 added the optional `ai` field (no data reshaping — just a version
 * bump so stored data advances in lockstep with DEFAULT_SETTINGS).
 */
import { describe, it, expect } from 'vitest';
import { migrateStoredSettings } from '../settings';

describe('migrateStoredSettings', () => {
  it('v0 flat fields → v1 profile → v2 authMode → v3, in one pass', () => {
    const s: any = { bmpUrl: 'https://x/Ws/', bmpUser: 'admin', bmpPass: 'enc:secret' };
    const changed = migrateStoredSettings(s);
    expect(changed).toBe(true);
    expect(s.schemaVersion).toBe(3);
    expect(s.bmpUrl).toBeUndefined();           // flat fields removed
    expect(s.profiles).toHaveLength(1);
    expect(s.profiles[0]).toMatchObject({ bmpUrl: 'https://x/Ws/', bmpUser: 'admin', bmpPass: 'enc:secret', authMode: 'auto' });
    expect(s.activeProfileId).toBe(s.profiles[0].id);
  });

  it('v1 profile WITH a password → auto', () => {
    const s: any = { schemaVersion: 1, profiles: [{ id: 'a', label: 'A', bmpUrl: 'u', bmpUser: 'admin', bmpPass: 'enc:x' }], activeProfileId: 'a' };
    expect(migrateStoredSettings(s)).toBe(true);
    expect(s.schemaVersion).toBe(3);
    expect(s.profiles[0].authMode).toBe('auto');
  });

  it('v1 profile WITHOUT a password → session', () => {
    const s: any = { schemaVersion: 1, profiles: [{ id: 'a', label: 'A', bmpUrl: 'u', bmpUser: '', bmpPass: '' }], activeProfileId: 'a' };
    expect(migrateStoredSettings(s)).toBe(true);
    expect(s.profiles[0].authMode).toBe('session');
  });

  it('v2 → v3 is a pure version bump (no reshaping)', () => {
    const s: any = { schemaVersion: 2, profiles: [{ id: 'a', label: 'A', bmpUrl: 'u', bmpUser: 'admin', bmpPass: 'enc:x', authMode: 'password' }], activeProfileId: 'a' };
    expect(migrateStoredSettings(s)).toBe(true);
    expect(s.schemaVersion).toBe(3);
    expect(s.profiles[0].authMode).toBe('password');       // preserved, not re-derived
  });

  it('is idempotent: a v3 object is unchanged', () => {
    const s: any = { schemaVersion: 3, profiles: [{ id: 'a', label: 'A', bmpUrl: 'u', bmpUser: 'admin', bmpPass: 'enc:x', authMode: 'password' }], activeProfileId: 'a', ai: { provider: 'anthropic', model: 'claude-opus-4-8', apiKeyEnc: 'enc:key' } };
    expect(migrateStoredSettings(s)).toBe(false);          // no change
    expect(s.schemaVersion).toBe(3);
    expect(s.ai).toMatchObject({ provider: 'anthropic', model: 'claude-opus-4-8' });
  });

  it('a versionless object is treated as v1 and advanced to v3', () => {
    const s: any = { profiles: [{ id: 'a', label: 'A', bmpUrl: 'u', bmpUser: '', bmpPass: '' }], activeProfileId: 'a' };
    expect(migrateStoredSettings(s)).toBe(true);
    expect(s.schemaVersion).toBe(3);
    expect(s.profiles[0].authMode).toBe('session');
  });

  it('does not throw on a malformed (non-array) profiles value', () => {
    const s: any = { schemaVersion: 1, profiles: 'corrupt' };
    expect(() => migrateStoredSettings(s)).not.toThrow();
    // The v1→v2 authMode step requires an array, so it leaves the bad value for
    // loadSettingsFrom's array-guard to recover; the version still advances to
    // the current v3 (a pure bump — the corrupt value is repaired downstream).
    expect(s.schemaVersion).toBe(3);
  });
});
