import { describe, it, expect, vi } from 'vitest';
import { makeLayoutIO } from '../layout-service';
import type { BmpClient } from '../bmp-client';

/** Minimal BmpClient stub — only executeEc is exercised by the IO adapter. */
const stubClient = (impl: (code: string, rid: string | undefined, commit: boolean) => { ok: boolean; log?: string; error?: string }): BmpClient =>
  ({ executeEc: vi.fn(async (code: string, rid?: string, commit = false) => impl(code, rid, commit)) } as unknown as BmpClient);

describe('layout-service.makeLayoutIO', () => {
  it('passes commit through to executeEc as the transactional flag', async () => {
    const seen: boolean[] = [];
    const io = makeLayoutIO(stubClient((_c, _r, commit) => { seen.push(commit); return { ok: true, log: 'ok' }; }));
    await io.exec('read');           // default: read-only
    await io.exec('write', true);    // commit
    expect(seen).toEqual([false, true]);
  });

  it('does NOT scrape the log for rollback phrases — even on a commit (detection moved to applyModel)', async () => {
    // The old regex flipped ok→false when the log matched a rollback phrase. That's brittle (a
    // reworded message slips past) AND prone to false-positives (a widget name containing the phrase
    // failed a clean commit). Silent-rollback detection now lives in applyModel as a structural
    // re-fetch compare, so the IO adapter passes results through verbatim.
    const io = makeLayoutIO(stubClient(() => ({ ok: true, log: 'widget named "No changes done due to errors"' })));
    expect((await io.exec('apply', true)).ok).toBe(true);
    expect((await io.exec('read')).ok).toBe(true);
  });

  it('passes a clean commit through unchanged', async () => {
    const io = makeLayoutIO(stubClient(() => ({ ok: true, log: 'AddedTab: 1' })));
    const res = await io.exec('apply', true);
    expect(res.ok).toBe(true);
  });

  it('propagates a genuine ERROR-typed failure', async () => {
    const io = makeLayoutIO(stubClient(() => ({ ok: false, error: "Can't add X to Y" })));
    const res = await io.exec('apply', true);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/Can't add/);
  });

  it('passes a caller deadline and signal to executeEc', async () => {
    const client = stubClient(() => ({ ok: true, log: 'ok' }));
    const controller = new AbortController();
    const io = makeLayoutIO(client, [], 20_000, controller.signal);
    await io.exec('lean layout');
    expect(client.executeEc).toHaveBeenCalledWith(
      'lean layout',
      undefined,
      false,
      controller.signal,
      20_000,
    );
  });
});
