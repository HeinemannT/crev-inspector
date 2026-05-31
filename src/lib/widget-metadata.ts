/**
 * Static widget metadata — drives the Code, References, and Flow sections
 * of the sidepanel object pane.
 *
 * Pure data. No I/O. Single source of truth for "which BMP types have which
 * fields, references, and behavioral context."
 *
 * Field categories:
 *   - codeFields:         direct EC strings on the object (expression, html, …)
 *                         optional `enabledBy: <bool prop>` greys it when off
 *   - indirectCodeFields: EC reached by following a reference (`prop` → `.targetProp`)
 *                         Example: ActionButton.showExpression → ExtendedExpression.expression
 *   - references:         simple ref edges (target object opens in pane on click)
 *   - contextFields:      enum / boolean / list values that shape interpretation
 *                         of the other fields (actionType, persistence, …)
 */

/** BMP EC returns enum values as `"EnumName.value"` strings (e.g.
 *  `ActionType.action`, `PersistStrategy.session`, `TextType.rich`) — NOT the
 *  bare uppercase constants the Java API documents (`ActionType.ACTION`).
 *  Comparing the raw return value against `"ACTION"` always fails. Always
 *  normalize before comparing or displaying. See memory/bmp-ec-enum-format.md. */
export function normalizeBmpEnum(raw: string | undefined | null): string {
  if (!raw) return '';
  const dot = raw.indexOf('.');
  const tail = dot >= 0 ? raw.slice(dot + 1) : raw;
  return tail.toUpperCase();
}

export interface CodeFieldDef {
  prop: string;
  label?: string;
  /** When set, this EC only runs if the named boolean prop is true.
   *  UI greys the field + shows a "Disabled by <gate>=false" hint when off. */
  enabledBy?: string;
}

export interface IndirectCodeFieldDef {
  /** Local reference property (e.g. 'showExpression'). */
  prop: string;
  /** EC field on the resolved target (e.g. 'expression'). */
  targetProp: string;
  label?: string;
}

export interface ReferenceEdgeDef {
  prop: string;
  label?: string;
}

export interface ContextFieldDef {
  prop: string;
  /** enum: a string value with a small set of allowed names (rendered as chip)
   *  boolean: a true/false (rendered as on/off chip)
   *  list-ref: a list of BMP object references (rendered as a row of chips) */
  kind: 'enum' | 'boolean' | 'list-ref';
  label?: string;
}

export interface TypeMeta {
  codeFields?: CodeFieldDef[];
  indirectCodeFields?: IndirectCodeFieldDef[];
  references?: ReferenceEdgeDef[];
  contextFields?: ContextFieldDef[];
}

