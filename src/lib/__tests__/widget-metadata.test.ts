/**
 * Tests for the widget-metadata schema:
 *  - normalizeBmpEnum (the v0.15.1 fix)
 *  - the derived ALL_* unions stay in sync with TYPE_META entries
 *  - the *For() lookup helpers
 *  - hasFlow / isInputField / hasCode flags
 */
import { describe, it, expect } from 'vitest';
import {
  normalizeBmpEnum,
  TYPE_META,
  ALL_CODE_FIELDS,
  ALL_REFERENCE_FIELDS,
  ALL_INDIRECT_FIELDS,
  ALL_CONTEXT_FIELDS,
  ALL_ENABLED_BY_PROPS,
  FLOW_TYPES,
  INPUT_FIELD_TYPES,
  codeFieldsFor,
  indirectCodeFieldsFor,
  referencesFor,
  contextFieldsFor,
  hasFlow,
  isInputField,
  hasCode,
} from '../widget-metadata';

describe('normalizeBmpEnum', () => {
  it('strips the EnumName. prefix and uppercases the rest', () => {
    expect(normalizeBmpEnum('ActionType.action')).toBe('ACTION');
    expect(normalizeBmpEnum('PersistStrategy.session')).toBe('SESSION');
    expect(normalizeBmpEnum('TextType.rich')).toBe('RICH');
    expect(normalizeBmpEnum('HeaderStyle.inside')).toBe('INSIDE');
  });
  it('returns empty for empty / null / undefined', () => {
    expect(normalizeBmpEnum('')).toBe('');
    expect(normalizeBmpEnum(undefined)).toBe('');
    expect(normalizeBmpEnum(null)).toBe('');
  });
  it('uppercases bare values (no prefix)', () => {
    expect(normalizeBmpEnum('action')).toBe('ACTION');
    expect(normalizeBmpEnum('ACTION')).toBe('ACTION');
  });
});

describe('ALL_* unions stay in sync with TYPE_META', () => {
  // The fetchObjectPane EC emits one row per ALL_* entry. If a TYPE_META
  // entry references a property that isn't in the union, the EC won't fetch
  // it — silent breakage.
  it('ALL_CODE_FIELDS contains every codeField prop in TYPE_META', () => {
    const fromMeta = new Set<string>();
    for (const meta of Object.values(TYPE_META)) {
      for (const f of meta.codeFields ?? []) fromMeta.add(f.prop);
    }
    for (const prop of fromMeta) {
      expect(ALL_CODE_FIELDS).toContain(prop);
    }
  });
  it('ALL_REFERENCE_FIELDS contains every references prop', () => {
    const fromMeta = new Set<string>();
    for (const meta of Object.values(TYPE_META)) {
      for (const r of meta.references ?? []) fromMeta.add(r.prop);
    }
    for (const prop of fromMeta) {
      expect(ALL_REFERENCE_FIELDS).toContain(prop);
    }
  });
  it('ALL_INDIRECT_FIELDS captures every indirect (prop, targetProp) pair', () => {
    for (const meta of Object.values(TYPE_META)) {
      for (const f of meta.indirectCodeFields ?? []) {
        const found = ALL_INDIRECT_FIELDS.find(x => x.prop === f.prop && x.targetProp === f.targetProp);
        expect(found).toBeDefined();
      }
    }
  });
  it('ALL_CONTEXT_FIELDS captures every contextField prop with its kind', () => {
    for (const meta of Object.values(TYPE_META)) {
      for (const f of meta.contextFields ?? []) {
        const entry = ALL_CONTEXT_FIELDS.find(x => x.prop === f.prop);
        expect(entry).toBeDefined();
        expect(entry!.kind).toBe(f.kind);
      }
    }
  });
  it('ALL_ENABLED_BY_PROPS captures every enabledBy gate', () => {
    const gates = new Set<string>();
    for (const meta of Object.values(TYPE_META)) {
      for (const f of meta.codeFields ?? []) {
        if (f.enabledBy) gates.add(f.enabledBy);
      }
    }
    for (const gate of gates) {
      expect(ALL_ENABLED_BY_PROPS).toContain(gate);
    }
  });
});

