// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { propertyAccessorEditor } from '../property-editors';

describe('propertyAccessorEditor', () => {
  beforeEach(() => {
    document.body.textContent = '';
  });

  it('renders a compact searchable property list and commits exact accessors', () => {
    const onChange = vi.fn();
    const editor = propertyAccessorEditor(
      { value: 'name', original: 'name', dirty: false, onChange },
      [
        { value: 'name', label: 'Name — name' },
        { value: 'domain_owner', label: 'Owner — domain_owner' },
      ],
      { source: 'CeService' },
    );
    const input = editor.querySelector('input')!;
    const options = [...editor.querySelectorAll('option')];
    expect(input.disabled).toBe(false);
    expect(input.title).toBe('Properties shared by CeService');
    expect(options.map(option => option.value)).toEqual(['name', 'domain_owner']);

    input.value = 'domain_owner';
    input.dispatchEvent(new Event('change'));
    expect(onChange).toHaveBeenCalledWith('domain_owner');
  });

  it('rejects arbitrary text but permits clearing an existing mapping', () => {
    const onChange = vi.fn();
    const editor = propertyAccessorEditor(
      { value: 'name', original: 'name', dirty: false, onChange },
      [{ value: 'name' }],
    );
    const input = editor.querySelector('input')!;
    input.reportValidity = vi.fn(() => false);

    input.value = 'not_a_real_property';
    input.dispatchEvent(new Event('change'));
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe('name');
    expect(input.validationMessage).toBe('Choose a property from the list.');

    input.value = '';
    input.dispatchEvent(new Event('change'));
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('surfaces a stale current mapping without accepting other free text', () => {
    const editor = propertyAccessorEditor(
      { value: 'legacy_field', original: 'legacy_field', dirty: false, onChange: vi.fn() },
      [{ value: 'name' }],
    );
    const options = [...editor.querySelectorAll('option')];
    expect(options.map(option => option.value)).toEqual(['legacy_field', 'name']);
    expect(options[0].label).toBe('legacy_field (current)');
  });

  it('stays disabled while properties are unavailable', () => {
    const loading = propertyAccessorEditor(
      { value: '', original: '', dirty: false, onChange: vi.fn() },
      undefined,
      { loading: true },
    );
    expect(loading.querySelector('input')!.disabled).toBe(true);
    expect(loading.querySelector('input')!.placeholder).toBe('Loading properties…');
  });
});
