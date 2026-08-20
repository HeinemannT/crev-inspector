import { describe, expect, it, vi } from 'vitest';
import {
  inspectObjectProperties,
  MAX_AI_INLINE_PROPERTY_CHARS,
  MAX_AI_SELECTED_PROPERTIES,
  searchTypeProperties,
} from '../property-inspection';
import type { TypeSchemaProp } from '../../types';

const properties: TypeSchemaProp[] = [
  { accessor: 'card', label: 'Detail Card', configClass: 'ReferenceMethodConfig', systemobject: false },
  { accessor: 'visible', label: 'Visible', configClass: 'BooleanMethodConfig', systemobject: false },
  { accessor: 'text', label: 'Content', configClass: 'TextMethodConfig', systemobject: false, description: 'HTML body' },
];

describe('progressive property inspection', () => {
  it('searches accessors, labels and descriptions without returning the full catalogue', () => {
    expect(searchTypeProperties(properties, 'detail').shown.map(property => property.accessor)).toEqual(['card']);
    expect(searchTypeProperties(properties, 'html').shown.map(property => property.accessor)).toEqual(['text']);
    expect(searchTypeProperties(Array.from({ length: 60 }, (_, index) => ({
      accessor: `field${index}`, label: `Field ${index}`, configClass: 'StringMethodConfig', systemobject: false,
    })), '').shown).toHaveLength(50);
  });

  it('matches natural multi-word wording to camelCase accessors without synonym retries', () => {
    const widgetProperties: TypeSchemaProp[] = [
      { accessor: 'showToolMenu', label: 'Show tool menu', configClass: 'BooleanMethodConfig', systemobject: false },
      { accessor: 'showSearch', label: 'Show search field', configClass: 'BooleanMethodConfig', systemobject: false },
      { accessor: 'toolbarColor', label: 'Toolbar color', configClass: 'ColorMethodConfig', systemobject: false },
    ];
    expect(searchTypeProperties(widgetProperties, 'tools toolbar').shown.map(property => property.accessor))
      .toEqual(['showToolMenu', 'toolbarColor']);
  });

  it('uses known enum labels to resolve natural property concepts', () => {
    const widgetProperties: TypeSchemaProp[] = [
      { accessor: 'visible', label: 'visible', configClass: 'SystemMethodConfig', systemobject: true },
      { accessor: 'visibility', label: 'visibility', configClass: 'SystemMethodConfig', systemobject: true },
    ];
    expect(searchTypeProperties(widgetProperties, 'hide').shown.map(property => property.accessor))
      .toEqual(['visibility']);
  });

  it('formats scalar, reference, inherited, long and unknown values compactly', async () => {
    const values = vi.fn(async () => [
      { accessor: 'card', state: 'value' as const, value: 'Risk card', reference: { rid: '99', businessId: 'risk_card', name: 'Risk card', type: 'Card' } },
      { accessor: 'visible', state: 'value' as const, value: 'true' },
      { accessor: 'text', state: 'value' as const, value: 'x'.repeat(MAX_AI_INLINE_PROPERTY_CHARS + 1) },
    ]);
    const result = await inspectObjectProperties({
      rid: '42', type: 'CeRiskAssessment', hasTemplate: true, instanceOverrideProps: ['card'],
    }, ['card', 'visible', 'text', 'notAProperty'], {
      schema: vi.fn(async () => ({ ok: true as const, canonical: 'CeRiskAssessment', props: properties })),
      values,
    });

    expect(values).toHaveBeenCalledWith('42', [
      { accessor: 'card', reference: true },
      { accessor: 'visible', reference: false },
      { accessor: 'text', reference: false },
    ], undefined);
    expect(result.content).toContain('card "Detail Card" [ReferenceMethodConfig] = Risk card (Card) bid=risk_card rid=99 [source=instance]');
    expect(result.content).toContain('visible "Visible" [BooleanMethodConfig] = "true" [source=template]');
    expect(result.content).toContain(`text "Content" [TextMethodConfig] = (${MAX_AI_INLINE_PROPERTY_CHARS + 1} chars; use read_code for the full raw value) [source=template]`);
    expect(result.content).toContain('Unknown properties on CeRiskAssessment: notAProperty');
    expect(result.objects).toEqual([{ rid: '99', businessId: 'risk_card', name: 'Risk card', type: 'Card' }]);
  });

  it('keeps exact reads available when the live schema probe is unavailable', async () => {
    const result = await inspectObjectProperties({
      rid: '42', type: 'CustomType', hasTemplate: false, instanceOverrideProps: [],
    }, ['customNote'], {
      schema: vi.fn(async () => ({ ok: false as const, error: 'offline' })),
      values: vi.fn(async () => [{ accessor: 'customNote', state: 'missing' as const, value: '' }]),
    });
    expect(result.content).toContain('customNote = (unset) [source=unset]');
    expect(result.content).toContain('Live schema unavailable; exact values were read directly: offline');
  });

  it('rejects an unbounded exact-property request', async () => {
    await expect(inspectObjectProperties({
      rid: '42', type: 'CustomType', hasTemplate: false, instanceOverrideProps: [],
    }, Array.from({ length: MAX_AI_SELECTED_PROPERTIES + 1 }, (_, index) => `p${index}`), {
      schema: vi.fn(), values: vi.fn(),
    })).rejects.toThrow(`At most ${MAX_AI_SELECTED_PROPERTIES}`);
  });
});
