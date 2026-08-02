/**
 * Extended Code generation for the flow walker + object pane EC pipelines.
 *
 * The bmp-client.ts walkers used to construct EC by hand via 78 `lines.push()`
 * calls duplicating the same separator / pipe-row / forEach scaffolding. This
 * module owns the EC-building half of those methods so:
 *
 *   - The patterns ("emit a pipe-delimited identity row", "emit per-child EC
 *     for a property") live in ONE place. Adding a new field is one call,
 *     not a fresh `_r := _r + _sep + …` chain.
 *
 *   - bmp-client orchestrates round-trips (resolveRef → buildEc → executeEc →
 *     parseSepBlocks) and owns the result shape; this module is pure string
 *     construction with no I/O.
 *
 * Pure functions; safe to import from anywhere. The separator constant is
 * shared so callers parse with the same delimiter we emit.
 */

import {
  ALL_CODE_FIELDS, ALL_REFERENCE_FIELDS, ALL_INDIRECT_FIELDS,
  ALL_CONTEXT_FIELDS, ALL_ENABLED_BY_PROPS,
} from './widget-metadata';
import type { PaneProp } from './bmp-client';
import { validateEcIdentifier } from './ec-guards';
import { ecResolveTemplate } from './template-link';

/** Separator used by every walker EC + their parsers. Hardcoded string (never
 *  user input) so it can't be injected via EC values. */
export const FLOW_SEP = '<<<CREV_SEP>>>';

/** Max sibling rows emitted by the object-pane EC. The sibling navigator only
 *  needs a browseable slice; without this, an object under a parent with
 *  thousands of children paid O(N) per-child property reads + concat + payload
 *  on every pane open (the dominant cost behind "clicking an object is slow in
 *  this workspace"). We still count ALL children so the UI can show the true
 *  total — see `sibTotal` in buildObjectPaneEc / ObjectPaneData.siblingTotal. */
export const SIBLING_CAP = 50;
/** Edit forms are normally small, but generated workspaces can contain
 * hundreds of fields. Bound the detailed projection so one pathological form
 * cannot flood the side panel with code bodies. The walker reports the real
 * total and renders an explicit truncation hint. */
export const PAGE_FORM_CHILD_CAP = 200;

// ── Atom helpers ─────────────────────────────────────────────────

/** EC fragment that emits one `{sep}label{sep}rid|id|name|className\n` row. */
function pipeRow(varName: string, label: string, prefix = ''): string {
  return `${prefix}_r := _r + _sep + "${label}" + _sep + ${varName}.rid.whenMissing("") + "|" + ${varName}.id.whenMissing("") + "|" + ${varName}.name.whenMissing("") + "|" + ${varName}.className.whenMissing("") + "\\n"`;
}

/** EC fragment that appends a bare `rid|id|name|className|key\n` row (used
 *  inside a {sep}children{sep} block). */
function pipeRowWithKey(varName: string, prefix = ''): string {
  return `${prefix}_r := _r + ${varName}.rid.whenMissing("") + "|" + ${varName}.id.whenMissing("") + "|" + ${varName}.name.whenMissing("") + "|" + ${varName}.className.whenMissing("") + "|" + ${varName}.key.whenMissing("") + "\\n"`;
}

/** EC fragment that appends a bare `rid|id|name|className\n` row (used inside
 *  a {sep}children{sep} block where children don't carry a key). */
function pipeRowNoKey(varName: string, prefix = ''): string {
  return `${prefix}_r := _r + ${varName}.rid.whenMissing("") + "|" + ${varName}.id.whenMissing("") + "|" + ${varName}.name.whenMissing("") + "|" + ${varName}.className.whenMissing("") + "\\n"`;
}

/** Emit an EC content block (`{sep}<label>{sep}<value>\n`) ONLY when the value
 *  is non-empty. An empty property otherwise costs ~65 bytes on the wire — the
 *  sentinel twice + the label + a 19-digit RID — and MOST input/transport
 *  properties are empty (a typical field binds 0-1 of its 7 code props). On
 *  t.153 this shrank the per-child payload from ~1.3 KB to <100 bytes; the win
 *  scales linearly with field count. The value is read once via output() (raw
 *  text, no eval) and the parser already treats a missing block as "no EC", so
 *  nothing downstream changes. `labelExpr`/`valueExpr` are EC source fragments.
 *
 *  The value is coerced to a string (`"" + …`) BEFORE the `!= ""` guard. A bare
 *  `_v != ""` on a TYPED value (an enum like headerStyle/borderStyle, or a
 *  number like transparency) makes BMP coerce the literal `""` into that type
 *  and throw — e.g. `Valid choices for HeaderStyle is INSIDE, OUTSIDE, NONE`
 *  (verified live on t.5920). The pre-conditional codegen never hit this
 *  because it only ever CONCATENATED `output(…)` (string context); the `IF`
 *  guard introduced the comparison. `"" + output(…)` restores string context,
 *  so the guard is safe for every value type and the emitted text is unchanged. */
