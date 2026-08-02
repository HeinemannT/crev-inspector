// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { propertyPicker } from '../property-picker';

const options = [
  {
    value: 'risk_owner',
    propertyId: 'ceRiskAssessmentOwner',
    label: 'Risk owner',
    configClass: 'ReferenceMethodConfig',
  },
  {
    value: 'inherent_likelihood',
    propertyId: 'ceRiskAssessmentInherentLikelihood',
    label: 'Inherent likelihood',
    configClass: 'HistoricalNumberMethodConfig',
  },
];

describe('propertyPicker', () => {
  beforeEach(() => {
    document.body.textContent = '';
  });

  it('shows the stable property ID but commits the exact accessor', () => {
    const onChange = vi.fn();
    const picker = propertyPicker({
      value: 'risk_owner',
      options,
      onChange,
    });
    document.body.appendChild(picker);

    const input = picker.querySelector<HTMLInputElement>('.crev-property-picker__input')!;
    expect(input.value).toBe('ceRiskAssessmentOwner');
    input.click();
    expect(input.value).toBe('');
    expect(input.placeholder).toBe('Search properties');
    expect(picker.querySelector('.crev-property-picker__badge .bdg-property')).toBeTruthy();
    const selected = picker.querySelector<HTMLElement>('.crev-property-picker__option.is-selected')!;
    expect(selected.dataset.value).toBe('risk_owner');
    expect(selected.querySelector('.crev-property-picker__option-state')).toBeNull();

    picker.querySelector<HTMLElement>('[data-value="inherent_likelihood"]')!
      .dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(onChange).toHaveBeenCalledWith('inherent_likelihood');
  });

  it('renders the clear action without wasting a property-badge column', () => {
    const picker = propertyPicker({
      value: 'risk_owner',
      options,
      onChange: vi.fn(),
    });
    document.body.appendChild(picker);
    picker.querySelector<HTMLInputElement>('.crev-property-picker__input')!.click();

    const clear = picker.querySelector<HTMLElement>('[data-value=""]')!;
    expect(clear.classList.contains('is-clear')).toBe(true);
    expect(clear.querySelector('.crev-property-picker__option-badge')).toBeNull();
  });

  it('treats historical variants as their base search family and keeps the badge', () => {
    const picker = propertyPicker({
      value: 'risk_owner',
      options,
      onChange: vi.fn(),
      density: 'compact',
    });
    document.body.appendChild(picker);

    const input = picker.querySelector<HTMLInputElement>('.crev-property-picker__input')!;
    input.click();
    input.value = 'num inherent';
    input.dispatchEvent(new Event('input'));

    expect(picker.classList.contains('is-searching')).toBe(true);
    expect(picker.querySelector('.crev-property-picker__badge .bdg-property')).toBeTruthy();
    expect([...picker.querySelectorAll<HTMLElement>('.crev-property-picker__option')]
      .map(option => option.dataset.value)).toEqual(['inherent_likelihood']);
  });
});