export const TYPE_META: Record<string, TypeMeta> = {
  CustomVisualization: {
    codeFields: [{ prop: 'html' }, { prop: 'javascript' }, { prop: 'css' }],
    references: [{ prop: 'customvisualizationdata', label: 'data binding' }],
  },
  TextElement: {
    codeFields: [{ prop: 'expression' }, { prop: 'defaultExpression' }],
  },
  Label: {
    codeFields: [{ prop: 'defaultExpression' }, { prop: 'expression' }],
    contextFields: [
      { prop: 'textInputType', kind: 'enum' },
      { prop: 'advancedDefault', kind: 'boolean' },
    ],
  },
  ButtonInput: {
    // ButtonInput inherits InputAvailability → HasShowExpression + HasEnableExpression.
    // Both expressions are direct CorpoExtendedExpression strings (not refs).
    codeFields: [
      { prop: 'expression' },
      { prop: 'afterExpression' },
      { prop: 'initExpression' },
      { prop: 'showExpression', enabledBy: 'useShowExpression' },
      { prop: 'enableExpression', enabledBy: 'useEnableExpression' },
    ],
    contextFields: [
      { prop: 'buttonType', kind: 'enum' },
      { prop: 'useShowExpression', kind: 'boolean' },
      { prop: 'useEnableExpression', kind: 'boolean' },
    ],
  },
  TextInput: {
    codeFields: [
      { prop: 'showExpression', enabledBy: 'useShowExpression' },
      { prop: 'enableExpression', enabledBy: 'useEnableExpression' },
    ],
    contextFields: [
      { prop: 'useShowExpression', kind: 'boolean' },
      { prop: 'useEnableExpression', kind: 'boolean' },
    ],
  },
  NumberInput: {
    codeFields: [
      { prop: 'showExpression', enabledBy: 'useShowExpression' },
      { prop: 'enableExpression', enabledBy: 'useEnableExpression' },
    ],
    contextFields: [
      { prop: 'useShowExpression', kind: 'boolean' },
      { prop: 'useEnableExpression', kind: 'boolean' },
    ],
  },
  DateInput: {
    codeFields: [
      { prop: 'showExpression', enabledBy: 'useShowExpression' },
      { prop: 'enableExpression', enabledBy: 'useEnableExpression' },
    ],
    contextFields: [
      { prop: 'useShowExpression', kind: 'boolean' },
      { prop: 'useEnableExpression', kind: 'boolean' },
    ],
  },
  ChoiceInput: {
    codeFields: [
      { prop: 'showExpression', enabledBy: 'useShowExpression' },
      { prop: 'enableExpression', enabledBy: 'useEnableExpression' },
    ],
    contextFields: [
      { prop: 'useShowExpression', kind: 'boolean' },
      { prop: 'useEnableExpression', kind: 'boolean' },
    ],
  },
  BooleanInput: {
    codeFields: [
      { prop: 'showExpression', enabledBy: 'useShowExpression' },
      { prop: 'enableExpression', enabledBy: 'useEnableExpression' },
    ],
    contextFields: [
      { prop: 'useShowExpression', kind: 'boolean' },
      { prop: 'useEnableExpression', kind: 'boolean' },
    ],
  },
  ActionButton: {
    // expression is the EC when actionType=ADD or NAVIGATE. For ACTION the EC
    // lives on actionObject's ExtendedTransport children (handled by Flow walker).
    codeFields: [
      { prop: 'expression' },
      { prop: 'initExpression' },
      { prop: 'afterExpression' },
    ],
    // showExpression on ActionButton is a Reference(ExtendedExpression) — the
    // actual EC lives on the referenced ExtendedExpression's .expression field.
    indirectCodeFields: [
      { prop: 'showExpression', targetProp: 'expression', label: 'showExpression' },
    ],
    references: [{ prop: 'actionObject' }],
    contextFields: [
      { prop: 'actionType', kind: 'enum' },
      { prop: 'addableItems', kind: 'list-ref' },
    ],
  },
  InputView: {
    references: [{ prop: 'inputSet' }],
    contextFields: [
      { prop: 'persistence', kind: 'enum' },
    ],
  },
  CreateObjectView: {
    references: [
      { prop: 'editPage' },
      { prop: 'destination' },
      { prop: 'defaultObject' },
    ],
  },
  ExtendedTable: {
    codeFields: [{ prop: 'expression' }, { prop: 'html' }, { prop: 'javascript' }],
  },
  ExtendedCode: {
    codeFields: [{ prop: 'expression' }],
  },
  ExtendedTransport: {
    codeFields: [{ prop: 'expression' }],
  },
  EditField: {
    references: [{ prop: 'property' }],
  },
};

/** Object types whose pane renders the Flow walker instead of separate
 *  Code + References sections. For these, the flow IS the answer to
 *  "what runs / what does this reference."
 *
 *  The chain-target types (InputSet, NotificationTransportGroup) are
 *  included so that clicking the cascade pill — which navigates directly
 *  to the chain target — still opens onto the children walk rather than a
 *  bare properties pane. */
