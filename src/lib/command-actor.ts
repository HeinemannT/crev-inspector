/**
 * Shared command-actor disclosure.
 *
 * The service worker and content script keep the current identity map warm.
 * Separate editor/studio windows fall back to the sanitized connection
 * snapshot in session storage. No auth material is read or exposed here.
 */

import type { CommandAuthSource, ConnectionState, IdentityMap, InspectorSettings } from './types';
import { provisionalConnectionSnapshot } from './connection-snapshot';

export interface CommandActorDisclosure {
  user: string;
  source: CommandAuthSource;
  text: string;
}

export type CommandActorState =
  | { status: 'checking' }
  | { status: 'verified'; actor: CommandActorDisclosure }
  | { status: 'unavailable' };

let current: IdentityMap | null = null;

export function setCurrentIdentities(identities: IdentityMap): void {
  current = identities;
}

export function disclosureFromIdentities(identities: IdentityMap | null | undefined): CommandActorDisclosure | null {
  const actor = identities?.command;
  if (!actor || actor.status !== 'connected' || !actor.user) return null;
  return {
    user: actor.user,
    source: actor.source,
    text: actor.source === 'stored-login'
      ? `Runs as ${actor.user} · stored configuration login`
      : `Runs as ${actor.user} · browser session`,
  };
}

export function currentCommandActor(): CommandActorDisclosure | null {
  return disclosureFromIdentities(current);
}

function stateFromConnection(connection: ConnectionState | null | undefined): CommandActorState {
  const actor = disclosureFromIdentities(connection?.identities);
  if (actor) return { status: 'verified', actor };
  if (connection?.validation === 'validating'
    || connection?.display === 'checking'
    || connection?.display === 'reconnecting'
    || connection?.display === 'online') {
    return { status: 'checking' };
  }
  return { status: 'unavailable' };
}

async function readCommandActorState(): Promise<CommandActorState> {
  const warm = currentCommandActor();
  if (warm) return { status: 'verified', actor: warm };
  try {
    const stored = await chrome.storage.session.get(['crev_conn_snapshot', 'crev_settings_snapshot']);
    const settings = stored.crev_settings_snapshot as InspectorSettings | undefined;
    const snapshot = settings
      ? provisionalConnectionSnapshot(stored.crev_conn_snapshot, settings)
      : null;
    if (snapshot) return stateFromConnection(snapshot);
    const live = await chrome.runtime.sendMessage({ type: 'GET_CONNECTION_STATE' })
      .catch(() => undefined) as { type?: string; state?: ConnectionState } | undefined;
    return live?.type === 'CONNECTION_STATE'
      ? stateFromConnection(live.state)
      : { status: 'unavailable' };
  } catch {
    return { status: 'unavailable' };
  }
}

export async function readCommandActor(): Promise<CommandActorDisclosure | null> {
  const state = await readCommandActorState();
  return state.status === 'verified' ? state.actor : null;
}

/** Observe verified command-actor changes without polling. Separate extension
 * pages (notably the EC editor iframe) do not share the worker's in-memory
 * identity map, but every definitive connection transition refreshes the
 * sanitized session snapshot. */
export function watchCommandActor(
  listener: (state: CommandActorState) => void,
): () => void {
  let revision = 0;
  let disposed = false;
  let lastKey: string | undefined;
  const refresh = () => {
    const requestedRevision = ++revision;
    void readCommandActorState().then(state => {
      if (disposed || requestedRevision !== revision) return;
      const key = state.status === 'verified'
        ? `${state.status}\u0000${state.actor.source}\u0000${state.actor.user}`
        : state.status;
      if (key === lastKey) return;
      lastKey = key;
      listener(state);
    });
  };
  const onChanged = (
    changes: Record<string, chrome.storage.StorageChange>,
    areaName: string,
  ) => {
    if (areaName !== 'session'
      || (!changes.crev_conn_snapshot && !changes.crev_settings_snapshot)) return;
    refresh();
  };
  // Subscribe before the initial read so a snapshot publication during cold
  // editor startup cannot fall into a read/listen gap.
  chrome.storage?.onChanged?.addListener(onChanged);
  refresh();
  return () => {
    disposed = true;
    revision++;
    chrome.storage?.onChanged?.removeListener(onChanged);
  };
}
