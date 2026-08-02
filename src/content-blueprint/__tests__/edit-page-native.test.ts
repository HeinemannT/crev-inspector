// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import {
  releaseNativeEditPage,
  setNativeEditPageSuppressed,
  trackNativeEditPage,
} from '../edit-page-native';

afterEach(() => {
  releaseNativeEditPage();
  document.body.textContent = '';
});

describe('native EditPage suppression', () => {
  it('makes the covered form inert and restores its original state for peek and exit', () => {
    const host = document.createElement('div');
    host.setAttribute('aria-hidden', 'false');
    document.body.appendChild(host);

    trackNativeEditPage(host);
    setNativeEditPageSuppressed(true);
    expect(host.inert).toBe(true);
    expect(host.getAttribute('aria-hidden')).toBe('true');

    setNativeEditPageSuppressed(false);
    expect(host.inert).toBe(false);
    expect(host.getAttribute('aria-hidden')).toBe('false');

    setNativeEditPageSuppressed(true);
    releaseNativeEditPage();
    expect(host.inert).toBe(false);
    expect(host.getAttribute('aria-hidden')).toBe('false');
  });

  it('restores the previous host when BMP remounts the EditPage', () => {
    const first = document.createElement('div');
    const second = document.createElement('div');

    trackNativeEditPage(first);
    setNativeEditPageSuppressed(true);
    trackNativeEditPage(second);

    expect(first.inert).toBe(false);
    setNativeEditPageSuppressed(true);
    expect(second.inert).toBe(true);
  });
});
