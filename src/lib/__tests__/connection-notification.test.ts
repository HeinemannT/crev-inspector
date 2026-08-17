import { describe, expect, it } from 'vitest';
import type { ConnectionState } from '../types';
import { nextConnectionNotification, type ConnectionNotificationCursor } from '../connection-notification';

const empty: ConnectionNotificationCursor = { initialized: false, incidentEpoch: 0, recoveryEpoch: 0 };

function state(change: Partial<ConnectionState> = {}): ConnectionState {
  return {
    display: 'connected',
    identities: {
      portal: { status: 'connected', user: 'admin', source: 'portal-session' },
      command: { status: 'connected', user: 'admin', source: 'portal-session' },
      sameUser: true,
    },
    version: null, responseMs: 1, profileLabel: 'Steadfast', workspace: 'Steadfast',
    authError: null, networkOffline: false, lastUpdate: 0, semanticRevision: 1,
    incidentEpoch: 0, recoveryEpoch: 0,
    ...change,
  };
}

describe('connection notification projection', () => {
  it('does not toast first delivery or repeated healthy validation at former poll intervals', () => {
    let result = nextConnectionNotification(state(), empty);
    expect(result.notification).toBeNull();
    for (const lastUpdate of [30_000, 60_000, 90_000]) {
      result = nextConnectionNotification(state({ lastUpdate, validation: 'validating' }), result.cursor);
      expect(result.notification).toBeNull();
    }
  });

  it('emits one incident and one recovery, then stays quiet', () => {
    const boot = nextConnectionNotification(state(), empty);
    const incident = nextConnectionNotification(state({ display: 'unreachable', incidentEpoch: 1 }), boot.cursor);
    expect(incident.notification).toEqual({ text: 'Server unreachable', kind: 'error' });
    expect(nextConnectionNotification(state({ display: 'unreachable', incidentEpoch: 1 }), incident.cursor).notification).toBeNull();

    const recovered = nextConnectionNotification(state({ recoveryEpoch: 1 }), incident.cursor);
    expect(recovered.notification).toEqual({ text: 'Connected to Steadfast', kind: 'success' });
    expect(nextConnectionNotification(state({ recoveryEpoch: 1 }), recovered.cursor).notification).toBeNull();
  });

  it('never treats checking-to-connected adjacency as recovery', () => {
    const boot = nextConnectionNotification(state({ display: 'checking' }), empty);
    expect(nextConnectionNotification(state({ display: 'connected' }), boot.cursor).notification).toBeNull();
  });

  it('does not toast a recovery epoch when this consumer missed its incident', () => {
    const boot = nextConnectionNotification(state(), empty);
    const recoveredElsewhere = nextConnectionNotification(state({ recoveryEpoch: 3 }), boot.cursor);
    expect(recoveredElsewhere.notification).toBeNull();
  });
});