export const FLOW_TYPES: ReadonlySet<string> = new Set([
  'InputView',
  'InputSet',
  'ActionButton',
  'NotificationTransportGroup',
  'Label',
  // EditPage drives the "Add..." / "Create..." flow — clicking a
  // CreateObjectView button opens its referenced EditPage which usually
  // contains an InputSet + ButtonInput chain. Surfacing flow at the EditPage
  // level lets users walk down from the page to its inputs without first
  // having to find the InputSet manually. CreateObjectView is the parent
  // affordance (the button) so it walks similarly via its referenced page.
  'EditPage',
  'CreateObjectView',
]);

/** Input-field types — they expose a `key` that sibling ButtonInputs read.
 *  Used by the flow walker to surface key chips and detect cross-refs. */
export const INPUT_FIELD_TYPES: ReadonlySet<string> = new Set([
  'TextInput', 'NumberInput', 'DateInput', 'ChoiceInput', 'BooleanInput',
]);

export function codeFieldsFor(type: string): CodeFieldDef[] {
  return TYPE_META[type]?.codeFields ?? [];
}

export function indirectCodeFieldsFor(type: string): IndirectCodeFieldDef[] {
  return TYPE_META[type]?.indirectCodeFields ?? [];
}

export function referencesFor(type: string): ReferenceEdgeDef[] {
  return TYPE_META[type]?.references ?? [];
}

export function contextFieldsFor(type: string): ContextFieldDef[] {
  return TYPE_META[type]?.contextFields ?? [];
}

export function hasFlow(type: string): boolean {
  return FLOW_TYPES.has(type);
}

export function isInputField(type: string): boolean {
  return INPUT_FIELD_TYPES.has(type);
}

export function hasCode(type: string): boolean {
  return !!(TYPE_META[type]?.codeFields?.length || TYPE_META[type]?.indirectCodeFields?.length);
}

/** Union of every direct code-field property across all types. Used by
 *  fetchObjectPane to read each one regardless of the live object's class —
 *  missing properties return MISSING → empty string. */
export const ALL_CODE_FIELDS: readonly string[] = (() => {
  const set = new Set<string>();
  for (const meta of Object.values(TYPE_META)) {
    for (const f of meta.codeFields ?? []) set.add(f.prop);
  }
  return Object.freeze([...set]);
})();

/** Union of every reference-edge property across all types. */
export const ALL_REFERENCE_FIELDS: readonly string[] = (() => {
  const set = new Set<string>();
  for (const meta of Object.values(TYPE_META)) {
    for (const r of meta.references ?? []) set.add(r.prop);
  }
  return Object.freeze([...set]);
})();

/** Union of every indirect (ref-then-target) code-field shape. */
export const ALL_INDIRECT_FIELDS: ReadonlyArray<{ prop: string; targetProp: string }> = (() => {
  const seen = new Set<string>();
  const out: Array<{ prop: string; targetProp: string }> = [];
  for (const meta of Object.values(TYPE_META)) {
    for (const f of meta.indirectCodeFields ?? []) {
      const key = `${f.prop}.${f.targetProp}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ prop: f.prop, targetProp: f.targetProp });
    }
  }
  return Object.freeze(out);
})();

/** Union of every context-field property. */
export const ALL_CONTEXT_FIELDS: ReadonlyArray<{ prop: string; kind: ContextFieldDef['kind'] }> = (() => {
  const seen = new Map<string, ContextFieldDef['kind']>();
  for (const meta of Object.values(TYPE_META)) {
    for (const f of meta.contextFields ?? []) {
      // First-write wins; we assume the same prop has a consistent kind across types.
      if (!seen.has(f.prop)) seen.set(f.prop, f.kind);
    }
  }
  return Object.freeze([...seen.entries()].map(([prop, kind]) => ({ prop, kind })));
})();

/** Boolean props that gate a code field via `enabledBy`. Fetched alongside
 *  the EC so the renderer can grey out disabled fields. */
export const ALL_ENABLED_BY_PROPS: readonly string[] = (() => {
  const set = new Set<string>();
  for (const meta of Object.values(TYPE_META)) {
    for (const f of meta.codeFields ?? []) {
      if (f.enabledBy) set.add(f.enabledBy);
    }
  }
  return Object.freeze([...set]);
})();
