import type { ConnectionState } from './types';

/** Session storage improves panel boot latency, but a stored green state is
 *  not current command-channel evidence after a worker/panel lifecycle change. */
export function provisionalConnectionSnapshot(state: ConnectionState): ConnectionState {
  if (state.display !== 'connected') return state;
  return {
    ...state,
    display: 'checking',
    authVia: null,
    authError: null,
  };
}
