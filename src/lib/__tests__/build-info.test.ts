import { describe, expect, it } from 'vitest';
import { BUILD_ID, runtimeVersion } from '../build-info';

describe('runtime build identity', () => {
  it('is compact and included beside the manifest version', () => {
    expect(BUILD_ID).toBe('__CREV_BUILD_ID__');
    expect(runtimeVersion('0.8.1')).toBe(`v0.8.1 · ${BUILD_ID}`);
  });
});
