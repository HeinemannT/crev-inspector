// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { InspectorMessage } from '../../lib/types';
import { bp, resetState } from '../state';

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
  it('keeps a failed colour request distinct from a valid empty workspace', async () => {
    sendRequest.mockResolvedValueOnce(undefined);
    const { colorSets, colorSetsStatus, ensureColorSets } = await import('../colors');

    await ensureColorSets();

    expect(colorSets()).toBeNull();
    expect(colorSetsStatus()).toBe('error');
    expect(render).toHaveBeenCalled();
  });

  it('accepts an explicitly empty successful colour response', async () => {
    sendRequest.mockResolvedValueOnce({ type: 'COLOR_SETS_DATA', sets: [] });
    const { colorSets, colorSetsStatus, ensureColorSets } = await import('../colors');

    await ensureColorSets();

    expect(colorSets()).toEqual([]);
    expect(colorSetsStatus()).toBe('ready');
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