function condEcBlock(labelExpr: string, valueExpr: string, prefix = ''): string[] {
  return [
    `${prefix}_v := "" + ${valueExpr}`,
    `${prefix}IF _v != "" THEN`,
    `${prefix}  _r := _r + _sep + ${labelExpr} + _sep + _v + "\\n"`,
    `${prefix}ELSE`,
    `${prefix}  _r := _r`,
    `${prefix}ENDIF`,
  ];
}

/** Indirect EC block (Reference → ExtendedExpression): emit the content AND its
 *  backing-RID block (used for the Edit redirect) ONLY when the content is
 *  non-empty. Reading `.rid` only inside the non-empty branch also avoids a
 *  `.rid`-on-MISSING access when the reference is unset. */
function condIndirectEc(label: string, refExpr: string, targetProp = 'expression', prefix = ''): string[] {
  validateEcIdentifier(targetProp);
  return [
    `${prefix}_v := output(${refExpr}.${targetProp}.whenMissing(""))`,
    `${prefix}IF _v != "" THEN`,
    `${prefix}  _r := _r + _sep + "${label}" + _sep + _v + "\\n"`,
    `${prefix}  _r := _r + _sep + "${label}_rid" + _sep + ${refExpr}.rid.whenMissing("") + "\\n"`,
    `${prefix}ELSE`,
    `${prefix}  _r := _r`,
    `${prefix}ENDIF`,
  ];
}

/** Reference-edge blocks (rid|id|name|className), emitted only when the edge is
 *  set. Reads `_o.<rf>` once into `_ref` and emits the 4 blocks only if it
 *  resolves — saving 4 empty blocks per absent edge (most edges are absent for
 *  any given type) AND avoiding 4 reads on a MISSING reference. */
function condRefEc(rf: string): string[] {
  validateEcIdentifier(rf);
  return [
    `_ref := _o.${rf}`,
    'IF _ref != MISSING THEN',
    `  _r := _r + _sep + "ref_${rf}_rid" + _sep + _ref.rid.whenMissing("") + "\\n"`,
    `  _r := _r + _sep + "ref_${rf}_id" + _sep + _ref.id.whenMissing("") + "\\n"`,
    `  _r := _r + _sep + "ref_${rf}_name" + _sep + _ref.name.whenMissing("") + "\\n"`,
    `  _r := _r + _sep + "ref_${rf}_type" + _sep + _ref.className.whenMissing("") + "\\n"`,
    'ELSE',
    '  _r := _r',
    'ENDIF',
  ];
}

/** Per-child code-field block keyed by RID, emitted only when non-empty (see
 *  condEcBlock). `prop` is interpolated into the EC source (as `.${prop}`), so a
 *  hostile string could break out of the property access — we re-validate at
 *  every slot even though callers pass values from ALL_CODE_FIELDS. */
function childEcEmit(prop: string, varName = '_c', prefix = ''): string[] {
  validateEcIdentifier(prop);
  return condEcBlock(
    `"child_${prop}_" + ${varName}.rid.whenMissing("")`,
    `output(${varName}.${prop}.whenMissing(""))`,
    prefix,
  );
}

/** EC fragment that emits a single header section: `{sep}<label>{sep}<value>\n`. */
function scalarBlock(label: string, valueExpr: string, prefix = ''): string {
  return `${prefix}_r := _r + _sep + "${label}" + _sep + ${valueExpr} + "\\n"`;
}

/** Pass-2 EC for an action/transport-group child `_c`: emit its code-field
 *  block(s) keyed by className. Only EC-bearing transports emit anything —
 *  ExtendedTransport.expression and ChangePropertyTransport.value / function /
 *  dateFunction (verified live against the "Action group" fixture: output()
 *  returns the raw source and is empty-safe). Every other transport
 *  (Smtp/File/Soap/RunReport/AddObject/ActivateForms/…) carries no EC and
 *  renders as a bare node. `keyPrefix` (`child` | `actchild`) matches the
 *  block keys each walk's parser reads. EC requires a mandatory ELSE. */
function transportChildEc(keyPrefix: string, indent: string, varName = '_c'): string[] {
  const slot = (prop: string, ind: string): string[] => {
    validateEcIdentifier(prop);
    return condEcBlock(
      `"${keyPrefix}_${prop}_" + ${varName}.rid.whenMissing("")`,
      `output(${varName}.${prop}.whenMissing(""))`,
      ind,
    );
  };
  return [
    `${indent}IF ${varName}.className = "ExtendedTransport" THEN`,
    ...slot('expression', indent + '  '),
    `${indent}ELSE`,
    `${indent}  IF ${varName}.className = "ChangePropertyTransport" THEN`,
    ...slot('value', indent + '    '),
    ...slot('function', indent + '    '),
    ...slot('dateFunction', indent + '    '),
    `${indent}  ELSE`,
    `${indent}    _r := _r`,
    `${indent}  ENDIF`,
    `${indent}ENDIF`,
  ];
}

