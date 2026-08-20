import { describe, expect, it, vi } from 'vitest';
import { WorkspaceColorCatalogue, type ColorSetsMessage } from '../workspace-color-catalogue';

const savedSets = [{
  id: 'brand',
  name: 'Brand',
  colors: [{ bid: 'brand_red', name: 'Brand red', rgb: 'rgb(200,10,20)' }],
}];

describe('workspace colour catalogue', () => {
  it('distinguishes a failed first load from a successful empty workspace', () => {
    const catalogue = new WorkspaceColorCatalogue();
    catalogue.receive({ type: 'COLOR_SETS_DATA', environment: 'demo', sets: [], error: 'BMP timed out' });
    expect(catalogue.snapshot()).toMatchObject({ sets: null, status: 'error', error: 'BMP timed out' });

    catalogue.receive({ type: 'COLOR_SETS_DATA', environment: 'demo', sets: [] });
    expect(catalogue.snapshot()).toMatchObject({ sets: [], status: 'ready', error: null });
  });

  it('keeps last-known-good colours indexed when a refresh fails', () => {
    const catalogue = new WorkspaceColorCatalogue();
    catalogue.receive({ type: 'COLOR_SETS_DATA', environment: 'demo', sets: savedSets });
    catalogue.receive({ type: 'COLOR_SETS_DATA', environment: 'demo', sets: [], error: 'BMP timed out' });

    expect(catalogue.snapshot()).toMatchObject({ sets: savedSets, status: 'stale' });
    expect(catalogue.lookup('brand_red')).toEqual({ name: 'Brand red', rgb: 'rgb(200,10,20)' });
  });

  it('normalizes missing and rejected transport responses into catalogue errors', async () => {
    const catalogue = new WorkspaceColorCatalogue();
    await catalogue.load(async () => undefined);
    expect(catalogue.snapshot()).toMatchObject({ status: 'error', error: 'No response from the extension' });

    catalogue.reset();
    await catalogue.load(async () => { throw new Error('BMP timed out'); });
    expect(catalogue.snapshot()).toMatchObject({ status: 'error', error: 'BMP timed out' });
  });

  it('deduplicates concurrent loads and ignores a response invalidated by reset', async () => {
    let resolve!: (value: ColorSetsMessage | undefined) => void;
    const fetch = vi.fn(() => new Promise<ColorSetsMessage | undefined>(done => { resolve = done; }));
    const catalogue = new WorkspaceColorCatalogue();
    const first = catalogue.load(fetch);
    const second = catalogue.load(fetch);
    await Promise.resolve();
    expect(fetch).toHaveBeenCalledOnce();

    catalogue.reset();
    resolve({ type: 'COLOR_SETS_DATA', environment: 'old', sets: savedSets });
    await Promise.all([first, second]);

    expect(catalogue.snapshot()).toMatchObject({ sets: null, status: 'idle' });
    expect(catalogue.lookup('brand_red')).toBeNull();
  });
});
