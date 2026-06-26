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

  it('downgrades a silent rollback to failure on a committing run', async () => {
    const io = makeLayoutIO(stubClient(() => ({ ok: true, log: 'Message : No changes done due to errors' })));
    const res = await io.exec('apply', true);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/rolled back/i);
  });

  it('does NOT treat a rollback phrase in a READ as failure (only commits are guarded)', async () => {
    // a fetch whose data legitimately contains the phrase must not be falsely failed
    const io = makeLayoutIO(stubClient(() => ({ ok: true, log: 'widget named "No changes done due to errors"' })));
    const res = await io.exec('read');     // commit = false
    expect(res.ok).toBe(true);
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
});
