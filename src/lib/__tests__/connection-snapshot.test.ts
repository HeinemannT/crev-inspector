import { describe, expect, it } from 'vitest';
import type { ConnectionState } from '../types';
import { provisionalConnectionSnapshot } from '../connection-snapshot';

function state(display: ConnectionState['display']): ConnectionState {
  return {
    display,
    authVia: 'password',
    version: '5.6.7.2',
    responseMs: 10,
    profileLabel: 'Steadfast',
    user: 'admin',
    workspace: 'Workspace',
    authError: null,
    networkOffline: false,
    lastUpdate: 1,
  };
}

describe('provisionalConnectionSnapshot', () => {
  it('turns stored green into checking until the worker probes commands', () => {
    expect(provisionalConnectionSnapshot(state('connected'))).toMatchObject({
      display: 'checking',
      authVia: null,
    });
  });

  it('preserves a stored non-green diagnostic', () => {
    const failed = state('command-failed');
    expect(provisionalConnectionSnapshot(failed)).toBe(failed);
  });
});