/** Supplemental EC for an InputSet walk: for every DIRECT child that is an
 *  action-bearing button (ButtonInput / ActionButton with an actionObject),
 *  emit the action graph — owner→group identity rows, group→transport rows,
 *  and per-transport EC. Emitted AFTER the flat `children` + per-child EC
 *  blocks so the contiguous identity blocks aren't split. `setVar` is the EC
 *  var holding the InputSet. Verified live against t.153. */
function inputActionEc(setVar: string): string[] {
  // Visit every action-bearing button — direct InputSet children AND buttons
  // nested inside a ButtonGroup — binding _b to the button and _ao to its
  // actionObject, then running `inner` (which uses _b / _ao). Buttons may share
  // an actionObject (e.g. two buttons → one transport group); the parser
  // dedupes transports and fans them out to every owner.
  const visit = (inner: string[]): string[] => {
    const block = (btn: string, ind: string): string[] => [
      `${ind}_b := ${btn}`,
      `${ind}IF _b.className = "ButtonInput" OR _b.className = "ActionButton" THEN`,
      `${ind}  _ao := _b.actionObject`,
      `${ind}  IF _ao != MISSING THEN`,
      ...inner.map(l => `${ind}    ${l}`),
      `${ind}  ELSE`,
      `${ind}    _r := _r`,
      `${ind}  ENDIF`,
      `${ind}ELSE`,
      `${ind}  _r := _r`,
      `${ind}ENDIF`,
    ];
    return [
      `${setVar}.children().forEach(_c:`,
      ...block('_c', '  '),
      '  IF _c.className = "ButtonGroup" THEN',
      '    _c.children().forEach(_g:',
      ...block('_g', '      '),
      '    )',
      '  ELSE',
      '    _r := _r',
      '  ENDIF',
      ')',
    ];
  };
  return [
    // owner→group: ownerButtonRid|ntgRid|ntgId|ntgName|ntgClassName
    `_r := _r + _sep + "actiongroups" + _sep + "\\n"`,
    ...visit([
      '_r := _r + _b.rid.whenMissing("") + "|" + _ao.rid.whenMissing("") + "|" + _ao.id.whenMissing("") + "|" + _ao.name.whenMissing("") + "|" + _ao.className.whenMissing("") + "\\n"',
    ]),
    // group→transport identity: ntgRid|transportRid|id|name|className
    `_r := _r + _sep + "actiontransports" + _sep + "\\n"`,
    ...visit([
      '_ao.children().forEach(_t:',
      '  _r := _r + _ao.rid.whenMissing("") + "|" + _t.rid.whenMissing("") + "|" + _t.id.whenMissing("") + "|" + _t.name.whenMissing("") + "|" + _t.className.whenMissing("") + "\\n"',
      ')',
    ]),
    // per-transport EC (child_ prefix, keyed by transport rid)
    ...visit([
      '_ao.children().forEach(_t:',
      ...transportChildEc('child', '  ', '_t'),
      ')',
    ]),
  ];
}

/** Supplemental EC for a ButtonGroup: surface each group's child buttons.
 *  Emits a `groupkids` block (groupRid|childRid|id|name|className|key) plus the
 *  per-child input EC (child_ prefix, keyed by child rid) so the buttons inside
 *  a group are no longer invisible. The renderer draws a subtle group outline.
 *  Verified live against t.153. */
function buttonGroupEc(setVar: string): string[] {
  return [
    `_r := _r + _sep + "groupkids" + _sep + "\\n"`,
    `${setVar}.children().forEach(_c:`,
    '  IF _c.className = "ButtonGroup" THEN',
    '    _c.children().forEach(_g:',
    '      _r := _r + _c.rid.whenMissing("") + "|" + _g.rid.whenMissing("") + "|" + _g.id.whenMissing("") + "|" + _g.name.whenMissing("") + "|" + _g.className.whenMissing("") + "|" + _g.key.whenMissing("") + "\\n"',
    '    )',
    '  ELSE',
    '    _r := _r',
    '  ENDIF',
    ')',
    `${setVar}.children().forEach(_c:`,
    '  IF _c.className = "ButtonGroup" THEN',
    '    _c.children().forEach(_g:',
    ...CHILD_EC_PROPS.flatMap(p => childEcEmit(p, '_g', '      ')),
    '    )',
    '  ELSE',
    '    _r := _r',
    '  ENDIF',
    ')',
  ];
}

// ── Common preamble / footer ─────────────────────────────────────

/** Standard EC opening — declare the separator + the target object + the
 *  accumulator. Used by every walker. */
function preamble(ref: string): string[] {
  return [
    `_sep := "${FLOW_SEP}"`,
    `_o := ${ref}`,
    '_r := ""',
  ];
}

