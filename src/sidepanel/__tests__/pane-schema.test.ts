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
import { COLOR_LINK_PROPS, PAINT_STYLE_PROPS } from '../../lib/types';

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
