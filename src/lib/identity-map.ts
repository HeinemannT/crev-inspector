/**
 * Effective BMP identities.
 *
 * CREV deliberately has two authentication channels:
 * - portal: the user signed into the BMP page in this browser;
 * - command: the user whose LoginTicket authenticates /cs/command.
 *
 * Keep this module transport-free. UI surfaces and activity logging consume the
 * same value instead of guessing an actor from profile form fields.
 */

export type CommandAuthMode = 'portal' | 'stored';
export type CommandAuthSource = 'portal-session' | 'stored-login';
export type ActorStatus = 'unknown' | 'connected' | 'unavailable' | 'failed';

export interface EffectiveActor {
  status: ActorStatus;
  user: string | null;
  source: CommandAuthSource;
  error?: string;
}

export interface IdentityMap {
  portal: EffectiveActor;
  command: EffectiveActor;
  sameUser: boolean | null;
}

export function unknownIdentityMap(commandMode: CommandAuthMode = 'portal'): IdentityMap {
  return {
    portal: { status: 'unknown', user: null, source: 'portal-session' },
    command: {
      status: 'unknown',
      user: null,
      source: commandMode === 'stored' ? 'stored-login' : 'portal-session',
    },
    sameUser: null,
  };
}

/** BMP usernames are treated case-insensitively for display comparison only. */
export function sameActorUser(portal: EffectiveActor, command: EffectiveActor): boolean | null {
  if (portal.status !== 'connected' || command.status !== 'connected' || !portal.user || !command.user) {
    return null;
  }
  return portal.user.localeCompare(command.user, undefined, { sensitivity: 'accent' }) === 0;
}

export function withSameUser(identity: Omit<IdentityMap, 'sameUser'>): IdentityMap {
  return { ...identity, sameUser: sameActorUser(identity.portal, identity.command) };
}
