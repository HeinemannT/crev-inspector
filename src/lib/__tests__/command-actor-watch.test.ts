import { describe, expect, it, vi } from 'vitest';
import type { ConnectionState } from '../types';
import { unknownIdentityMap } from '../identity-map';

describe('watchCommandActor', () => {
  it('upgrades a cold editor from unverified to the later connected actor', async () => {
    vi.resetModules();
    let storageListener: ((changes: Record<string, chrome.storage.StorageChange>, area: string) => void) | undefined;
    let liveState: ConnectionState = {
      display: 'checking',
      identities: unknownIdentityMap('portal'),
      version: null,
      responseMs: null,
      profileLabel: 'Demo',
      workspace: 'Workspace',
      authError: null,
      networkOffline: false,
      lastUpdate: 0,
    };
    const removeListener = vi.fn();
    globalThis.chrome = {
      storage: {
        session: { get: vi.fn(async () => ({})) },
        onChanged: {
          addListener: vi.fn(listener => { storageListener = listener; }),
          removeListener,
        },
      },
      runtime: {
        sendMessage: vi.fn(async () => ({ type: 'CONNECTION_STATE', state: liveState })),
      },
    } as any;

    const { watchCommandActor } = await import('../command-actor');
    const updates: string[] = [];
    const stop = watchCommandActor(state => updates.push(
      state.status === 'verified' ? `${state.status}:${state.actor.user}` : state.status,
    ));
    await vi.waitFor(() => expect(updates).toEqual(['checking']));

    liveState = {
      ...liveState,
      display: 'connected',
      identities: {
        portal: { status: 'connected', user: 'portal-rid', source: 'portal-session' },
        command: { status: 'connected', user: 'admin', source: 'portal-session' },
        sameUser: true,
      },
    };
    storageListener?.({ crev_conn_snapshot: { oldValue: null, newValue: {} } }, 'session');

    await vi.waitFor(() => expect(updates).toEqual(['checking', 'verified:admin']));
    stop();
    expect(removeListener).toHaveBeenCalledWith(storageListener);
  });

  it('ignores an older async refresh that resolves after newer actor evidence', async () => {
    vi.resetModules();
    let storageListener: ((changes: Record<string, chrome.storage.StorageChange>, area: string) => void) | undefined;
    const reads: Array<(value: Record<string, unknown>) => void> = [];
    globalThis.chrome = {
      storage: {
        session: { get: vi.fn(() => new Promise(resolve => reads.push(resolve))) },
        onChanged: {
          addListener: vi.fn(listener => { storageListener = listener; }),
          removeListener: vi.fn(),
        },
      },
      runtime: { sendMessage: vi.fn(async () => undefined) },
    } as any;

    const { watchCommandActor } = await import('../command-actor');
    const updates: string[] = [];
    watchCommandActor(state => updates.push(
      state.status === 'verified' ? `${state.status}:${state.actor.user}` : state.status,
    ));
    storageListener?.({ crev_conn_snapshot: { oldValue: null, newValue: {} } }, 'session');

    reads[1]({
      crev_settings_snapshot: {
        profiles: [{ id: 'p1', bmpUrl: 'https://bmp.test/Workspace/', commandAuthMode: 'stored', commandAuthRevision: '' }],
        activeProfileId: 'p1',
      },
      crev_conn_snapshot: {
        schema: 1,
        profileId: 'p1',
        environment: 'p1@https://bmp.test/Workspace/',
        commandAuthRevision: '',
        expiresAt: Date.now() + 60_000,
        state: {
          display: 'connected',
          identities: {
            portal: { status: 'unknown', user: null, source: 'portal-session' },
            command: { status: 'connected', user: 'new-user', source: 'stored-login' },
            sameUser: null,
          },
          version: null, responseMs: 1, profileLabel: 'P1', workspace: 'Workspace',
          authError: null, networkOffline: false, lastUpdate: Date.now(),
          semanticRevision: 1, verifiedAt: Date.now(),
        },
      },
    });
    await vi.waitFor(() => expect(updates).toEqual(['verified:new-user']));

    reads[0]({});
    await Promise.resolve();
    expect(updates).toEqual(['verified:new-user']);
  });
});
