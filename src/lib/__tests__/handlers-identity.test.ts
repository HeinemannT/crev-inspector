import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mockChromeStorage } from './chrome-mock';

vi.mock('../enrichment', () => ({
  invalidateRid: vi.fn(async () => {}),
}));

async function harness() {
  vi.resetModules();
  mockChromeStorage();

  const applyIdentityChanges = vi.fn(async (): Promise<{
    ok: boolean;
    writeAttempted: boolean;
    error?: string;
  }> => ({ ok: true, writeAttempted: true }));
  const lookupIdentity = vi.fn()
    .mockResolvedValueOnce({
      businessId: 'old_id',
      name: 'Old name',
      templateBusinessId: 'old_template',
    })
    .mockResolvedValueOnce({
      businessId: 'new_id',
      name: 'New name',
      templateBusinessId: 'new_template',
    });
  const ctx: any = {
    client: { applyIdentityChanges, lookupIdentity },
    cache: { get: vi.fn(() => null) },
    logActivity: vi.fn(),
  };

  const { setSwContext } = await import('../sw-context');
  const { getHandler } = await import('../handler-registry');
  setSwContext(ctx);
  await import('../handlers/ec');

  return {
    handler: getHandler('SAVE_IDENTITY')!,
    applyIdentityChanges,
    lookupIdentity,
    ctx,
  };
}

describe('SAVE_IDENTITY handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('submits only the identity fields that actually changed through one client operation', async () => {
    const h = await harness();
    const respond = vi.fn();

    await h.handler({
      type: 'SAVE_IDENTITY',
      rid: '9007199254740993',
      businessId: ' new_id ',
      name: ' New name ',
      templateBusinessId: ' new_template ',
    } as any, respond, { isOneShot: true });

    expect(h.applyIdentityChanges).toHaveBeenCalledOnce();
    expect(h.applyIdentityChanges).toHaveBeenCalledWith('9007199254740993', {
      businessId: 'new_id',
      name: 'New name',
      templateBusinessId: 'new_template',
    });
    expect(respond).toHaveBeenCalledWith({
      type: 'SAVE_IDENTITY_RESULT',
      ok: true,
      businessId: 'new_id',
      name: 'New name',
      templateBusinessId: 'new_template',
    });
  });

  it('does not rewrite an unchanged instance ID when only the name changes', async () => {
    const h = await harness();
    const respond = vi.fn();
    h.lookupIdentity
      .mockReset()
      .mockResolvedValueOnce({
        businessId: 'same_id',
        name: 'Old name',
        templateBusinessId: 'same_template',
      })
      .mockResolvedValueOnce({
        businessId: 'same_id',
        name: 'New name',
        templateBusinessId: 'same_template',
      });

    await h.handler({
      type: 'SAVE_IDENTITY',
      rid: '9007199254740993',
      businessId: 'same_id',
      name: 'New name',
      templateBusinessId: 'same_template',
    } as any, respond, { isOneShot: true });

    expect(h.applyIdentityChanges).toHaveBeenCalledWith('9007199254740993', {
      name: 'New name',
    });
  });

  it('trusts verified persisted state when the EC response itself reports failure', async () => {
    const h = await harness();
    const respond = vi.fn();
    h.applyIdentityChanges.mockResolvedValueOnce({
      ok: false,
      writeAttempted: true,
      error: 'Connection closed after execute',
    });

    await h.handler({
      type: 'SAVE_IDENTITY',
      rid: '9007199254740993',
      businessId: 'new_id',
      name: 'New name',
      templateBusinessId: 'new_template',
    } as any, respond, { isOneShot: true });

    expect(h.lookupIdentity).toHaveBeenCalledTimes(2);
    expect(respond).toHaveBeenCalledWith({
      type: 'SAVE_IDENTITY_RESULT',
      ok: true,
      businessId: 'new_id',
      name: 'New name',
      templateBusinessId: 'new_template',
    });
  });

  it('reports actual values when a write only partly lands', async () => {
    const h = await harness();
    const respond = vi.fn();
    h.applyIdentityChanges.mockResolvedValueOnce({
      ok: false,
      writeAttempted: true,
      error: 'Template change failed.',
    });
    h.lookupIdentity
      .mockReset()
      .mockResolvedValueOnce({
        businessId: 'old_id',
        name: 'Old name',
        templateBusinessId: 'old_template',
      })
      .mockResolvedValueOnce({
        businessId: 'new_id',
        name: 'New name',
        templateBusinessId: 'old_template',
      });

    await h.handler({
      type: 'SAVE_IDENTITY',
      rid: '9007199254740993',
      businessId: 'new_id',
      name: 'New name',
      templateBusinessId: 'new_template',
    } as any, respond, { isOneShot: true });

    expect(respond).toHaveBeenCalledWith({
      type: 'SAVE_IDENTITY_RESULT',
      ok: false,
      businessId: 'new_id',
      name: 'New name',
      templateBusinessId: 'old_template',
      error: 'Template change failed. BMP applied only part of the identity change. The current values were refreshed; review them before retrying.',
    });
  });

  it('rejects an invalid runtime message before reading or writing BMP', async () => {
    const h = await harness();
    const respond = vi.fn();

    await h.handler({
      type: 'SAVE_IDENTITY',
      rid: '9007199254740993',
      businessId: 'bad id',
      name: 'Name',
    } as any, respond, { isOneShot: true });

    expect(h.lookupIdentity).not.toHaveBeenCalled();
    expect(h.applyIdentityChanges).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({
      type: 'SAVE_IDENTITY_RESULT',
      ok: false,
      field: 'businessId',
    }));
  });
});
