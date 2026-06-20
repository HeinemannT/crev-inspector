/**
 * Tests for resolveTabPageContext — the SW-side resolver that the footer,
 * editor EC `this`, and Extended Code console share. Verifies it applies the
 * SAME rule as the content side (resolvePageContext): URL `?rid=` wins, the
 * per-tab fiber cache fills routed pages, and bad rids are rejected.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveTabPageContext } from '../page-context-resolver';
import { setPageContext, clearAllContextRids } from '../context-rid';

function mockTab(url: string | undefined) {
  (globalThis as any).chrome = {
    tabs: { get: vi.fn(async (_id: number) => (url === undefined ? {} : { url })) },
  };
}

describe('resolveTabPageContext', () => {
  beforeEach(() => clearAllContextRids());
  afterEach(() => { delete (globalThis as any).chrome; });

  it('uses the URL rid on a deep-link page (URL wins, same as content)', () => {
    mockTab('https://host/Steadfast/?rid=3639562823531873849&tabrid=9124095192880784711');
    return resolveTabPageContext(5).then(pc => {
      expect(pc.rid).toBe('3639562823531873849');
      // tabRid: no fiber cached → falls back to URL tabrid.
      expect(pc.tabRid).toBe('9124095192880784711');
      expect(pc.source).toBe('url');
    });
  });

  it('falls back to the fiber cache on a routed page (no ?rid=)', async () => {
    mockTab('https://host/Steadfast/');
    setPageContext(5, { rid: '726548820039520945', tabRid: '8331448214407565939' });
    const pc = await resolveTabPageContext(5);
    expect(pc.rid).toBe('726548820039520945');
    expect(pc.tabRid).toBe('8331448214407565939');
    expect(pc.source).toBe('fiber');
  });

  it('prefers the fiber tabRid even when the URL pins one', async () => {
    mockTab('https://host/Steadfast/?rid=111&tabrid=urlTab');
    setPageContext(5, { rid: '111', tabRid: '222' });
    const pc = await resolveTabPageContext(5);
    expect(pc.tabRid).toBe('222');
  });

  it('rejects a non-BMP-shaped URL rid (BigInt safety)', async () => {
    mockTab('https://host/page?rid=notarid');
    const pc = await resolveTabPageContext(5);
    expect(pc.rid).toBeUndefined();
    expect(pc.source).toBe('none');
  });

  it('returns source=none when the tab is gone / chrome absent', async () => {
    delete (globalThis as any).chrome;
    const pc = await resolveTabPageContext(5);
    expect(pc.rid).toBeUndefined();
    expect(pc.source).toBe('none');
  });
});
