// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../view', () => ({ render: vi.fn() }));
vi.mock('../../lib/toast', () => ({ showToast: vi.fn() }));

import { bp, resetState } from '../state';
import {
  loadPortableIdConfig,
  setPortableIdPatternDraft,
  setPortableIdsEnabled,
} from '../id-config';

const storageGet = vi.fn();
const storageSet = vi.fn();

beforeEach(async () => {
  vi.useFakeTimers();
  resetState();
  storageGet.mockReset();
  storageSet.mockReset();
  storageGet.mockResolvedValue({});
  storageSet.mockResolvedValue(undefined);
  Object.defineProperty(globalThis, 'chrome', {
    configurable: true,
    value: {
      storage: {
        local: {
          get: storageGet,
          set: storageSet,
        },
      },
    } as unknown as typeof chrome,
  });
  await loadPortableIdConfig();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Blueprint Automatic ID Assignment persistence', () => {
  it('loads one global recipe from extension-local storage', async () => {
    storageGet.mockResolvedValue({
      crev_blueprint_portable_ids: {
        enabled: true,
        pattern: '{page}_{class}_{name}_{hash4}',
      },
    });

    await loadPortableIdConfig();

    expect(bp.idConfig).toEqual({
      enabled: true,
      pattern: '{page}_{class}_{name}_{hash4}',
    });
  });

  it('debounces valid pattern drafts into storage', async () => {
    expect(setPortableIdPatternDraft('{page}_{name}')).toBeNull();

    await vi.advanceTimersByTimeAsync(349);
    expect(storageSet).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(storageSet).toHaveBeenCalledWith({
      crev_blueprint_portable_ids: {
        enabled: false,
        pattern: '{page}_{name}',
      },
    }));
  });

  it('can be disabled while the visible draft is invalid', async () => {
    storageGet.mockResolvedValue({
      crev_blueprint_portable_ids: {
        enabled: true,
        pattern: '{page}_{class}_{name}',
      },
    });
    await loadPortableIdConfig();
    expect(setPortableIdPatternDraft('{page}_{unknown}')).toBe('Unknown tag {unknown}.');

    setPortableIdsEnabled(false);

    await vi.waitFor(() => expect(storageSet).toHaveBeenCalledWith({
      crev_blueprint_portable_ids: {
        enabled: false,
        pattern: '{page}_{class}_{name}',
      },
    }));
    expect(bp.idConfig).toEqual({
      enabled: false,
      pattern: '{page}_{class}_{name}',
    });
  });
});
