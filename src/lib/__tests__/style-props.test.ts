import { describe, it, expect } from 'vitest';
import { STYLE_PROPS, PAINT_STYLE_PROPS, COLOR_LINK_PROPS, PAINT_PROP_RESET, styleOptions } from '../style-props';
import { STYLE_NODE_FIELDS } from '../layout/types';
import type { NodeStyle } from '../layout/types';

describe('style catalog — single source, no drift', () => {
  it('STYLE_NODE_FIELDS is derived from STYLE_PROPS (same props, same order)', () => {
    // STYLE_NODE_FIELDS carries EVERY catalog prop (flags included);
    // PAINT_STYLE_PROPS is the paintable subset (paint !== false).
    expect(STYLE_NODE_FIELDS.map(f => f.prop)).toEqual(STYLE_PROPS.map(p => p.prop));
    expect([...PAINT_STYLE_PROPS]).toEqual(STYLE_PROPS.filter(p => p.paint !== false).map(p => p.prop));
  });

  it('every catalog nodeKey is a real NodeStyle field, and they cover the whole interface', () => {
    // A canonical NodeStyle with every field set — TS makes this fail to compile if a field is missing
    // or renamed, so the runtime key-set check below is locked to the interface.
    const sample: Required<NodeStyle> = {
      headerColorBid: '', fontColorBid: '', shadow: false, headerStyle: '', borderStyle: '', transparency: 0,
      showToolMenu: true, disableSearch: false,
      visibility: 'VISIBLE', shownOnLargeDisplay: true, shownOnMediumDisplay: true, shownOnSmallDisplay: true,
    };
    const interfaceKeys = new Set(Object.keys(sample));
    const catalogKeys = new Set(STYLE_PROPS.map(p => p.nodeKey));
    expect(catalogKeys).toEqual(interfaceKeys); // add a NodeStyle field ⇒ add a STYLE_PROPS entry (and vice-versa)
  });

  it('colour-link props default to the clear literal "" and enums to "None"', () => {
    expect([...COLOR_LINK_PROPS].sort()).toEqual(['fontColor', 'headerColor']);
    expect(PAINT_PROP_RESET.headerStyle).toBe('"None"');
    expect(PAINT_PROP_RESET.borderStyle).toBe('"None"');
    expect(PAINT_PROP_RESET.shadow).toBe('FALSE');
    expect(PAINT_PROP_RESET.transparency).toBe('0');
  });

  it('styleOptions exposes the enum members for the toolbar + pane-schema', () => {
    expect(styleOptions('headerStyle').map(o => o.value)).toEqual(['INSIDE', 'OUTSIDE', 'NONE']);
    expect(styleOptions('borderStyle').map(o => o.value)).toEqual(['LINE', 'NONE']);
    expect(styleOptions('shadow')).toEqual([]); // non-enum → no options
  });
});
