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

export async function readCommandActor(): Promise<CommandActorDisclosure | null> {
  const warm = currentCommandActor();
  if (warm) return warm;
  try {
    const stored = await chrome.storage.session.get(['crev_conn_snapshot', 'crev_settings_snapshot']);
    const settings = stored.crev_settings_snapshot as InspectorSettings | undefined;
    const state = settings
      ? provisionalConnectionSnapshot(stored.crev_conn_snapshot, settings)
      : null;
    const snapshotActor = disclosureFromIdentities(state?.identities);
    if (snapshotActor) return snapshotActor;
    const live = await chrome.runtime.sendMessage({ type: 'GET_CONNECTION_STATE' })
      .catch(() => undefined) as { type?: string; state?: ConnectionState } | undefined;
    return live?.type === 'CONNECTION_STATE'
      ? disclosureFromIdentities(live.state?.identities)
      : null;
  } catch {
    return null;
  }
}
