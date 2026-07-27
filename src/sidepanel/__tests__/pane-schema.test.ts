/**
 * Guards for the appearance-property coverage in pane-schema.
 *
 * The static `availableOn` sets are the FIRST-RENDER fallback before the
 * live type schema lands (pane-schema-runtime overrides them). They were
 * hand-curated from decompiled BeanInfo and had drifted: 57 appearance-
 * bearing types were missing, and a phantom `bgColor` prop (no such BMP
 * accessor) was present. These tests pin the fix so it can't regress.
 *
 * Ground truth: every BeanInfo declaring the WebChild `shadow` descriptor
 * also declares HasWidgetColors (headerColor/fontColor) — an identical
 * 103-type family (minus the abstract WebChildReference wrapper).
 */
import { describe, it, expect } from 'vitest';
import { APPEARANCE_TYPES, PROP_GROUPS, findPropDef } from '../pane-schema';
import { PANE_PROPS } from '../../lib/bmp-client';
import { COLOR_LINK_PROPS, PAINT_STYLE_PROPS, PAINT_PROP_RESET, STYLE_PROPS } from '../../lib/types';

describe('APPEARANCE_TYPES coverage', () => {
  it('includes the widget types the old WebChild set omitted', () => {
    // A sample of the 57 types missing from the pre-fix WEB_CHILD_TYPES.
    for (const t of [
      'Dashboard', 'ImageView', 'URLView', 'Status', 'SimpleStatus',
      'Perspective', 'StrategicObjective', 'Kpi', 'Indicator',
      'CreateObjectView', 'DescriptionView', 'StandardChart', 'RiskChart',
      'BowtieDiagram', 'LinkMap', 'PdfView', 'PowerBi', 'SpreadsheetView',
    ]) {
      expect(APPEARANCE_TYPES.has(t), `${t} should be appearance-bearing`).toBe(true);
    }
  });

  it('still includes the original list + chart widgets', () => {
    for (const t of ['ExtendedTable', 'IssueList', 'RiskList', 'BarChart', 'WaterfallChart']) {
      expect(APPEARANCE_TYPES.has(t)).toBe(true);
    }
  });

  it('excludes non-widget node types (no widget colours/styling)', () => {
    for (const t of ['Organisation', 'Tab', 'Container', 'Risk']) {
      expect(APPEARANCE_TYPES.has(t), `${t} should NOT be appearance-bearing`).toBe(false);
    }
  });

  it('covers the full 103-type family', () => {
    expect(APPEARANCE_TYPES.size).toBe(103);
  });
});

describe('appearance props gate to APPEARANCE_TYPES', () => {
  it('gates every styling + colour prop on APPEARANCE_TYPES (no ungated colour editors)', () => {
    for (const p of ['shadow', 'headerStyle', 'borderStyle', 'transparency', 'headerColor', 'fontColor']) {
      const def = findPropDef(p);
      expect(def, `${p} should exist`).toBeTruthy();
      expect(def!.availableOn, `${p} must be gated`).toBe(APPEARANCE_TYPES);
    }
  });
});

describe('bgColor is fully removed (phantom prop)', () => {
  it('is not in any pane-schema group', () => {
    const all = PROP_GROUPS.flatMap(g => g.props.map(p => p.prop));
    expect(all).not.toContain('bgColor');
  });
  it('is not in the PANE_PROPS allowlist (no phantom read/write)', () => {
    expect(PANE_PROPS as readonly string[]).not.toContain('bgColor');
  });
  it('is not in COLOR_LINK_PROPS or PAINT_STYLE_PROPS', () => {
    expect(COLOR_LINK_PROPS.has('bgColor')).toBe(false);
    expect(PAINT_STYLE_PROPS as readonly string[]).not.toContain('bgColor');
  });
  it('keeps the two real HasWidgetColors accessors', () => {
    expect(COLOR_LINK_PROPS.has('headerColor')).toBe(true);
    expect(COLOR_LINK_PROPS.has('fontColor')).toBe(true);
  });
});

describe('style-prop catalog is the single source (locks pane-schema ⇄ style-props)', () => {
  it('COLOR_LINK_PROPS exactly matches the kind:"color" props in pane-schema', () => {
    const colorKinds = PROP_GROUPS.flatMap(g => g.props).filter(p => p.kind === 'color').map(p => p.prop).sort();
    expect(colorKinds).toEqual([...COLOR_LINK_PROPS].sort());
  });
  it('every paintable style prop has a pane-schema PropDef', () => {
    for (const p of PAINT_STYLE_PROPS) {
      expect(findPropDef(p), `${p} should have a PropDef`).toBeTruthy();
    }
  });
  it('PAINT_PROP_RESET covers every catalog prop (paintable + flags) with type-correct literals', () => {
    // The reset map spans the WHOLE catalog (flags need type-correct clears
    // too); the paintbrush copy-set is the paintable subset of it.
    expect(Object.keys(PAINT_PROP_RESET).sort()).toEqual(STYLE_PROPS.map(p => p.prop).sort());
    for (const p of PAINT_STYLE_PROPS) expect(PAINT_PROP_RESET[p]).toBeTruthy();
    expect(PAINT_PROP_RESET.headerColor).toBe('""');   // colour link clears with ""
    expect(PAINT_PROP_RESET.transparency).toBe('0');     // number
    expect(PAINT_PROP_RESET.shadow).toBe('FALSE');       // boolean
    expect(PAINT_PROP_RESET.borderStyle).toBe('"None"'); // enum
  });
});

describe('EditField property mapping', () => {
  it('uses the specialized property picker and is allowlisted for saving', () => {
    const def = findPropDef('propertyMapping');
    expect(def?.kind).toBe('property');
    expect(def?.availableOn?.has('EditField')).toBe(true);
    expect(def?.availableOn?.has('EditPage')).toBe(false);
    expect(PANE_PROPS).toContain('propertyMapping');
  });

  it('keeps essential field behavior in the same type-gated section', () => {
    expect(findPropDef('required')).toMatchObject({ kind: 'boolean', label: 'Required' });
    expect(findPropDef('placeholder')).toMatchObject({ kind: 'string', label: 'Placeholder' });
    expect(findPropDef('propertyHint')).toMatchObject({ kind: 'string', label: 'Help text' });
    for (const prop of ['required', 'placeholder', 'propertyHint'] as const) {
      expect(findPropDef(prop)?.availableOn?.has('EditField')).toBe(true);
      expect(PANE_PROPS).toContain(prop);
    }
  });
});

describe('Label default configuration', () => {
  it('exposes writable text type and advanced-default controls only on Label', () => {
    expect(findPropDef('textInputType')).toMatchObject({
      kind: 'enum',
      label: 'Text type',
      options: [
        { value: 'SINGLELINE', label: 'Single line' },
        { value: 'MULTILINE', label: 'Multi-line' },
        { value: 'RICH', label: 'Rich text' },
      ],
    });
    expect(findPropDef('advancedDefault')).toMatchObject({ kind: 'boolean', label: 'Advanced default' });
    for (const prop of ['textInputType', 'advancedDefault'] as const) {
      expect(findPropDef(prop)?.availableOn?.has('Label')).toBe(true);
      expect(findPropDef(prop)?.availableOn?.has('TextInput')).toBe(false);
      expect(PANE_PROPS).toContain(prop);
    }
  });
});
