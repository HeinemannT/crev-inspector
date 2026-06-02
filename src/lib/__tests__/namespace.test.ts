/**
 * Namespace prefix resolution — guards the case-insensitive lookup.
 *
 * Regression: BMP classNames are PascalCase (`CeRiskAssessment`) but the
 * enterprise block of NAMESPACE_MAP was authored ALL-CAPS
 * (`CERISKASSESSMENT`). The old exact-match lookup missed and fell back to
 * `t.`, so ctrl-clicking a CeRiskAssessment pill produced the dead ref
 * `t.113` (verified live: `t.113` → MISSING, `ceras.113` → CeRiskAssessment).
 */
import { describe, it, expect } from 'vitest';
import { resolveNamespace, resolveCopyText } from '../namespace';

describe('resolveNamespace', () => {
  it('resolves enterprise PascalCase classNames (the bug)', () => {
    expect(resolveNamespace('CeRiskAssessment')).toBe('ceras');
    expect(resolveNamespace('CeVendor')).toBe('ceven');
    expect(resolveNamespace('CeTask')).toBe('cetas');
    expect(resolveNamespace('CeControlMeasure')).toBe('cecme');
  });

  it('still resolves the ALL-CAPS form (back-compat)', () => {
    expect(resolveNamespace('CERISKASSESSMENT')).toBe('ceras');
  });

  it('is fully case-insensitive', () => {
    expect(resolveNamespace('cerIskaSSessment')).toBe('ceras');
  });

  it('resolves standard PascalCase types unchanged', () => {
    expect(resolveNamespace('Group')).toBe('g');
    expect(resolveNamespace('FileResource')).toBe('r');
    expect(resolveNamespace('Category')).toBe('t');
    expect(resolveNamespace('NumberMethodConfig')).toBe('k');
  });

  it('falls back to "t" for unknown / empty types', () => {
    expect(resolveNamespace('TextElement')).toBe('t');
    expect(resolveNamespace('')).toBe('t');
  });
});

describe('resolveCopyText ctrl → reference', () => {
  it('builds the correct enterprise reference, not t.<bid>', () => {
    const out = resolveCopyText(
      { rid: '999', businessId: '113', type: 'CeRiskAssessment' },
      'ctrl',
    );
    expect(out.text).toBe('ceras.113');
    expect(out.label).toBe('ref');
  });
});