/** Standard EC closing — emit DONE marker and the accumulator. */
function footer(): string[] {
  return [
    `_r := _r + _sep + "DONE"`,
    '_r',
  ];
}

// ── Flow walkers ─────────────────────────────────────────────────

/** Five EC blocks emitted per InputSet child — the input-availability EC
 *  (showExpression / enableExpression) is paired with its gate value so the
 *  panel can render a "disabled by useShowExpression=false" hint. */
const CHILD_EC_PROPS = [
  'afterExpression', 'expression', 'defaultExpression',
  'showExpression', 'enableExpression',
  'useShowExpression', 'useEnableExpression',
];

/** Emit the per-child EC block for every prop in CHILD_EC_PROPS, indented for
 *  use inside a `.forEach(_c:` body. */
function childEcAll(indent: string): string[] {
  return CHILD_EC_PROPS.flatMap(prop => childEcEmit(prop, '_c', indent));
}

/**
 * fetchInputViewFlow EC: IV → optional InputSet → form-field children.
 * Two passes over `_is.children()` is intentional — the first packs identity
 * rows under ONE `{sep}children{sep}` block (so parseSepBlocks doesn't
 * overwrite); the second emits per-RID EC blocks. Folding into one loop
 * would interleave child rows into the children block after the first
 * per-RID separator landed, corrupting the parse.
 */
export function buildInputViewFlowEc(ref: string): string {
  return [
    ...preamble(ref),
    '_is := _o.inputSet',
    pipeRow('_o', 'iv'),
    'IF _is != MISSING THEN',
    pipeRow('_is', 'is', '  '),
    `  _r := _r + _sep + "children" + _sep + "\\n"`,
    '  _is.children().forEach(_c:',
    pipeRowWithKey('_c', '    '),
    '  )',
    '  _is.children().forEach(_c:',
    ...childEcAll('    '),
    '  )',
    ...buttonGroupEc('_is').map(l => '  ' + l),
    ...inputActionEc('_is').map(l => '  ' + l),
    'ENDIF',
    ...footer(),
  ].join('\n');
}

/** Walk just an InputSet → its children. Used when the cascade pill jumps
 *  straight to the InputSet so the user sees the form fields immediately. */
export function buildInputSetFlowEc(ref: string): string {
  return [
    ...preamble(ref),
    pipeRow('_o', 'is'),
    `_r := _r + _sep + "children" + _sep + "\\n"`,
    '_o.children().forEach(_c:',
    pipeRowWithKey('_c', '  '),
    ')',
    '_o.children().forEach(_c:',
    ...childEcAll('  '),
    ')',
    ...buttonGroupEc('_o'),
    ...inputActionEc('_o'),
    ...footer(),
  ].join('\n');
}

/** Walk an EditPage directly, or a CreateObjectView through its `.editPage`
 * reference. EditPage children are EditField / EditPageInfo / Button /
 * Validation / break elements, not InputSets. The projection includes the
 * field's propertyMapping plus every EC-bearing slot used by those child
 * classes. Missing slots are safe through `whenMissing("")`.
 *
 * Identity rows and per-child blocks use separate passes so separator blocks
 * never interrupt the contiguous `children` list. Both passes are bounded to
 * PAGE_FORM_CHILD_CAP; `childTotal` preserves the honest source count. */
export function buildPageFormFlowEc(ref: string, sourceType: 'EditPage' | 'CreateObjectView'): string {
  const pageExpr = sourceType === 'CreateObjectView' ? '_o.editPage' : '_o';
  const rootCode = sourceType === 'CreateObjectView'
    ? [
        ...condEcBlock('"root_parentDestinationExpression"', 'output(_o.parentDestinationExpression.whenMissing(""))'),
        ...condEcBlock('"root_editExpression"', 'output(_o.editExpression.whenMissing(""))'),
        ...condEcBlock('"root_initExpression"', 'output(_o.initExpression.whenMissing(""))'),
        ...condEcBlock('"root_afterExpression"', 'output(_o.afterExpression.whenMissing(""))'),
      ]
    : [];
  const childProps = [
    'defaultExpression', 'requiredExpression', 'expression',
    'showExpression', 'enableExpression',
    'useShowExpression', 'useEnableExpression',
  ];
  return [
    ...preamble(ref),
    `_page := ${pageExpr}`,
    pipeRow('_o', 'root'),
    ...rootCode,
    'IF _page != MISSING THEN',
    ...(sourceType === 'CreateObjectView' ? [pipeRow('_page', 'page', '  ')] : []),
    ...condEcBlock('"page_afterExpression"', 'output(_page.afterExpression.whenMissing(""))', '  '),
    `  _r := _r + _sep + "children" + _sep + "\\n"`,
    '  _seen := 0',
    '  _page.children().forEach(_c:',
    '    _seen := _seen + 1',
    `    IF _seen <= ${PAGE_FORM_CHILD_CAP} THEN`,
    pipeRowNoKey('_c', '      '),
    '    ELSE',
    '      _r := _r',
    '    ENDIF',
    '  )',
    scalarBlock('childTotal', 'output(_seen)', '  '),
    '  _idx := 0',
    '  _page.children().forEach(_c:',
    '    _idx := _idx + 1',
    `    IF _idx <= ${PAGE_FORM_CHILD_CAP} THEN`,
    ...condEcBlock(
      '"child_propertyMapping_" + _c.rid.whenMissing("")',
      'output(_c.propertyMapping.whenMissing(""))',
      '      ',
    ),
    ...childProps.flatMap(prop => childEcEmit(prop, '_c', '      ')),
    '    ELSE',
    '      _r := _r',
    '    ENDIF',
    '  )',
    'ENDIF',
    ...footer(),
  ].join('\n');
}

