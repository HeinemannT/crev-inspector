import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LModel, LNode } from '../../lib/layout/types';
import { createApplySession, type ApplySessionIO } from '../apply-session';

const node = (partial: Partial<LNode> & Pick<LNode, 'id' | 'kind' | 'className'>): LNode => ({
  name: partial.id,
  cols: { L: 6 },
  children: [],
  ...partial,
});

const models = (): { baseline: LModel; desired: LModel } => {
  const baseline: LModel = {
    pageId: 'page', pageClass: 'Scorecard', tabsetId: 'tabs', target: 'template', hasTemplate: false,
    tabs: [node({ id: 'tab', kind: 'tab', className: 'Tab', children: [
      node({ id: 'widget', kind: 'widget', className: 'TextElement', name: 'Before' }),
    ] })],
  };
  return {
    baseline,
    desired: {
      ...baseline,
      tabs: [node({ id: 'tab', kind: 'tab', className: 'Tab', children: [
        node({ id: 'widget', kind: 'widget', className: 'TextElement', name: 'Reviewed' }),
      ] })],
    },
  };
};

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(res => { resolve = res; });
  return { promise, resolve };
};

const impact = { fanout: null, blast: null, flowBlast: null };
const makeIO = (): ApplySessionIO => ({
  preflightPortableIds: vi.fn(),
  assessImpact: vi.fn().mockResolvedValue(impact),
  apply: vi.fn().mockResolvedValue({ type: 'LAYOUT_APPLY_RESULT', ok: true, noop: false }),
});

beforeEach(() => vi.restoreAllMocks());

