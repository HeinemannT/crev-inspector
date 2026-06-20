/**
 * Tests for the SW-side per-tab page-context store in context-rid.ts — the
 * cache the footer (GET_CONTEXT_RID) and editor EC `this` (getCurrentPageRid)
 * read so they see the bound object on BMP's custom-routed pages.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  setPageContext, getPageContext, deletePageContext,
  setContextRid, getContextRid, deleteContextRid, clearAllContextRids,
} from '../context-rid';

describe('page-context store', () => {
  beforeEach(() => clearAllContextRids());

  it('stores and reads a page context per tab', () => {
    setPageContext(7, { rid: '726548820039520945', tabRid: '8331448214407565939' });
    expect(getPageContext(7)).toEqual({ rid: '726548820039520945', tabRid: '8331448214407565939' });
  });

  it('an empty context clears the entry rather than caching a blank', () => {
    setPageContext(7, { rid: '111' });
    setPageContext(7, {});
    expect(getPageContext(7)).toBeUndefined();
  });

  it('deletePageContext drops only the page context, not the right-click pin', () => {
    setContextRid(7, { rid: 'pinned' });
    setPageContext(7, { rid: 'page' });
    deletePageContext(7);
    expect(getPageContext(7)).toBeUndefined();
    expect(getContextRid(7)).toEqual({ rid: 'pinned' });
  });

  it('deleteContextRid (tab closed) clears BOTH maps for the tab', () => {
    setContextRid(7, { rid: 'pinned' });
    setPageContext(7, { rid: 'page' });
    deleteContextRid(7);
    expect(getContextRid(7)).toBeUndefined();
    expect(getPageContext(7)).toBeUndefined();
  });

  it('clearAllContextRids wipes page contexts too', () => {
    setPageContext(1, { rid: 'a' });
    setPageContext(2, { rid: 'b' });
    clearAllContextRids();
    expect(getPageContext(1)).toBeUndefined();
    expect(getPageContext(2)).toBeUndefined();
  });
});
