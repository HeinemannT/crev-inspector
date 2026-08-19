import { describe, expect, it, vi } from 'vitest';
import { requestObjectViewColorSets } from '../color-picker-request';

describe('Object View colour-picker request routing', () => {
  it('delivers the one-shot worker response to the shared picker', async () => {
    const response = {
      type: 'COLOR_SETS_DATA' as const,
      environment: 'pro@https://bmp.example/',
      sets: [{ id: 'brand', name: 'Brand', colors: [] }],
    };
    const deliver = vi.fn();

    await requestObjectViewColorSets(
      { type: 'FETCH_COLOR_SETS' },
      vi.fn(async () => response),
      deliver,
    );

    expect(deliver).toHaveBeenCalledWith(response);
  });

  it('turns a missing or rejected response into a visible first-load error', async () => {
    const missing = vi.fn();
    await requestObjectViewColorSets(
      { type: 'FETCH_COLOR_SETS' },
      vi.fn(async () => undefined),
      missing,
    );
    expect(missing).toHaveBeenCalledWith(expect.objectContaining({
      type: 'COLOR_SETS_DATA',
      sets: [],
      error: 'No response from the extension',
    }));

    const rejected = vi.fn();
    await requestObjectViewColorSets(
      { type: 'FETCH_COLOR_SETS', force: true },
      vi.fn(async () => { throw new Error('BMP timed out'); }),
      rejected,
    );
    expect(rejected).toHaveBeenCalledWith(expect.objectContaining({ error: 'BMP timed out' }));
  });
});