describe('*For() lookups', () => {
  it('codeFieldsFor returns ButtonInput expressions including showExpression with enabledBy', () => {
    const fields = codeFieldsFor('ButtonInput');
    const props = fields.map(f => f.prop);
    expect(props).toContain('expression');
    expect(props).toContain('showExpression');
    const show = fields.find(f => f.prop === 'showExpression');
    expect(show?.enabledBy).toBe('useShowExpression');
  });
  it('indirectCodeFieldsFor returns ActionButton.showExpression → expression', () => {
    const fields = indirectCodeFieldsFor('ActionButton');
    expect(fields).toHaveLength(1);
    expect(fields[0].prop).toBe('showExpression');
    expect(fields[0].targetProp).toBe('expression');
  });
  it('referencesFor returns ActionButton.actionObject', () => {
    const refs = referencesFor('ActionButton');
    expect(refs.map(r => r.prop)).toContain('actionObject');
  });
  it('contextFieldsFor returns ActionButton.actionType + addableItems', () => {
    const ctx = contextFieldsFor('ActionButton');
    const props = ctx.map(c => c.prop);
    expect(props).toContain('actionType');
    expect(props).toContain('addableItems');
    expect(ctx.find(c => c.prop === 'actionType')?.kind).toBe('enum');
    expect(ctx.find(c => c.prop === 'addableItems')?.kind).toBe('list-ref');
  });
  it('returns empty arrays for unknown types', () => {
    expect(codeFieldsFor('NotAType')).toEqual([]);
    expect(referencesFor('NotAType')).toEqual([]);
    expect(contextFieldsFor('NotAType')).toEqual([]);
    expect(indirectCodeFieldsFor('NotAType')).toEqual([]);
  });
});

describe('type flags', () => {
  it('hasFlow recognizes InputView / ActionButton / Label / their cascade targets', () => {
    expect(hasFlow('InputView')).toBe(true);
    expect(hasFlow('InputSet')).toBe(true); // cascade target
    expect(hasFlow('ActionButton')).toBe(true);
    expect(hasFlow('NotificationTransportGroup')).toBe(true); // cascade target
    expect(hasFlow('Label')).toBe(true);
  });
  it('hasFlow rejects non-flow types', () => {
    expect(hasFlow('Scorecard')).toBe(false);
    expect(hasFlow('TextInput')).toBe(false);
    expect(hasFlow('')).toBe(false);
  });
  it('isInputField recognizes the 5 input field types', () => {
    for (const t of ['TextInput', 'NumberInput', 'DateInput', 'ChoiceInput', 'BooleanInput']) {
      expect(isInputField(t)).toBe(true);
    }
    expect(isInputField('ButtonInput')).toBe(false); // ButtonInput is not an input field
    expect(isInputField('Label')).toBe(false);
  });
  it('hasCode is true for types with codeFields or indirectCodeFields', () => {
    expect(hasCode('ButtonInput')).toBe(true);
    expect(hasCode('ActionButton')).toBe(true); // has direct + indirect
    expect(hasCode('CustomVisualization')).toBe(true);
    expect(hasCode('InputView')).toBe(false); // refs only, no EC of its own
    expect(hasCode('CreateObjectView')).toBe(false);
  });
});

describe('FLOW_TYPES + INPUT_FIELD_TYPES are frozen sets', () => {
  it('FLOW_TYPES is a non-empty Set', () => {
    expect(FLOW_TYPES.size).toBeGreaterThan(0);
    expect(FLOW_TYPES).toBeInstanceOf(Set);
  });
  it('INPUT_FIELD_TYPES has exactly the 5 expected types', () => {
    expect(INPUT_FIELD_TYPES.size).toBe(5);
  });
});
