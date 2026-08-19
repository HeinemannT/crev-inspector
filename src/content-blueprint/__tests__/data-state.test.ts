// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InspectorMessage } from '../../lib/types';
import type { LModel } from '../../lib/layout/types';
import type { ApplySession } from '../apply-session';
import { disableBlueprint } from '../../content-blueprint';
import { bp, resetModel, resetState } from '../state';

const sendRequest = vi.fn<() => Promise<InspectorMessage | undefined>>();
const render = vi.fn();
const showToast = vi.fn();

vi.mock('../../lib/messaging', () => ({
  sendRequest: () => sendRequest(),
}));
vi.mock('../view', () => ({ render: () => render() }));
vi.mock('../../lib/toast', () => ({ showToast: (...args: unknown[]) => showToast(...args) }));

beforeEach(async () => {
  sendRequest.mockReset(); render.mockReset(); showToast.mockReset();
  resetState(); bp.active = true; bp.gen += 1;
  const { resetColorSets } = await import('../colors');
  resetColorSets();
});

describe('Blueprint auxiliary-data states', () => {
  it('defers a page-model reset while an accepted apply is pending', () => {
    const baseline = { pageId: 'page' } as LModel;
    bp.baseline = baseline;
    bp.applySession = {
      state: { phase: 'applying' },
      confirm: vi.fn(),
      cancel: vi.fn(),
    } as unknown as ApplySession;

    expect(resetModel()).toBe(false);
    expect(bp.baseline).toBe(baseline);
    expect(bp.applySession?.state.phase).toBe('applying');
  });

  it('defers full Blueprint teardown while an accepted apply is pending', () => {
    const layer = document.createElement('div');
    document.body.appendChild(layer);
    bp.layer = layer;
    bp.applySession = {
      state: { phase: 'applying' },
      confirm: vi.fn(),
      cancel: vi.fn(),
    } as unknown as ApplySession;

    disableBlueprint();

    expect(bp.active).toBe(true);
    expect(bp.layer).toBe(layer);
    expect(layer.isConnected).toBe(true);
    expect(bp.applySession?.state.phase).toBe('applying');
  });

  it('keeps a failed colour request distinct from a valid empty workspace', async () => {
    sendRequest.mockResolvedValueOnce(undefined);
    const { colorSets, colorSetsStatus, ensureColorSets } = await import('../colors');

    await ensureColorSets();

    expect(colorSets()).toBeNull();
    expect(colorSetsStatus()).toBe('error');
    expect(render).toHaveBeenCalled();
  });

  it('accepts an explicitly empty successful colour response', async () => {
    sendRequest.mockResolvedValueOnce({ type: 'COLOR_SETS_DATA', environment: 'test', sets: [] });
    const { colorSets, colorSetsStatus, ensureColorSets } = await import('../colors');

    await ensureColorSets();

    expect(colorSets()).toEqual([]);
    expect(colorSetsStatus()).toBe('ready');
  });

  it('keeps a stale saved colour result usable and exposes its state', async () => {
    sendRequest.mockResolvedValueOnce({
      type: 'COLOR_SETS_DATA',
      environment: 'test',
      sets: [{ id: 's1', name: 'Saved', colors: [{ bid: 'red', name: 'Red', rgb: 'rgb(255,0,0)' }] }],
      stale: true,
      error: 'BMP timed out',
    });
    const { colorSets, colorSetsStatus, ensureColorSets } = await import('../colors');

    await ensureColorSets();

    expect(colorSets()?.[0]?.name).toBe('Saved');
    expect(colorSetsStatus()).toBe('stale');
  });

  it('surfaces a failed saved-style request without replacing the existing library', async () => {
    bp.presets = [{ id: 'p1', name: 'Keep me', style: {}, createdAt: 1 }];
    sendRequest.mockResolvedValueOnce(undefined);
    const { loadPresets } = await import('../presets');

    await loadPresets();

    expect(bp.presets.map(p => p.name)).toEqual(['Keep me']);
    expect(bp.presetStatus).toBe('error');
    expect(showToast).toHaveBeenCalledWith('Blueprint: could not load saved styles', 'error');
  });
});
