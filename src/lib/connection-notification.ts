import type { ConnectionState } from './types';

export interface ConnectionNotificationCursor {
  initialized: boolean;
  incidentEpoch: number;
  recoveryEpoch: number;
}

export type ConnectionNotification = { text: string; kind: 'success' | 'error' };

/** Project semantic incident epochs into user notifications. Display adjacency,
 * transport generations and timestamps are deliberately irrelevant. */
export function nextConnectionNotification(
  state: ConnectionState,
  previous: ConnectionNotificationCursor,
): { cursor: ConnectionNotificationCursor; notification: ConnectionNotification | null } {
  const incidentEpoch = state.incidentEpoch ?? 0;
  const recoveryEpoch = state.recoveryEpoch ?? 0;
  const cursor = { initialized: true, incidentEpoch, recoveryEpoch };
  if (!previous.initialized) return { cursor, notification: null };

  if (incidentEpoch > previous.incidentEpoch) {
    const text = state.display === 'auth-failed' ? 'Auth failed'
      : state.display === 'unreachable' ? 'Server unreachable'
        : state.display === 'server-down' ? 'Server down'
          : state.display === 'identity-mismatch' ? 'Portal and command users differ'
            : 'Connection problem detected';
    return { cursor, notification: { text, kind: 'error' } };
  }
  // A recovery notification is only valid when this consumer observed the
  // matching incident. A newly opened content script may receive a later
  // recovery epoch from storage without ever having seen the outage.
  if (recoveryEpoch > previous.recoveryEpoch
    && previous.incidentEpoch === recoveryEpoch) {
    return {
      cursor,
      notification: { text: `Connected to ${state.profileLabel ?? 'server'}`, kind: 'success' },
    };
  }
  return { cursor, notification: null };
}
