import { describe, expect, it } from 'vitest';
import { migrateStoredSettings } from '../settings';

describe('migrateStoredSettings', () => {
  it('migrates a legacy flat profile with complete credentials to stored commands', () => {
    const settings: any = { bmpUrl: 'https://x/Ws/', bmpUser: 'admin', bmpPass: 'enc:secret' };
    expect(migrateStoredSettings(settings)).toBe(true);
    expect(settings.schemaVersion).toBe(4);
    expect(settings.bmpUrl).toBeUndefined();
    expect(settings.profiles).toHaveLength(1);
    expect(settings.profiles[0]).toMatchObject({
      bmpUrl: 'https://x/Ws/',
      bmpUser: 'admin',
      bmpPass: 'enc:secret',
      commandAuthMode: 'stored',
    });
    expect(settings.profiles[0].authMode).toBeUndefined();
    expect(settings.profiles[0].commandAuthRevision).toEqual(expect.any(String));
    expect(settings.commandAuthMigrationNotices).toEqual([
      { profileId: settings.profiles[0].id, user: 'admin' },
    ]);
  });

  it.each([
    ['session', 'portal', 'admin', 'enc:x'],
    ['password', 'stored', 'admin', 'enc:x'],
    ['auto', 'stored', 'admin', 'enc:x'],
    ['auto', 'portal', 'admin', ''],
    ['auto', 'portal', '', 'enc:x'],
  ] as const)('maps legacy %s to %s deterministically', (authMode, expected, bmpUser, bmpPass) => {
    const settings: any = {
      schemaVersion: 3,
      profiles: [{ id: 'a', label: 'A', bmpUrl: 'u', bmpUser, bmpPass, authMode }],
      activeProfileId: 'a',
    };
    expect(migrateStoredSettings(settings)).toBe(true);
    expect(settings.schemaVersion).toBe(4);
    expect(settings.profiles[0].commandAuthMode).toBe(expected);
    expect(settings.profiles[0].authMode).toBeUndefined();
  });

  it('is idempotent for v4 and preserves AI settings', () => {
    const settings: any = {
      schemaVersion: 4,
      profiles: [{
        id: 'a', label: 'A', bmpUrl: 'u', bmpUser: 'admin', bmpPass: 'enc:x',
        commandAuthMode: 'stored', commandAuthRevision: 'rev-1',
      }],
      activeProfileId: 'a',
      ai: { provider: 'anthropic', model: 'claude-opus-4-8', apiKeyEnc: 'enc:key' },
    };
    expect(migrateStoredSettings(settings)).toBe(false);
    expect(settings.profiles[0].commandAuthRevision).toBe('rev-1');
    expect(settings.ai.provider).toBe('anthropic');
  });

  it('does not throw on malformed profiles data', () => {
    const settings: any = { schemaVersion: 1, profiles: 'corrupt' };
    expect(() => migrateStoredSettings(settings)).not.toThrow();
    expect(settings.schemaVersion).toBe(4);
  });
});
