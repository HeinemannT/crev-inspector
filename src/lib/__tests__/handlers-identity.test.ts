import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ENVIRONMENT_CHANGED_ERROR } from '../environment';
import { mockChromeStorage } from './chrome-mock';

const mocks = vi.hoisted(() => ({
  saveIdentity: vi.fn(),
  invalidateRid: vi.fn(async () => {}),
}));

vi.mock('../identity-save', () => ({ saveIdentity: mocks.saveIdentity }));
vi.mock('../enrichment', () => ({ invalidateRid: mocks.invalidateRid }));

async function harness(client: Record<string, unknown> | null = { serverUrl: 'https://bmp.example/Steadfast/' }) {
  vi.resetModules();
  mockChromeStorage();
  const ctx: any = {
    client,
    cache: { get: vi.fn(() => null) },
    logActivity: vi.fn(),
  };
  const { setSwContext } = await import('../sw-context');
  const { getHandler } = await import('../handler-registry');
  setSwContext(ctx);
  await import('../handlers/ec');
  return { handler: getHandler('SAVE_IDENTITY')!, ctx };
}

const message = {
  type: 'SAVE_IDENTITY',
  rid: '9007199254740993',
  businessId: 'new_id',
  name: 'New name',
  templateBusinessId: 'new_template',
} as const;

describe('SAVE_IDENTITY handler adapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.saveIdentity.mockResolvedValue({
      ok: true,
      businessId: 'new_id',
      name: 'New name',
      templateBusinessId: 'new_template',
    });
  });

  it('delegates the workflow, preserves the response envelope, and refreshes verified identity', async () => {
    const h = await harness();
    const respond = vi.fn();

    await h.handler(message as any, respond, { isOneShot: true });

    expect(mocks.saveIdentity).toHaveBeenCalledWith(h.ctx.client, message.rid, message);
    expect(respond).toHaveBeenCalledWith({
      type: 'SAVE_IDENTITY_RESULT',
      ok: true,
      businessId: 'new_id',
      name: 'New name',
      templateBusinessId: 'new_template',
    });
    expect(h.ctx.logActivity).toHaveBeenCalledWith(
      'success',
      expect.stringContaining('Saved identity'),
      undefined,
      expect.objectContaining({ action: 'save-property' }),
    );
    expect(mocks.invalidateRid).toHaveBeenCalledWith(message.rid);
  });

  it('forwards a workflow failure without success effects', async () => {
    const h = await harness();
    const respond = vi.fn();
    mocks.saveIdentity.mockResolvedValue({
      ok: false,
      field: 'businessId',
      error: 'Use letters, numbers, and underscores for the ID.',
    });

    await h.handler(message as any, respond, { isOneShot: true });

    expect(respond).toHaveBeenCalledWith({
      type: 'SAVE_IDENTITY_RESULT',
      ok: false,
      field: 'businessId',
      error: 'Use letters, numbers, and underscores for the ID.',
    });
    expect(h.ctx.logActivity).not.toHaveBeenCalled();
    expect(mocks.invalidateRid).not.toHaveBeenCalled();
  });

  it('rejects a stale environment before entering the workflow', async () => {
    const h = await harness();
    h.ctx.settings = { activeProfileId: 'current' };
    const respond = vi.fn();

    await h.handler({ ...message, environment: 'other@https://bmp.example/Steadfast/' } as any, respond, { isOneShot: true });

    expect(mocks.saveIdentity).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith({
      type: 'SAVE_IDENTITY_RESULT',
      ok: false,
      error: ENVIRONMENT_CHANGED_ERROR,
    });
  });

  it('rejects a disconnected save without entering the workflow', async () => {
    const h = await harness(null);
    const respond = vi.fn();

    await h.handler(message as any, respond, { isOneShot: true });

    expect(mocks.saveIdentity).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith({
      type: 'SAVE_IDENTITY_RESULT',
      ok: false,
      error: 'Not connected',
    });
  });

  it('keeps unexpected workflow errors in the handler activity boundary', async () => {
    const h = await harness();
    const respond = vi.fn();
    mocks.saveIdentity.mockRejectedValue(new Error('Bridge offline'));

    await h.handler(message as any, respond, { isOneShot: true });

    expect(respond).toHaveBeenCalledWith({
      type: 'SAVE_IDENTITY_RESULT',
      ok: false,
      error: 'Bridge offline',
    });
    expect(h.ctx.logActivity).toHaveBeenCalledWith(
      'error',
      expect.stringContaining(`Identity save failed on ${message.rid}`),
      'Bridge offline',
      expect.objectContaining({ action: 'save-property' }),
    );
    expect(mocks.invalidateRid).not.toHaveBeenCalled();
  });
});
