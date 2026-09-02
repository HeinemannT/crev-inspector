import { describe, expect, it } from 'vitest';
import { blueprintFontFaceCss } from '../font-face';

describe('Blueprint font injection', () => {
  it('builds private font faces from extension asset URLs', () => {
    const css = blueprintFontFaceCss(path => `chrome-extension://test/${path}`);

    expect(css).toContain("font-family:'BPInter'");
    expect(css).toContain('chrome-extension://test/assets/inter-400.woff2');
    expect(css).toContain('chrome-extension://test/assets/jetbrains-mono-400.woff2');
  });

  it('falls back without throwing after Chrome invalidates the old extension context', () => {
    const invalidated = () => { throw new Error('Extension context invalidated.'); };
    expect(() => blueprintFontFaceCss(invalidated)).not.toThrow();
    expect(blueprintFontFaceCss(invalidated)).toBe('');
  });
});
