import type { ConnectionState } from './types';
import { unknownIdentityMap } from './identity-map';

/** Session storage improves panel boot latency, but a stored green state is
 *  not current command-channel evidence after a worker/panel lifecycle change. */
export function provisionalConnectionSnapshot(state: ConnectionState): ConnectionState {
  if (state.display !== 'connected') return state;
  // A v3 snapshot can survive an extension update in storage.session and has
  // no identities field. Treat it as stale evidence instead of crashing the
  // panel during its first render after upgrade.
  const identities = state.identities ?? unknownIdentityMap();
  return {
    ...state,
    display: 'checking',
    identities: {
      portal: { ...identities.portal, status: 'unknown', user: null, error: undefined },
      command: { ...identities.command, status: 'unknown', user: null, error: undefined },
      sameUser: null,
    },
    authError: null,
  };
}
