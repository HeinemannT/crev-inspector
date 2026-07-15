import { describe, expect, it } from 'vitest';
import { urlPageOwnerKey } from '../tab-awareness';

describe('tab-awareness URL page ownership', () => {
  it('ignores tab and presentation query changes', () => {
    const a = urlPageOwnerKey('https://bmp.test/Steadfast/?rid=999999&tabrid=111111&period=M');
    const b = urlPageOwnerKey('https://bmp.test/Steadfast/?rid=999999&tabrid=222222&period=Y&ytd=true');
    expect(a).toBe(b);
  });

  it('changes for a different owner, workspace path, or origin', () => {
    const base = urlPageOwnerKey('https://bmp.test/Steadfast/?rid=999999');
    expect(urlPageOwnerKey('https://bmp.test/Steadfast/?rid=888888')).not.toBe(base);
    expect(urlPageOwnerKey('https://bmp.test/Other/?rid=999999')).not.toBe(base);
    expect(urlPageOwnerKey('https://other.test/Steadfast/?rid=999999')).not.toBe(base);
  });

  it('keeps a routed root stable across query-only changes', () => {
    expect(urlPageOwnerKey('https://bmp.test/Steadfast/?period=M'))
      .toBe(urlPageOwnerKey('https://bmp.test/Steadfast/?period=Y&ytd=true'));
  });
});