describe('Blueprint Apply Session', () => {
  it('freezes the reviewed models and sends the unchanged LAYOUT_APPLY contract', async () => {
    const { baseline, desired } = models();
    const pendingImpact = deferred<typeof impact>();
    const io = makeIO();
    vi.mocked(io.assessImpact).mockReturnValue(pendingImpact.promise);
    const session = createApplySession({
      env: 'profile-a',
      ctx: { pageId: 'page', pageRid: '9007199254740993', pageClass: 'Scorecard', tabsetId: 'tabs', target: 'template' },
      baseline, desired,
      idConfig: { enabled: false, pattern: '{page}_{class}_{name}' },
      isCurrent: () => true,
    }, io, vi.fn());

    await vi.waitFor(() => expect(session.state.phase).toBe('review'));
    if (session.state.phase !== 'review') throw new Error('review not ready');
    expect(session.state.review.impact.status).toBe('checking');
    desired.tabs[0].children[0].name = 'Mutated later';
    expect(await session.confirm()).toEqual({ kind: 'cancelled' });
    expect(io.apply).not.toHaveBeenCalled();

    pendingImpact.resolve(impact);
    await vi.waitFor(() => {
      expect(session.state.phase).toBe('review');
      if (session.state.phase === 'review') expect(session.state.review.impact.status).toBe('ready');
    });
    await session.confirm();

    expect(io.apply).toHaveBeenCalledWith({
      type: 'LAYOUT_APPLY',
      env: 'profile-a',
      ctx: { pageId: 'page', pageRid: '9007199254740993', pageClass: 'Scorecard', tabsetId: 'tabs', target: 'template' },
      baseline,
      desired: expect.objectContaining({
        tabs: [expect.objectContaining({ children: [expect.objectContaining({ name: 'Reviewed' })] })],
      }),
    });
  });

  it('allows only one commit and classifies a stale response', async () => {
    const { baseline, desired } = models();
    const io = makeIO();
    vi.mocked(io.apply).mockResolvedValue({
      type: 'LAYOUT_APPLY_RESULT', ok: false, noop: false, stale: true, model: baseline,
      error: 'Changed elsewhere', notes: [],
    });
    const session = createApplySession({
      env: 'profile-a',
      ctx: { pageId: 'page', pageRid: '1', pageClass: 'Scorecard', tabsetId: 'tabs', target: 'template' },
      baseline, desired,
      idConfig: { enabled: false, pattern: '{page}_{class}_{name}' },
      isCurrent: () => true,
    }, io, vi.fn());
    await vi.waitFor(() => {
      expect(session.state.phase).toBe('review');
      if (session.state.phase === 'review') expect(session.state.review.impact.status).toBe('ready');
    });

    const [first, second] = await Promise.all([session.confirm(), session.confirm()]);

    expect(first).toMatchObject({ kind: 'stale', message: 'Changed elsewhere' });
    expect(second).toEqual(first);
    expect(io.apply).toHaveBeenCalledTimes(1);
  });

  it('settles an accepted commit even if the editable draft later stops being current', async () => {
    const { baseline, desired } = models();
    const pendingApply = deferred<Awaited<ReturnType<ApplySessionIO['apply']>>>();
    const io = makeIO();
    vi.mocked(io.apply).mockReturnValue(pendingApply.promise);
    let current = true;
    const session = createApplySession({
      env: 'profile-a',
      ctx: { pageId: 'page', pageRid: '1', pageClass: 'Scorecard', tabsetId: 'tabs', target: 'template' },
      baseline, desired,
      idConfig: { enabled: false, pattern: '{page}_{class}_{name}' },
      isCurrent: () => current,
    }, io, vi.fn());
    await vi.waitFor(() => {
      expect(session.state.phase).toBe('review');
      if (session.state.phase === 'review') expect(session.state.review.impact.status).toBe('ready');
    });

    const committed = session.confirm();
    expect(session.state.phase).toBe('applying');
    current = false;
    pendingApply.resolve({ type: 'LAYOUT_APPLY_RESULT', ok: true, noop: false });

    await expect(committed).resolves.toMatchObject({ kind: 'applied' });
    expect(session.state).toMatchObject({ phase: 'settled', resolution: { kind: 'applied' } });
  });

  it('does not cancel an accepted commit while its result is pending', async () => {
    const { baseline, desired } = models();
    const pendingApply = deferred<Awaited<ReturnType<ApplySessionIO['apply']>>>();
    const io = makeIO();
    vi.mocked(io.apply).mockReturnValue(pendingApply.promise);
    const session = createApplySession({
      env: 'profile-a',
      ctx: { pageId: 'page', pageRid: '1', pageClass: 'Scorecard', tabsetId: 'tabs', target: 'template' },
      baseline, desired,
      idConfig: { enabled: false, pattern: '{page}_{class}_{name}' },
      isCurrent: () => true,
    }, io, vi.fn());
    await vi.waitFor(() => {
      expect(session.state.phase).toBe('review');
      if (session.state.phase === 'review') expect(session.state.review.impact.status).toBe('ready');
    });

    const committed = session.confirm();
    session.cancel();
    expect(session.state.phase).toBe('applying');

    pendingApply.resolve({ type: 'LAYOUT_APPLY_RESULT', ok: true, noop: false });
    await expect(committed).resolves.toMatchObject({ kind: 'applied' });
    expect(session.state).toMatchObject({ phase: 'settled', resolution: { kind: 'applied' } });
  });

  it('cancels stale preparation and ignores a late impact reply', async () => {
    const { baseline, desired } = models();
    const pendingImpact = deferred<typeof impact>();
    const io = makeIO();
    vi.mocked(io.assessImpact).mockReturnValue(pendingImpact.promise);
    let current = true;
    const session = createApplySession({
      env: 'profile-a',
      ctx: { pageId: 'page', pageRid: '1', pageClass: 'Scorecard', tabsetId: 'tabs', target: 'template' },
      baseline, desired,
      idConfig: { enabled: false, pattern: '{page}_{class}_{name}' },
      isCurrent: () => current,
    }, io, vi.fn());
    await vi.waitFor(() => expect(session.state.phase).toBe('review'));

    current = false;
    pendingImpact.resolve(impact);
    await vi.waitFor(() => expect(session.state.phase).toBe('cancelled'));
    expect(io.apply).not.toHaveBeenCalled();
  });

  it('does no remote work for an empty plan', async () => {
    const { baseline } = models();
    const io = makeIO();
    const session = createApplySession({
      env: 'profile-a',
      ctx: { pageId: 'page', pageRid: '1', pageClass: 'Scorecard', tabsetId: 'tabs', target: 'template' },
      baseline, desired: baseline,
      idConfig: { enabled: false, pattern: '{page}_{class}_{name}' },
      isCurrent: () => true,
    }, io, vi.fn());

    await vi.waitFor(() => expect(session.state.phase).toBe('empty'));
    expect(io.preflightPortableIds).not.toHaveBeenCalled();
    expect(io.assessImpact).not.toHaveBeenCalled();
    expect(io.apply).not.toHaveBeenCalled();
  });

  it('freezes the preflighted portable-ID mapping into the reviewed commit', async () => {
    const { baseline } = models();
    const desired: LModel = {
      ...baseline,
      tabs: [node({ id: 'tab', kind: 'tab', className: 'Tab', children: [
        ...baseline.tabs[0].children,
        node({ id: 'new:widget', kind: 'widget', className: 'TextElement', name: 'New widget' }),
      ] })],
    };
    const io = makeIO();
    vi.mocked(io.preflightPortableIds).mockResolvedValue({
      ok: true,
      portableIds: { 'new:widget': 'page_TextElement_New_widget' },
    });
    const session = createApplySession({
      env: 'profile-a',
      ctx: { pageId: 'page', pageRid: '1', pageClass: 'Scorecard', tabsetId: 'tabs', target: 'template' },
      baseline, desired,
      idConfig: { enabled: true, pattern: '{page}_{class}_{name}' },
      isCurrent: () => true,
    }, io, vi.fn());
    await vi.waitFor(() => {
      expect(session.state.phase).toBe('review');
      if (session.state.phase === 'review') expect(session.state.review.impact.status).toBe('ready');
    });

    await session.confirm();

    expect(io.preflightPortableIds).toHaveBeenCalledTimes(1);
    expect(io.apply).toHaveBeenCalledWith(expect.objectContaining({
      portableIds: { 'new:widget': 'page_TextElement_New_widget' },
    }));
  });

  it('fails impact checks soft so they cannot wedge confirmation', async () => {
    const { baseline, desired } = models();
    const io = makeIO();
    vi.mocked(io.assessImpact).mockRejectedValue(new Error('probe offline'));
    const session = createApplySession({
      env: 'profile-a',
      ctx: { pageId: 'page', pageRid: '1', pageClass: 'Scorecard', tabsetId: 'tabs', target: 'template' },
      baseline, desired,
      idConfig: { enabled: false, pattern: '{page}_{class}_{name}' },
      isCurrent: () => true,
    }, io, vi.fn());
    await vi.waitFor(() => {
      expect(session.state.phase).toBe('review');
      if (session.state.phase === 'review') expect(session.state.review.impact.status).toBe('ready');
    });

    await session.confirm();

    expect(io.apply).toHaveBeenCalledTimes(1);
  });

  it('blocks an invalid portable-ID recipe before any remote work', async () => {
    const { baseline, desired } = models();
    const io = makeIO();
    const session = createApplySession({
      env: 'profile-a',
      ctx: { pageId: 'page', pageRid: '1', pageClass: 'Scorecard', tabsetId: 'tabs', target: 'template' },
      baseline, desired,
      idConfig: { enabled: true, pattern: '{unknown}' },
      isCurrent: () => true,
    }, io, vi.fn());

    await vi.waitFor(() => expect(session.state.phase).toBe('blocked'));
    expect(io.preflightPortableIds).not.toHaveBeenCalled();
    expect(io.assessImpact).not.toHaveBeenCalled();
    expect(io.apply).not.toHaveBeenCalled();
  });

  it('reports an unknown post-send transport result as unverified', async () => {
    const { baseline, desired } = models();
    const io = makeIO();
    vi.mocked(io.apply).mockRejectedValue(new Error('worker stopped'));
    const session = createApplySession({
      env: 'profile-a',
      ctx: { pageId: 'page', pageRid: '1', pageClass: 'Scorecard', tabsetId: 'tabs', target: 'template' },
      baseline, desired,
      idConfig: { enabled: false, pattern: '{page}_{class}_{name}' },
      isCurrent: () => true,
    }, io, vi.fn());
    await vi.waitFor(() => {
      expect(session.state.phase).toBe('review');
      if (session.state.phase === 'review') expect(session.state.review.impact.status).toBe('ready');
    });

    await expect(session.confirm()).resolves.toMatchObject({ kind: 'unverified', commitReportedOk: null });
  });

  it('treats the production no-response shape as an unverified commit', async () => {
    const { baseline, desired } = models();
    const io = makeIO();
    vi.mocked(io.apply).mockResolvedValue(undefined);
    const session = createApplySession({
      env: 'profile-a',
      ctx: { pageId: 'page', pageRid: '1', pageClass: 'Scorecard', tabsetId: 'tabs', target: 'template' },
      baseline, desired,
      idConfig: { enabled: false, pattern: '{page}_{class}_{name}' },
      isCurrent: () => true,
    }, io, vi.fn());
    await vi.waitFor(() => {
      expect(session.state.phase).toBe('review');
      if (session.state.phase === 'review') expect(session.state.review.impact.status).toBe('ready');
    });

    await expect(session.confirm()).resolves.toMatchObject({ kind: 'unverified', commitReportedOk: null });
    expect(session.state).toMatchObject({ phase: 'settled', resolution: { kind: 'unverified' } });
  });
});
