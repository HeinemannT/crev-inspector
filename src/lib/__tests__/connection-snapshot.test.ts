import { describe, expect, it } from 'vitest';
import type { ConnectionState, InspectorSettings } from '../types';
import { CONNECTION_EVIDENCE_TTL } from '../constants';
import { createConnectionSnapshot, provisionalConnectionSnapshot } from '../connection-snapshot';

const NOW = 1_000_000;

const settings: InspectorSettings = {
  schemaVersion: 4,
  profiles: [{
    id: 'p1', label: 'Steadfast', bmpUrl: 'https://bmp.test/Workspace/', bmpUser: '', bmpPass: '',
    commandAuthMode: 'portal', commandAuthRevision: 'auth-1',
  }],
  activeProfileId: 'p1', autoDetect: true, saveTarget: 'instance', enrichMode: 'all',
};

function state(display: ConnectionState['display'] = 'connected'): ConnectionState {
  return {
    display,
    identities: {
      portal: { status: 'connected', user: 'portal.user', source: 'portal-session' },
      command: { status: 'connected', user: 'portal.user', source: 'portal-session' },
      sameUser: true,
    },
    version: '5.6.7.2', responseMs: 10, profileLabel: 'Steadfast', workspace: 'Workspace',
    authError: null, networkOffline: false, lastUpdate: NOW - 10, verifiedAt: NOW - 20,
    semanticRevision: 7, incidentEpoch: 0, recoveryEpoch: 0,
    environment: 'p1@https://bmp.test/Workspace/', validation: 'idle',
  };
}

describe('connection evidence snapshots', () => {
  it('hydrates matching confirmed evidence without green-to-checking churn', () => {
    const snapshot = createConnectionSnapshot(state(), settings);
    expect(provisionalConnectionSnapshot(snapshot, settings, NOW)).toMatchObject({
      display: 'connected', validation: 'validating', semanticRevision: 7,
      identities: { command: { user: 'portal.user' } },
    });
  });

  it.each([
    ['wrong profile', { profileId: 'other' }],
    ['wrong environment', { environment: 'p1@https://other.test/' }],
    ['wrong auth revision', { commandAuthRevision: 'auth-2' }],
    ['legacy schema', { schema: 0 }],
  ])('rejects %s', (_label, change) => {
    const snapshot = { ...createConnectionSnapshot(state(), settings)!, ...change };
    expect(provisionalConnectionSnapshot(snapshot, settings, NOW)).toBeNull();
  });

  it('rejects expired and malformed evidence', () => {
    const expiredState = { ...state(), verifiedAt: NOW - CONNECTION_EVIDENCE_TTL - 1 };
    expect(provisionalConnectionSnapshot(createConnectionSnapshot(expiredState, settings), settings, NOW)).toBeNull();
    expect(provisionalConnectionSnapshot({ schema: 1, state: { display: 'connected' } }, settings, NOW)).toBeNull();
    expect(provisionalConnectionSnapshot(state(), settings, NOW)).toBeNull();
  });

  it('does not create a snapshot before any evidence is verified', () => {
    expect(createConnectionSnapshot({ ...state('checking'), verifiedAt: null }, settings)).toBeNull();
  });
});