/** Walk a NotificationTransportGroup → ALL its transport children. Every child
 *  is surfaced as a node so the full action group is visible (Smtp / File /
 *  RunReport / AddObject / ActivateForms / …); EC is attached to the ones that
 *  carry it (ExtendedTransport, ChangePropertyTransport) — see transportChildEc. */
export function buildTransportGroupFlowEc(ref: string): string {
  return [
    ...preamble(ref),
    pipeRow('_o', 'grp'),
    `_r := _r + _sep + "children" + _sep + "\\n"`,
    '_o.children().forEach(_c:',
    pipeRowNoKey('_c', '  '),
    ')',
    '_o.children().forEach(_c:',
    ...transportChildEc('child', '  '),
    ')',
    ...footer(),
  ].join('\n');
}

/**
 * fetchActionButtonFlow EC. The button itself carries direct EC (expression /
 * init / after) plus an indirect showExpression that resolves through
 * ExtendedExpression.expression. The chain target depends on actionType:
 *   ACTION   → walk actionObject (NotificationTransportGroup) → ALL transports
 *   ADD / NAVIGATE → expression on the button IS the EC (no chain to walk)
 *   EDIT     → actionObject is the edit target (no EC chain)
 * The actionObject's children are walked in full (every transport is a node);
 * EC attaches to ExtendedTransport / ChangePropertyTransport — see
 * transportChildEc.
 */
export function buildActionButtonFlowEc(ref: string): string {
  return [
    ...preamble(ref),
    '_act := _o.actionObject',
    '_actType := _o.actionType.whenMissing("")',
    `_r := _r + _sep + "ab" + _sep + _o.rid.whenMissing("") + "|" + _o.id.whenMissing("") + "|" + _o.name.whenMissing("") + "|" + _o.className.whenMissing("") + "|" + _actType + "\\n"`,
    // Direct EC fields, emitted only when set.
    ...condEcBlock('"ab_expression"', 'output(_o.expression.whenMissing(""))'),
    ...condEcBlock('"ab_initExpression"', 'output(_o.initExpression.whenMissing(""))'),
    ...condEcBlock('"ab_afterExpression"', 'output(_o.afterExpression.whenMissing(""))'),
    // Indirect (Reference → ExtendedExpression): show / enable / validate. Each
    // emits its content + a backing-RID block (so Edit opens the TARGET's
    // `.expression`, not the AB's Reference handle) only when content is set.
    ...condIndirectEc('ab_showExpression', '_o.showExpression'),
    ...condIndirectEc('ab_enableExpression', '_o.enableExpression'),
    ...condIndirectEc('ab_validateExpression', '_o.validateExpression'),
    // Direct fields (verified live on t.151: editExpression='this.object').
    ...condEcBlock('"ab_editExpression"', 'output(_o.editExpression.whenMissing(""))'),
    ...condEcBlock('"ab_refreshExpression"', 'output(_o.refreshExpression.whenMissing(""))'),
    'IF _act != MISSING THEN',
    pipeRow('_act', 'act', '  '),
    `  _r := _r + _sep + "actchildren" + _sep + "\\n"`,
    '  _act.children().forEach(_c:',
    pipeRowNoKey('_c', '    '),
    '  )',
    '  _act.children().forEach(_c:',
    ...transportChildEc('actchild', '    '),
    '  )',
    'ENDIF',
    ...footer(),
  ].join('\n');
}

/** Label EC — defaultExpression carries the rendered text when
 *  textInputType=TextType.rich + advancedDefault=true. */
export function buildLabelFlowEc(ref: string): string {
  return [
    ...preamble(ref),
    pipeRow('_o', 'lbl'),
    ...condEcBlock('"lbl_defaultExpression"', 'output(_o.defaultExpression.whenMissing(""))'),
    ...condEcBlock('"lbl_expression"', 'output(_o.expression.whenMissing(""))'),
    ...footer(),
  ].join('\n');
}

// ── Object pane ──────────────────────────────────────────────────

