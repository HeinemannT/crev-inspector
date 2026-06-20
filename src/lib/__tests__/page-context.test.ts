/**
 * Tests for resolvePageContext — the URL ⊕ fiber priority that lets every
 * surface agree on "what object is BMP rendering". The fragile half (fiber
 * extraction) lives in interceptor.ts and is exercised live; this locks the
 * pure merge rules that the whole feature hinges on.
 */
import { describe, it, expect } from 'vitest';
import { resolvePageContext } from '../page-context';

describe('resolvePageContext', () => {
  it('uses the URL rid when present (explicit deep-link wins)', () => {
    const ctx = resolvePageContext({ rid: '111', tabRid: '222', tabName: 'Overview' }, { rid: '999', tabRid: '888' });
    expect(ctx.rid).toBe('111');
    expect(ctx.source).toBe('url');
  });

  it('falls back to the fiber rid on a routed page (no URL rid)', () => {
    const ctx = resolvePageContext({ tabName: 'Overview' }, { rid: '726548820039520945', tabRid: '8331448214407565939' });
    expect(ctx.rid).toBe('726548820039520945');
    expect(ctx.tabRid).toBe('8331448214407565939');
    expect(ctx.source).toBe('fiber');
  });

  it('prefers the fiber tabRid even when the URL has a rid (tab clicks do not touch the URL)', () => {
    const ctx = resolvePageContext({ rid: '111', tabRid: 'urlTab' }, { rid: '111', tabRid: 'fiberTab' });
    expect(ctx.tabRid).toBe('fiberTab');
  });

  it('keeps the URL tabRid when the fiber has none', () => {
    const ctx = resolvePageContext({ rid: '111', tabRid: 'urlTab' }, { rid: '111' });
    expect(ctx.tabRid).toBe('urlTab');
  });

  it('reports source=none when no provider has a rid', () => {
    const ctx = resolvePageContext({}, null);
    expect(ctx.rid).toBeUndefined();
    expect(ctx.source).toBe('none');
  });

  it('surfaces tabName from the URL provider regardless of rid source', () => {
    const ctx = resolvePageContext({ tabName: 'Risk' }, { rid: '111' });
    expect(ctx.tabName).toBe('Risk');
  });
});
