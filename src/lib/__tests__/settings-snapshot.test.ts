/**
 * Tests for snapshotSettings() — the function that mirrors the SW's
 * in-memory settings into chrome.storage.session for instant panel boot.
 *
 * The boot snapshot used to contain decrypted passwords, which is the worst-
 * case credential leak in this extension. The current implementation strips
 * `bmpPass` from every profile before writing. This test pins that behavior:
 * a future refactor that re-introduces the leak fails CI loudly.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mockChromeStorage } from './chrome-mock';

describe('snapshotSettings (credentials never persisted to session storage)', () => {
  beforeEach(async () => {
    vi.resetModules();
    mockChromeStorage();
  });

  it('strips bmpPass from every profile before writing', async () => {
    const { setSwContext } = await import('../sw-context');
    const { snapshotSettings } = await import('../settings');
    setSwContext({
      settings: {
        schemaVersion: 1,
        activeProfileId: 'p1',
        autoDetect: true,
        saveTarget: 'template',
        enrichMode: 'all',
        profiles: [
          { id: 'p1', label: 'Prod', bmpUrl: 'https://bmp.example.com/X', bmpUser: 'admin', bmpPass: 'sup3r-secret' },
          { id: 'p2', label: 'Dev',  bmpUrl: 'https://bmp.example.com/Y', bmpUser: 'dev',   bmpPass: 'another-secret' },
        ],
      },
    } as any);

    snapshotSettings();

    // The mock's chrome.storage.session.set has been called with the sanitized
    // snapshot; grab the most recent call's argument.
    const calls = (chrome.storage.session.set as any).mock.calls;
    expect(calls.length).toBe(1);
    const written = calls[0][0].crev_settings_snapshot;
    expect(written).toBeDefined();
    for (const p of written.profiles) {
      expect(p.bmpPass).toBe('');
    }
    // Non-credential fields preserved so the panel can render the UI shell.
    expect(written.profiles.map((p: { id: string }) => p.id)).toEqual(['p1', 'p2']);
    expect(written.profiles[0].bmpUser).toBe('admin');
    expect(written.profiles[0].bmpUrl).toBe('https://bmp.example.com/X');
    expect(written.activeProfileId).toBe('p1');
    expect(written.autoDetect).toBe(true);
  });

  it('strips the (encrypted) AI key but keeps provider + model', async () => {
    const { setSwContext } = await import('../sw-context');
    const { snapshotSettings } = await import('../settings');
    setSwContext({
      settings: {
        schemaVersion: 3,
        activeProfileId: '',
        autoDetect: true,
        saveTarget: 'template',
        enrichMode: 'widgets',
        profiles: [],
        ai: { provider: 'anthropic', model: 'claude-opus-4-8', apiKeyEnc: 'enc:super-secret-key' },
      },
    } as any);

    snapshotSettings();

    const written = (chrome.storage.session.set as any).mock.calls[0][0].crev_settings_snapshot;
    expect(written.ai.apiKeyEnc).toBe('');
    expect(written.ai.provider).toBe('anthropic');
    expect(written.ai.model).toBe('claude-opus-4-8');
  });

  it('does not mutate the source AI key', async () => {
    const { setSwContext } = await import('../sw-context');
    const { snapshotSettings } = await import('../settings');
    const settings = {
      schemaVersion: 3,
      activeProfileId: '',
      autoDetect: true,
      saveTarget: 'template' as const,
      enrichMode: 'widgets' as const,
      profiles: [],
      ai: { provider: 'openai' as const, model: 'gpt-5.2', apiKeyEnc: 'KEEP-ENC' },
    };
    setSwContext({ settings } as any);
    snapshotSettings();
    expect(settings.ai.apiKeyEnc).toBe('KEEP-ENC');
  });

  it('handles empty profile list without throwing', async () => {
    const { setSwContext } = await import('../sw-context');
    const { snapshotSettings } = await import('../settings');
    setSwContext({
      settings: {
        schemaVersion: 1,
        activeProfileId: '',
        autoDetect: false,
        saveTarget: 'template',
        enrichMode: 'widgets',
        profiles: [],
      },
    } as any);
    expect(() => snapshotSettings()).not.toThrow();
    const written = (chrome.storage.session.set as any).mock.calls[0][0].crev_settings_snapshot;
    expect(written.profiles).toEqual([]);
  });

  it('does not mutate the source settings object', async () => {
    // The sanitized copy must be a clone — otherwise we'd be wiping the SW's
    // in-memory password too, breaking authentication. This is a regression
    // guard against using `delete settings.profiles[i].bmpPass` instead of
    // map-and-spread.
    const { setSwContext } = await import('../sw-context');
    const { snapshotSettings, getActiveProfile } = await import('../settings');
    const settings = {
      schemaVersion: 1,
      activeProfileId: 'p1',
      autoDetect: true,
      saveTarget: 'template' as const,
      enrichMode: 'all' as const,
      profiles: [
        { id: 'p1', label: 'Prod', bmpUrl: 'https://x/', bmpUser: 'u', bmpPass: 'KEEP-ME' },
      ],
    };
    setSwContext({ settings } as any);
    snapshotSettings();
    expect(settings.profiles[0].bmpPass).toBe('KEEP-ME');
    expect(getActiveProfile()?.bmpPass).toBe('KEEP-ME');
  });
});