/**
 * Resolve an EditField's string `propertyMapping` to the real property
 * configuration object. This deliberately does not use the generic reference
 * walker: propertyMapping is an accessor, not an object reference.
 *
 * ClassConfig children are per-class applications. Their `linkedTo` target is
 * the master property config under root.property, which is the stable object
 * the relationship chip opens. Owner-specific applications belong on the
 * Property view; this resolver returns only the stable master relationship.
 */
export function buildEditFieldPropertyEc(ref: string, classNames: readonly string[]): string {
  const classes = [...new Set(classNames)];
  const lines = [
    `_sep := "${FLOW_SEP}"`,
    `_o := ${ref}`,
    '_accessor := _o.propertyMapping.whenMissing("")',
    '_r := ""',
    '_done := FALSE',
    scalarBlock('accessor', '_accessor'),
  ];
  for (const className of classes) {
    validateEcIdentifier(className);
    lines.push('IF _done = FALSE THEN');
    lines.push(`  c.get(${className}.name).children().forEach(_app:`);
    lines.push('    IF _done = FALSE THEN');
    lines.push('      IF _app.linkedTo.id = _accessor THEN');
    lines.push('        _property := _app.linkedTo');
    lines.push(scalarBlock('propertyRid', '_property.rid.whenMissing("MISSING")', '        '));
    lines.push(scalarBlock('propertyId', '_property.id.whenMissing("")', '        '));
    lines.push(scalarBlock('propertyName', '_property.name.whenMissing("")', '        '));
    lines.push(scalarBlock('propertyType', '_property.className.whenMissing("")', '        '));
    lines.push('        _done := TRUE');
    lines.push('      ELSE');
    lines.push('        _r := _r');
    lines.push('      ENDIF');
    lines.push('    ELSE');
    lines.push('      _r := _r');
    lines.push('    ENDIF');
    lines.push('  )');
    lines.push('ELSE');
    lines.push('  _r := _r');
    lines.push('ENDIF');
  }
  lines.push('_r := _r + _sep + "DONE"');
  lines.push('_r');
  return lines.join('\n');
}

export const PROPERTY_APPLICATION_MARK = '<<<CREV_PROPERTY_APPLICATION>>>';
export const PROPERTY_APPLICATION_FIELD = '<<<CREV_PROPERTY_FIELD>>>';
export const PROPERTY_APPLICATION_END = '<<<CREV_PROPERTY_END>>>';
export const PROPERTY_APPLICATION_ERROR = '<<<CREV_PROPERTY_ERROR>>>';
export const PROPERTY_APPLICATION_TOTAL = '<<<CREV_PROPERTY_TOTAL>>>';
export const PROPERTY_APPLICATION_CAP = 100;

/** Capture every ClassConfig application of one master property in a single
 * reverse-reference pass. `application.genedit()` without `*` is the override delta:
 * inherited applications emit only their structural `id`, while overridden
 * applications emit the changed fields as well. */
export function buildPropertyApplicationsEc(ref: string): string {
  return [
    `_property := ${ref}`,
    `_applications := _property.rref(linkedTo)`,
    `_total := _applications.size()`,
    `_result := "${PROPERTY_APPLICATION_TOTAL}" + str(_total)`,
    `_applications.first(${PROPERTY_APPLICATION_CAP}).forEach(_application:`,
    `  _genedit := _application.genedit()`,
    `  IF _genedit = "*<<<CREV_*" THEN`,
    `    _result := _result + "${PROPERTY_APPLICATION_ERROR}"`,
    `  ELSE`,
    `    _result := _result + "${PROPERTY_APPLICATION_MARK}" + _application.parent.id.whenMissing("") + "${PROPERTY_APPLICATION_FIELD}" + _application.rid.whenMissing("MISSING") + "${PROPERTY_APPLICATION_FIELD}" + _application.id.whenMissing("") + "${PROPERTY_APPLICATION_FIELD}" + _application.className.whenMissing("") + "${PROPERTY_APPLICATION_FIELD}" + _genedit`,
    `  ENDIF`,
    `)`,
    `_result := _result + "${PROPERTY_APPLICATION_END}"`,
    '_result',
  ].join('\n');
}

/**
 * fetchObjectPane EC. Reads identity, parent, template, PANE_PROPS (style
 * props on inst + tmpl), every code field / reference edge / context value /
 * gate / list-ref across all types, plus the sibling list. Union approach
 * is intentional: missing properties return "" via whenMissing, and IF
 * guards skip the bodies of list-ref blocks for non-flow types — so non-flow
 * widgets pay only for the property reads, not the forEach overhead.
 */
