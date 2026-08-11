import {
  normalizeAndValidateIdentity,
  type IdentityChangeSet,
  type IdentityEditInput,
  type IdentitySaveResult,
} from './object-identity';

export interface StoredIdentity {
  businessId?: string;
  name?: string;
  type?: string;
  templateBusinessId?: string;
}

export interface IdentitySavePort {
  lookupIdentity(rid: string, options?: { fresh?: boolean }): Promise<StoredIdentity | null>;
  applyIdentityChanges(
    rid: string,
    changes: IdentityChangeSet,
  ): Promise<{ ok: boolean; writeAttempted: boolean; error?: string }>;
}

/**
 * Save one object's editable identity and reconcile the response against an authoritative readback.
 * A BMP execute result is never treated as proof of persistence because EC writes are not atomic and
 * the transport can fail after the server has accepted a commit.
 */
export async function saveIdentity(
  port: IdentitySavePort,
  rid: string,
  input: IdentityEditInput,
): Promise<IdentitySaveResult> {
  const validation = normalizeAndValidateIdentity(input);
  if (!validation.ok) return validation;
  const { businessId, name, templateBusinessId } = validation.value;

  const before = await port.lookupIdentity(rid);
  if (!before) return { ok: false, error: 'Could not read the current identity.' };

  const changes: IdentityChangeSet = {};
  if (before.businessId !== businessId) changes.businessId = businessId;
  if (before.name !== name) changes.name = name;
  if (templateBusinessId !== undefined && before.templateBusinessId !== templateBusinessId) {
    changes.templateBusinessId = templateBusinessId;
  }

  const saved = await port.applyIdentityChanges(rid, changes);
  if (!saved.ok && !saved.writeAttempted) {
    return { ok: false, error: saved.error ?? 'Identity save failed' };
  }

  // Old BMP versions resolve objects through cached business IDs. Once an ID changes that reference is
  // stale, so any possible write must bypass it before deciding what actually persisted.
  const stored = await port.lookupIdentity(rid, saved.writeAttempted ? { fresh: true } : undefined);
  if (!stored) {
    return {
      ok: false,
      error: saved.writeAttempted
        ? 'BMP may have saved some identity values, but the verification read failed. Reload the object before retrying.'
        : 'Could not verify the current identity.',
    };
  }

  const verified = stored.businessId === businessId
    && stored.name === name
    && (templateBusinessId === undefined || stored.templateBusinessId === templateBusinessId);
  if (verified) {
    return {
      ok: true,
      businessId,
      name,
      ...(templateBusinessId !== undefined ? { templateBusinessId } : {}),
    };
  }

  const requestedValues = [
    ...(changes.businessId !== undefined
      ? [{ actual: stored.businessId, expected: changes.businessId }]
      : []),
    ...(changes.name !== undefined
      ? [{ actual: stored.name, expected: changes.name }]
      : []),
    ...(changes.templateBusinessId !== undefined
      ? [{ actual: stored.templateBusinessId, expected: changes.templateBusinessId }]
      : []),
  ];
  const anyRequestedValueLanded = requestedValues.some(value => value.actual === value.expected);
  const verificationError = anyRequestedValueLanded
    ? 'BMP applied only part of the identity change. The current values were refreshed; review them before retrying.'
    : 'BMP did not persist the requested identity values. The current values were refreshed for review.';
  return {
    ok: false,
    businessId: stored.businessId,
    name: stored.name,
    templateBusinessId: stored.templateBusinessId,
    error: saved.error ? `${saved.error} ${verificationError}` : verificationError,
  };
}
