/**
 * Tests for the EC identifier / RID guards. These run at every EC
 * interpolation slot (ec-codegen.ts) and at every save (bmp-client.ts),
 * so a regression here would silently let hostile strings into BMP-
 * executed EC. Worth a thorough sweep.
 */
import { describe, it, expect } from 'vitest';
import { validateEcIdentifier, validateRid } from '../ec-guards';

describe('validateEcIdentifier', () => {
  it('accepts simple identifiers', () => {
    expect(validateEcIdentifier('disableSearch')).toBe('disableSearch');
    expect(validateEcIdentifier('expression')).toBe('expression');
    expect(validateEcIdentifier('headerColor')).toBe('headerColor');
    expect(validateEcIdentifier('_underscore_first')).toBe('_underscore_first');
    expect(validateEcIdentifier('a')).toBe('a');
    expect(validateEcIdentifier('A1')).toBe('A1');
  });

  it('accepts identifiers with digits, just not leading', () => {
    expect(validateEcIdentifier('prop123')).toBe('prop123');
    expect(validateEcIdentifier('column_2')).toBe('column_2');
  });

  it('rejects identifiers starting with a digit', () => {
    expect(() => validateEcIdentifier('1prop')).toThrow(/Invalid EC identifier/);
    expect(() => validateEcIdentifier('123')).toThrow(/Invalid EC identifier/);
  });

  it('rejects whitespace, punctuation, and EC syntax characters', () => {
    expect(() => validateEcIdentifier(' disableSearch')).toThrow(/Invalid EC identifier/);
    expect(() => validateEcIdentifier('disableSearch ')).toThrow(/Invalid EC identifier/);
    expect(() => validateEcIdentifier('a, b')).toThrow(/Invalid EC identifier/);
    expect(() => validateEcIdentifier('a := b')).toThrow(/Invalid EC identifier/);
    expect(() => validateEcIdentifier('a(b)')).toThrow(/Invalid EC identifier/);
    expect(() => validateEcIdentifier('a.b')).toThrow(/Invalid EC identifier/);
    expect(() => validateEcIdentifier('a-b')).toThrow(/Invalid EC identifier/);
  });

  it('rejects empty string', () => {
    expect(() => validateEcIdentifier('')).toThrow(/Invalid EC identifier/);
  });

  it('rejects newlines and control characters', () => {
    expect(() => validateEcIdentifier('a\nb')).toThrow(/Invalid EC identifier/);
    expect(() => validateEcIdentifier('a\tb')).toThrow(/Invalid EC identifier/);
  });

  it('rejects unicode lookalikes that could spoof normal identifiers', () => {
    // Cyrillic 'а' (U+0430) instead of Latin 'a' — same shape, different code point
    expect(() => validateEcIdentifier('disablеSearch')).toThrow();
  });
});

describe('validateRid', () => {
  it('accepts positive integer strings', () => {
    expect(validateRid('123')).toBe('123');
    expect(validateRid('1563630904731936877')).toBe('1563630904731936877');
  });

  it('accepts negative integer strings', () => {
    expect(validateRid('-1')).toBe('-1');
    expect(validateRid('-1234')).toBe('-1234');
  });

  it('rejects non-numeric strings', () => {
    expect(() => validateRid('abc')).toThrow(/Invalid RID/);
    expect(() => validateRid('12.5')).toThrow(/Invalid RID/);
    expect(() => validateRid('12e3')).toThrow(/Invalid RID/);
    expect(() => validateRid('')).toThrow(/Invalid RID/);
  });

  it('rejects whitespace-padded numbers', () => {
    // Defence-in-depth: even if EC happens to parse these, we reject.
    expect(() => validateRid(' 123')).toThrow();
    expect(() => validateRid('123 ')).toThrow();
  });

  it('rejects injection attempts', () => {
    expect(() => validateRid('123); _o.delete()')).toThrow();
    expect(() => validateRid('123\n_o.change()')).toThrow();
  });
});
