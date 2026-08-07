import { describe, expect, it } from 'vitest'
import {
  identityBusinessIdError,
  normalizeAndValidateIdentity,
  resolveDisplayIdentity,
} from '../object-identity'

describe('resolveDisplayIdentity', () => {
  it('makes a template ID primary and retains a distinct instance ID', () => {
    expect(resolveDisplayIdentity({
      rid: '9007199254740993',
      businessId: 'requirement_42',
      templateBusinessId: 'requirement_template',
    })).toEqual({
      primary: 'requirement_template',
      primaryKind: 'template',
      primaryLabel: 'Template ID',
      secondary: 'requirement_42',
      templateId: 'requirement_template',
      instanceId: 'requirement_42',
      rid: '9007199254740993',
    })
  })

  it('does not duplicate an instance ID equal to the template ID', () => {
    const identity = resolveDisplayIdentity({
      rid: '123',
      businessId: 'shared_item',
      templateBusinessId: 'shared_item',
    })
    expect(identity.primary).toBe('shared_item')
    expect(identity.secondary).toBeUndefined()
  })

  it('degrades to instance ID and then RID when template metadata is absent', () => {
    expect(resolveDisplayIdentity({ rid: '123', businessId: 'instance' }))
      .toMatchObject({ primary: 'instance', primaryKind: 'instance', primaryLabel: 'ID' })
    expect(resolveDisplayIdentity({ rid: '123' }))
      .toMatchObject({ primary: '123', primaryKind: 'rid', primaryLabel: 'RID' })
  })
})

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
    })
  })

  it('preserves an absent template field', () => {
    expect(normalizeAndValidateIdentity({
      businessId: 'widget_1',
      name: 'Widget',
    })).toEqual({
      ok: true,
      value: { businessId: 'widget_1', name: 'Widget' },
    })
  })

  it.each([
    [{ businessId: '', name: 'Name' }, 'businessId', 'ID is required.'],
    [{ businessId: 'bad id', name: 'Name' }, 'businessId', 'letters, numbers, and underscores'],
    [{ businessId: 'valid', name: '   ' }, 'name', 'Name is required.'],
    [{ businessId: 'valid', name: 'Name', templateBusinessId: ' ' }, 'templateBusinessId', 'Template ID is required.'],
    [{ businessId: 'valid', name: 'Name', templateBusinessId: 'bad-id' }, 'templateBusinessId', 'template ID'],
  ] as const)('returns a field-addressable error for %o', (input, field, message) => {
    const result = normalizeAndValidateIdentity(input)
    expect(result).toMatchObject({ ok: false, field })
    if (!result.ok) expect(result.error).toContain(message)
  })

  it('shares the business-ID rule with expanded-view field editing', () => {
    expect(identityBusinessIdError('123_valid')).toBeNull()
    expect(identityBusinessIdError('bad id')).toContain('letters, numbers, and underscores')
  })
})
