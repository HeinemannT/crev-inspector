import type { ConnectionState, InspectorSettings } from './types';
import { CONNECTION_EVIDENCE_TTL } from './constants';

export const CONNECTION_SNAPSHOT_SCHEMA = 1;

export interface ConnectionEvidenceSnapshot {
  schema: typeof CONNECTION_SNAPSHOT_SCHEMA;
  profileId: string;
  environment: string;
  commandAuthRevision: string;
  expiresAt: number;
  state: ConnectionState;
}

/** Build the sanitized, scope-bound record persisted in storage.session. The
 * ConnectionState contains no credentials, tokens, cookies or BMP payloads. */
export function createConnectionSnapshot(
  state: ConnectionState,
  settings: InspectorSettings,
): ConnectionEvidenceSnapshot | null {
  const profile = settings.profiles.find(p => p.id === settings.activeProfileId);
  if (!profile || !state.environment || !state.verifiedAt) return null;
  return {
    schema: CONNECTION_SNAPSHOT_SCHEMA,
    profileId: profile.id,
    environment: state.environment,
    commandAuthRevision: profile.commandAuthRevision ?? '',
    expiresAt: state.verifiedAt + CONNECTION_EVIDENCE_TTL,
    state: { ...state },
  };
}

/** Accept only current-schema, unexpired evidence for the exact active
 * profile/environment/auth revision. Malformed and legacy green snapshots are
 * rejected instead of being presented as freshly verified. */
export function provisionalConnectionSnapshot(
  value: unknown,
  settings: InspectorSettings,
  now = Date.now(),
): ConnectionState | null {
  if (!value || typeof value !== 'object') return null;
  const snapshot = value as Partial<ConnectionEvidenceSnapshot>;
  const profile = settings.profiles.find(p => p.id === settings.activeProfileId);
  if (!profile || snapshot.schema !== CONNECTION_SNAPSHOT_SCHEMA
    || snapshot.profileId !== profile.id
    || snapshot.commandAuthRevision !== (profile.commandAuthRevision ?? '')
    || typeof snapshot.environment !== 'string'
    || snapshot.environment !== `${profile.id}@${normalizeServerUrl(profile.bmpUrl)}`
    || typeof snapshot.expiresAt !== 'number' || snapshot.expiresAt <= now
    || !isConnectionState(snapshot.state)) return null;
  return { ...snapshot.state, validation: 'validating' };
}

function normalizeServerUrl(raw: string): string {
  let url = raw.trim();
  if (url && !/^https?:\/\//i.test(url)) url = `https://${url}`;
  if (url && !url.endsWith('/')) url += '/';
  return url;
}

function isConnectionState(value: unknown): value is ConnectionState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Partial<ConnectionState>;
  return typeof state.display === 'string'
    && !!state.identities
    && typeof state.lastUpdate === 'number'
    && typeof state.semanticRevision === 'number'
    && typeof state.verifiedAt === 'number';
}
