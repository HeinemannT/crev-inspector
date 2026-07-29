import { describe, expect, it } from 'vitest';
import {
  identityBusinessIdError,
  normalizeAndValidateIdentity,
} from '../object-identity';

describe('object identity validation', () => {
  it('normalizes valid instance and template identity values', () => {
    expect(normalizeAndValidateIdentity({
      businessId: '  4957_widget  ',
      name: '  Widget name  ',
      templateBusinessId: '  template_2  ',
    })).toEqual({
      ok: true,
      value: {
        businessId: '4957_widget',
        name: 'Widget name',
        templateBusinessId: 'template_2',
      },
    });
  });

  it('preserves an absent template field', () => {
    expect(normalizeAndValidateIdentity({
      businessId: 'widget_1',
      name: 'Widget',
    })).toEqual({
      ok: true,
      value: { businessId: 'widget_1', name: 'Widget' },
    });
  });

  it.each([
    [{ businessId: '', name: 'Name' }, 'businessId', 'ID is required.'],
    [{ businessId: 'bad id', name: 'Name' }, 'businessId', 'letters, numbers, and underscores'],
    [{ businessId: 'valid', name: '   ' }, 'name', 'Name is required.'],
    [{ businessId: 'valid', name: 'Name', templateBusinessId: ' ' }, 'templateBusinessId', 'Template ID is required.'],
    [{ businessId: 'valid', name: 'Name', templateBusinessId: 'bad-id' }, 'templateBusinessId', 'template ID'],
  ] as const)('returns a field-addressable error for %o', (input, field, message) => {
    const result = normalizeAndValidateIdentity(input);
    expect(result).toMatchObject({ ok: false, field });
    if (!result.ok) expect(result.error).toContain(message);
  });

  it('shares the business-ID rule with expanded-view field editing', () => {
    expect(identityBusinessIdError('123_valid')).toBeNull();
    expect(identityBusinessIdError('bad id')).toContain('letters, numbers, and underscores');
  });
});
