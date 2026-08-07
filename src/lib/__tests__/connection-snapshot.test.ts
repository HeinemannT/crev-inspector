import { describe, expect, it } from 'vitest';
import type { ConnectionState } from '../types';
import { provisionalConnectionSnapshot } from '../connection-snapshot';

function state(display: ConnectionState['display']): ConnectionState {
  return {
    display,
    identities: {
      portal: { status: 'connected', user: 'portal.user', source: 'portal-session' },
      command: { status: 'connected', user: 'config.user', source: 'stored-login' },
      sameUser: false,
    },
    version: '5.6.7.2',
    responseMs: 10,
    profileLabel: 'Steadfast',
    workspace: 'Workspace',
    authError: null,
    networkOffline: false,
    lastUpdate: 1,
  };
}

describe('provisionalConnectionSnapshot', () => {
  it('removes stale verified actors until the worker probes both channels', () => {
    expect(provisionalConnectionSnapshot(state('connected'))).toMatchObject({
      display: 'checking',
      identities: {
        portal: { status: 'unknown', user: null },
        command: { status: 'unknown', user: null },
        sameUser: null,
      },
    });
  });

  it('preserves a stored non-green diagnostic', () => {
    const failed = state('command-failed');
    expect(provisionalConnectionSnapshot(failed)).toBe(failed);
  });

  it('safely invalidates a pre-identity green snapshot after upgrade', () => {
    const legacy = { ...state('connected') } as Partial<ConnectionState>;
    delete legacy.identities;
    expect(provisionalConnectionSnapshot(legacy as ConnectionState)).toMatchObject({
      display: 'checking',
      identities: {
        portal: { status: 'unknown', user: null },
        command: { status: 'unknown', user: null },
        sameUser: null,
      },
    });
  });
});
