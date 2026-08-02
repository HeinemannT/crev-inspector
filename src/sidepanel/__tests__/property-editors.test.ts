// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { propertyAccessorEditor, stringEditor } from '../property-editors';

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
    expect(input.disabled).toBe(false);
    expect(input.title).toBe('Properties shared by CeService');
    input.click();
    const options = [...editor.querySelectorAll<HTMLElement>('.crev-property-picker__option')];
    expect(options.map(option => option.dataset.value)).toEqual(['', 'name', 'domain_owner']);

    options[2].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(onChange).toHaveBeenCalledWith('domain_owner');
  });

  it('does not commit arbitrary text and permits clearing an existing mapping', () => {
    const onChange = vi.fn();
    const editor = propertyAccessorEditor(
      { value: 'name', original: 'name', dirty: false, onChange },
      [{ value: 'name' }],
    );
    const input = editor.querySelector('input')!;
    input.click();
    input.value = 'not_a_real_property';
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    expect(onChange).not.toHaveBeenCalled();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(input.value).toBe('name');

    input.click();
    editor.querySelector<HTMLElement>('[data-value=""]')!
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('surfaces a stale current mapping without accepting other free text', () => {
    const editor = propertyAccessorEditor(
      { value: 'legacy_field', original: 'legacy_field', dirty: false, onChange: vi.fn() },
      [{ value: 'name' }],
    );
    editor.querySelector('input')!.click();
    const options = [...editor.querySelectorAll<HTMLElement>('.crev-property-picker__option')];
    expect(options.map(option => option.dataset.value)).toEqual(['', 'legacy_field', 'name']);
    expect(options[1].textContent).toContain('legacy_field (current)');
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

describe('stringEditor', () => {
  it('stages plain text on commit without re-rendering on each keystroke', () => {
    const onChange = vi.fn();
    const editor = stringEditor({
      value: '',
      original: '',
      dirty: false,
      onChange,
    });
    const input = editor.querySelector<HTMLInputElement>('.prop-string-input')!;
    input.value = 'Shown inside the field';
    input.dispatchEvent(new Event('input'));
    expect(onChange).not.toHaveBeenCalled();
    input.dispatchEvent(new Event('change'));
    expect(onChange).toHaveBeenCalledWith('Shown inside the field');
  });
});
