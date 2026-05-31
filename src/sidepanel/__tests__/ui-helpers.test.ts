/**
 * Tests for small UI-side helpers introduced in this session.
 *
 * Both are pure functions with security or UX implications:
 *   - isInsecureUrl drives the inline HTTP-downgrade warning
 *   - cleanWidgetName strips a noise prefix from BMP's data-test attributes
 *
 * Pure functions are cheap to test and the cost of a regression is high
 * (silent http password posting / "widget-widget-Foo" in the UI), so they
 * earn dedicated coverage.
 */
import { describe, it, expect } from 'vitest';
import { isInsecureUrl } from '../tabs/connect-tab';
import { cleanWidgetName } from '../tabs/workshop-layout-pane';

describe('isInsecureUrl (HTTP downgrade warning trigger)', () => {
  it('returns true for explicit http://', () => {
    expect(isInsecureUrl('http://bmp.example.com/Steadfast')).toBe(true);
    expect(isInsecureUrl('http://localhost:8080')).toBe(true);
  });

  it('is case-insensitive', () => {
    expect(isInsecureUrl('HTTP://example.com')).toBe(true);
    expect(isInsecureUrl('Http://example.com')).toBe(true);
  });

  it('tolerates leading whitespace (paste artifacts)', () => {
    expect(isInsecureUrl('  http://example.com')).toBe(true);
  });

  it('returns false for https://', () => {
    expect(isInsecureUrl('https://example.com')).toBe(false);
  });

  it('returns false for bare hostnames', () => {
    // normalizeUrl() upgrades these to https:// before any request goes
    // out, so the warning would be misleading. Explicit downgrade only.
    expect(isInsecureUrl('example.com/Steadfast')).toBe(false);
    expect(isInsecureUrl('bmp.example.com')).toBe(false);
  });

  it('returns false for empty / whitespace input', () => {
    expect(isInsecureUrl('')).toBe(false);
    expect(isInsecureUrl('   ')).toBe(false);
  });

  it('rejects "httpsmuggled.com" — not a false positive on http* prefix', () => {
    // Without the `://` boundary the regex would match "httpsmuggled" → wrong.
    expect(isInsecureUrl('httpsmuggled.com')).toBe(false);
  });
});

describe('cleanWidgetName (strip BMP authoring prefix)', () => {
  it('strips a leading "widget-" prefix', () => {
    expect(cleanWidgetName('widget-RiskPicker')).toBe('RiskPicker');
  });

  it('is case-insensitive on the prefix', () => {
    expect(cleanWidgetName('Widget-FooBar')).toBe('FooBar');
    expect(cleanWidgetName('WIDGET-Foo')).toBe('Foo');
  });

  it('only strips the leading occurrence', () => {
    // A real BMP author wouldn't double-prefix, but defining the behavior
    // pins it for surprise-prone edge cases. Only the first `widget-` goes.
    expect(cleanWidgetName('widget-widget-Foo')).toBe('widget-Foo');
  });

  it('passes through names without the prefix unchanged', () => {
    expect(cleanWidgetName('RiskPicker')).toBe('RiskPicker');
    expect(cleanWidgetName('myDashboard')).toBe('myDashboard');
  });

  it('returns empty string for undefined / empty input', () => {
    expect(cleanWidgetName(undefined)).toBe('');
    expect(cleanWidgetName('')).toBe('');
  });

  it('is idempotent on cleaned names', () => {
    const once = cleanWidgetName('widget-Foo');
    expect(cleanWidgetName(once)).toBe(once);
  });
});