export function buildObjectPaneEc(ref: string, paneProps: readonly string[]): string {
  const lines: string[] = [
    `_sep := "${FLOW_SEP}"`,
    `_o := ${ref}`,
    // Widgets have a webParent; top-level portal objects (a Scorecard under an
    // Organisation) do not — fall back to the tree parent so Structure always
    // shows what is above (verified live: whenMissing works on object values).
    '_p := _o.webParent.whenMissing(_o.parent)',
    ...ecResolveTemplate('_o', '_t'),
    '_r := ""',
    scalarBlock('instRid', '_o.rid.whenMissing("MISSING")'),
    scalarBlock('instId', '_o.id.whenMissing("")'),
    scalarBlock('instName', '_o.name.whenMissing("")'),
    scalarBlock('instType', '_o.className.whenMissing("")'),
    scalarBlock('parRid', '_p.rid.whenMissing("MISSING")'),
    scalarBlock('parId', '_p.id.whenMissing("")'),
    scalarBlock('parName', '_p.name.whenMissing("")'),
    scalarBlock('parType', '_p.className.whenMissing("")'),
    scalarBlock('tmplRid', '_t.rid.whenMissing("MISSING")'),
    scalarBlock('tmplId', '_t.id.whenMissing("")'),
    scalarBlock('tmplName', '_t.name.whenMissing("")'),
    scalarBlock('tmplType', '_t.className.whenMissing("")'),
    // A ClassConfig application has the same *MethodConfig class but resolves
    // a linked master through ecResolveTemplate. Only the master definition
    // combines a MethodConfig class with no linked/template object.
    '_propertyMode := FALSE',
    'IF _t = MISSING THEN',
    '  IF _o.className.whenMissing("") = "*MethodConfig" THEN',
    '    _propertyMode := TRUE',
    '  ELSE',
    '    _propertyMode := FALSE',
    '  ENDIF',
    'ELSE',
    '  _propertyMode := FALSE',
    'ENDIF',
    scalarBlock('isPropertyDefinition', 'output(_propertyMode)'),
    'IF _propertyMode = FALSE THEN',
    // Effective detail card — the object's own `.card`, else (for enterprise
    // objects, whose instance `.card` is empty) the template's. `.card` is
    // null-safe in BMP (returns MISSING, never throws) for types without
    // HasCard — verified live across Container/FileResource/TextMethodConfig/
    // Organisation/Scorecard/CeRiskAssessment — so the eager `whenMissing` arg
    // (`_t.card`) can't blank the pane. Resolved here, after identity/parent/
    // template are emitted, so even a surprise failure leaves those intact.
    '_card := _o.card.whenMissing(_t.card)',
    scalarBlock('cardRid', '_card.rid.whenMissing("MISSING")'),
    scalarBlock('cardId', '_card.id.whenMissing("")'),
    scalarBlock('cardName', '_card.name.whenMissing("")'),
    scalarBlock('cardType', '_card.className.whenMissing("")'),
    scalarBlock('instCardRid', '_o.card.rid.whenMissing("")'),
  ];
  // Style props on instance + template — output() wrapper handles non-string
  // values (booleans, enums) which EC's bare-concat doesn't. Re-validate
  // every prop name even though they come from allowlists — slot-level
  // defence so corrupted metadata can't produce broken/hostile EC.
  // Every EAV slot below is emitted ONLY when non-empty (condEcBlock /
  // condRefEc / condIndirectEc). This union reads ~100 properties across all
  // types but any one object sets a handful — emitting the empty rest cost
  // ~65 bytes each (sentinel ×2 + label + 19-digit RID), i.e. multiple KB of
  // empty markers on every inspect. The parser already treats a missing block
  // as empty (`?? ''` / `if (v)`), so behaviour is identical. The identity /
  // parent / template / card blocks above stay unconditional — they use the
  // MISSING sentinel and parseIdentityBlock depends on their presence.
  for (const prop of paneProps) {
    validateEcIdentifier(prop);
    lines.push(...condEcBlock(`"inst_${prop}"`, `output(_o.${prop}.whenMissing(""))`));
    lines.push(...condEcBlock(`"tmpl_${prop}"`, `output(_t.${prop}.whenMissing(""))`));
  }
  // EditField.propertyMapping targets a property on the business-object type
  // configured by the CreateObjectView(s) that reference the parent EditPage.
  // Emit the owning classes once with the pane payload so the UI can reuse the
  // normal FETCH_TYPE_SCHEMA cache. A shared EditPage can have more than one
  // view, so keep every class; the picker intersects them client-side.
  lines.push('_editFieldTypes := ""');
  lines.push('IF _o.className.whenMissing("") = "EditField" THEN');
  lines.push('  _o.parent.rref(editPage).forEach(_view:');
  lines.push('    _editFieldType := _view.objectType.className.whenMissing("")');
  lines.push('    IF _editFieldType <> "" THEN _editFieldTypes := _editFieldTypes + _editFieldType + "," ELSE _editFieldTypes := _editFieldTypes ENDIF');
  lines.push('  )');
  // A newly-created or intentionally standalone EditPage may not yet be
  // referenced by a CreateObjectView. Its own `types` are still the
  // authoritative mapping surface, so use them when reverse references yield
  // no class. This keeps a field configurable immediately after Blueprint
  // creates the page instead of requiring a circular "wire it before you can
  // configure it" workflow.
  lines.push('  IF _editFieldTypes = "" THEN');
  lines.push('    _o.parent.types.forEach(_type:');
  lines.push('      _editFieldTypes := _editFieldTypes + output(_type) + ","');
  lines.push('    )');
  lines.push('  ELSE');
  lines.push('    _editFieldTypes := _editFieldTypes');
  lines.push('  ENDIF');
  lines.push('ENDIF');
  lines.push(...condEcBlock('"editFieldTypes"', 'output(_editFieldTypes)'));
  // Code fields — union across all known types.
  for (const cf of ALL_CODE_FIELDS) {
    validateEcIdentifier(cf);
    lines.push(...condEcBlock(`"code_${cf}"`, `output(_o.${cf}.whenMissing(""))`));
  }
  // Reference edges — RID + business ID + name + className per edge.
  for (const rf of ALL_REFERENCE_FIELDS) {
    lines.push(...condRefEc(rf));
  }
  // Indirect code fields — Reference → ExtendedExpression.expression. The
  // backing reference rid (for the Edit redirect) rides along inside the same
  // conditional, so it's only emitted when the indirect EC actually exists.
  for (const ind of ALL_INDIRECT_FIELDS) {
    lines.push(...condIndirectEc(`ind_${ind.prop}_${ind.targetProp}`, `_o.${ind.prop}`, ind.targetProp));
  }
  // Context fields (enum / boolean) — list-ref handled separately below.
  for (const ctx of ALL_CONTEXT_FIELDS) {
    if (ctx.kind === 'list-ref') continue;
    lines.push(...condEcBlock(`"ctx_${ctx.prop}"`, `output(_o.${ctx.prop}.whenMissing(""))`));
  }
  // Gate values — booleans that control whether a code field is active.
  for (const eb of ALL_ENABLED_BY_PROPS) {
    lines.push(...condEcBlock(`"gate_${eb}"`, `output(_o.${eb}.whenMissing(""))`));
  }
  // List-ref context fields — iterate each list, emit pipe rows.
  for (const ctx of ALL_CONTEXT_FIELDS) {
    if (ctx.kind !== 'list-ref') continue;
    lines.push(`_r := _r + _sep + "list_${ctx.prop}" + _sep + "\\n"`);
    lines.push(`IF _o.${ctx.prop} != MISSING THEN`);
    lines.push(`  _o.${ctx.prop}.forEach(_i:`);
    lines.push(pipeRowNoKey('_i', '    '));
    lines.push(`  )`);
    lines.push(`ENDIF`);
  }
  // Siblings — children of webParent. IF-guard means top-level objects (no
  // parent) skip the loop entirely; statement-form IF is the only flavor.
  // Capped at SIBLING_CAP rows: _sibN counts EVERY child (so `sibTotal` is the
  // true count for the UI), but the expensive per-child reads + row concat only
  // run for the first SIBLING_CAP. Avoids O(N) work + a huge payload when the
  // parent has thousands of children.
  lines.push(`_r := _r + _sep + "siblings" + _sep + "\\n"`);
  lines.push('_curRid := _o.rid');
  lines.push('_sibN := 0');
  lines.push('IF _p != MISSING THEN');
  lines.push('  _p.children().forEach(_s:');
  lines.push('    _sibN := _sibN + 1');
  lines.push(`    IF _sibN <= ${SIBLING_CAP} THEN`);
  lines.push(`      _r := _r + _s.rid.whenMissing("") + "|" + _s.id.whenMissing("") + "|" + _s.name.whenMissing("") + "|" + _s.className.whenMissing("") + "|"`);
  lines.push('      IF _s.rid = _curRid THEN');
  lines.push('        _r := _r + "1"');
  lines.push('      ELSE');
  lines.push('        _r := _r + "0"');
  lines.push('      ENDIF');
  lines.push(`      _r := _r + "\\n"`);
  lines.push('    ENDIF');
  lines.push('  )');
  lines.push('ENDIF');
  // True total (all children, not just the emitted slice) so the navigator can
  // show "showing N of M". output() stringifies the number for bare concat.
  lines.push(scalarBlock('sibTotal', 'output(_sibN)'));
  lines.push('ENDIF');
  lines.push('IF _propertyMode = TRUE THEN');
  // The compact Property view consumes only these definition fields. Keep the
  // widget union, card resolution, relationship fields and sibling traversal
  // entirely outside this branch.
  for (const prop of ['description', 'category'] as const) {
    lines.push(...condEcBlock(`"inst_${prop}"`, `output(_o.${prop}.whenMissing(""))`, '  '));
  }
  lines.push(...condEcBlock('"code_expression"', 'output(_o.expression.whenMissing(""))', '  '));
  lines.push('ENDIF');
  lines.push(...footer());
  return lines.join('\n');
}

export type { PaneProp };
