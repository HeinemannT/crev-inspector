import { describe, expect, it, vi } from 'vitest';
import { saveIdentity, type IdentitySavePort, type StoredIdentity } from '../identity-save';

const before: StoredIdentity = {
  businessId: 'old_id',
  name: 'Old name',
  templateBusinessId: 'old_template',
};
const requested = {
  businessId: ' new_id ',
  name: ' New name ',
  templateBusinessId: ' new_template ',
};
const after: StoredIdentity = {
  businessId: 'new_id',
  name: 'New name',
  templateBusinessId: 'new_template',
};

function port(reads: Array<StoredIdentity | null> = [before, after]): IdentitySavePort & {
  lookupIdentity: ReturnType<typeof vi.fn>;
  applyIdentityChanges: ReturnType<typeof vi.fn>;
} {
  return {
    lookupIdentity: vi.fn(async () => reads.shift() ?? null),
    applyIdentityChanges: vi.fn(async () => ({ ok: true, writeAttempted: true })),
  };
}

describe('identity save workflow', () => {
  it('normalizes input, writes only changed fields, and verifies with a fresh read', async () => {
    const bmp = port();

    const result = await saveIdentity(bmp, '9007199254740993', requested);

    expect(bmp.applyIdentityChanges).toHaveBeenCalledWith('9007199254740993', {
      businessId: 'new_id',
      name: 'New name',
      templateBusinessId: 'new_template',
    });
    expect(bmp.lookupIdentity).toHaveBeenNthCalledWith(1, '9007199254740993');
    expect(bmp.lookupIdentity).toHaveBeenNthCalledWith(2, '9007199254740993', { fresh: true });
    expect(result).toEqual({
      ok: true,
      businessId: 'new_id',
      name: 'New name',
      templateBusinessId: 'new_template',
    });
  });

  it('rejects invalid fields before BMP is read or written', async () => {
    const bmp = port();

    const result = await saveIdentity(bmp, '1', { businessId: 'bad id', name: 'Name' });

    expect(result).toMatchObject({ ok: false, field: 'businessId' });
    expect(bmp.lookupIdentity).not.toHaveBeenCalled();
    expect(bmp.applyIdentityChanges).not.toHaveBeenCalled();
  });

  it('reports a missing initial identity without attempting a write', async () => {
    const bmp = port([null]);

    await expect(saveIdentity(bmp, '1', requested)).resolves.toEqual({
      ok: false,
      error: 'Could not read the current identity.',
    });
    expect(bmp.applyIdentityChanges).not.toHaveBeenCalled();
  });

  it('does not verify when preview rejects before any write', async () => {
    const bmp = port([before]);
    bmp.applyIdentityChanges.mockResolvedValue({
      ok: false,
      writeAttempted: false,
      error: 'Duplicate business ID',
    });

    await expect(saveIdentity(bmp, '1', requested)).resolves.toEqual({
      ok: false,
      error: 'Duplicate business ID',
    });
    expect(bmp.lookupIdentity).toHaveBeenCalledTimes(1);
  });

  it('trusts matching persisted state over a failed write response', async () => {
    const bmp = port();
    bmp.applyIdentityChanges.mockResolvedValue({
      ok: false,
      writeAttempted: true,
      error: 'Connection closed after execute',
    });

    await expect(saveIdentity(bmp, '1', requested)).resolves.toMatchObject({ ok: true });
  });

  it('returns authoritative values when only part of a write lands', async () => {
    const bmp = port([before, {
      businessId: 'new_id', name: 'New name', templateBusinessId: 'old_template',
    }]);
    bmp.applyIdentityChanges.mockResolvedValue({
      ok: false,
      writeAttempted: true,
      error: 'Template change failed.',
    });

    await expect(saveIdentity(bmp, '1', requested)).resolves.toEqual({
      ok: false,
      businessId: 'new_id',
      name: 'New name',
      templateBusinessId: 'old_template',
      error: 'Template change failed. BMP applied only part of the identity change. The current values were refreshed; review them before retrying.',
    });
  });

  it('distinguishes complete non-persistence from a partial write', async () => {
    const bmp = port([before, before]);

    await expect(saveIdentity(bmp, '1', requested)).resolves.toEqual({
      ok: false,
      businessId: 'old_id',
      name: 'Old name',
      templateBusinessId: 'old_template',
      error: 'BMP did not persist the requested identity values. The current values were refreshed for review.',
    });
  });

  it('reports uncertainty when a possible write cannot be read back', async () => {
    const bmp = port([before, null]);

    await expect(saveIdentity(bmp, '1', requested)).resolves.toEqual({
      ok: false,
      error: 'BMP may have saved some identity values, but the verification read failed. Reload the object before retrying.',
    });
  });

  it('does not manage or verify a template ID when the field is omitted', async () => {
    const bmp = port([
      before,
      { businessId: 'new_id', name: 'New name', templateBusinessId: 'changed_elsewhere' },
    ]);

    const result = await saveIdentity(bmp, '1', { businessId: 'new_id', name: 'New name' });

    expect(bmp.applyIdentityChanges).toHaveBeenCalledWith('1', {
      businessId: 'new_id',
      name: 'New name',
    });
    expect(result).toEqual({ ok: true, businessId: 'new_id', name: 'New name' });
  });

  it('preserves no-op semantics without forcing a fresh cache eviction', async () => {
    const unchanged = { businessId: 'same_id', name: 'Same name' };
    const bmp = port([unchanged, unchanged]);
    bmp.applyIdentityChanges.mockResolvedValue({ ok: true, writeAttempted: false });

    const result = await saveIdentity(bmp, '1', unchanged);

    expect(bmp.applyIdentityChanges).toHaveBeenCalledWith('1', {});
    expect(bmp.lookupIdentity).toHaveBeenNthCalledWith(2, '1', undefined);
    expect(result).toEqual({ ok: true, businessId: 'same_id', name: 'Same name' });
  });
});
