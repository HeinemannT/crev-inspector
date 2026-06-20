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
  ALL_CONTEXT_FIELDS, ALL_ENABLED_BY_PROPS, type ContextFieldDef,
} from './widget-metadata';
import type { PaneProp } from './bmp-client';
import { validateEcIdentifier } from './ec-guards';

/** Separator used by every walker EC + their parsers. Hardcoded string (never
 *  user input) so it can't be injected via EC values. */
export const FLOW_SEP = '<<<CREV_SEP>>>';

/** Max sibling rows emitted by the object-pane EC. The sibling navigator only
 *  needs a browseable slice; without this, an object under a parent with
 *  thousands of children paid O(N) per-child property reads + concat + payload
 *  on every pane open (the dominant cost behind "clicking an object is slow in
 *  this workspace"). We still count ALL children so the UI can show the true
 *  total — see `sibTotal` in buildObjectPaneEc / ObjectPaneData.siblingTotal. */
export const SIBLING_CAP = 25;

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

/** EC fragment that emits `{sep}child_<prop>_<rid>{sep}<ec text>\n` — the
 *  per-child code-field block that the parser keys by RID. `prop` is
 *  interpolated into the EC source itself (as `.${prop}`), so a hostile
 *  string like `x, hostile := lookup(123)` would break out of the
 *  property access. We re-validate at every slot even though callers
 *  pass values from ALL_CODE_FIELDS — defence-in-depth. */
function childEcEmit(prop: string, varName = '_c', prefix = ''): string {
  validateEcIdentifier(prop);
  return `${prefix}_r := _r + _sep + "child_${prop}_" + ${varName}.rid.whenMissing("") + _sep + output(${varName}.${prop}.whenMissing("")) + "\\n"`;
}

/** EC fragment that emits a single header section: `{sep}<label>{sep}<value>\n`. */
function scalarBlock(label: string, valueExpr: string, prefix = ''): string {
  return `${prefix}_r := _r + _sep + "${label}" + _sep + ${valueExpr} + "\\n"`;
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
  return CHILD_EC_PROPS.map(prop => childEcEmit(prop, '_c', indent));
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
    ...footer(),
  ].join('\n');
}

/** Walk a NotificationTransportGroup → its ExtendedTransport children. The
 *  className filter keeps non-EC siblings out of the chain. */
export function buildTransportGroupFlowEc(ref: string): string {
  return [
    ...preamble(ref),
    pipeRow('_o', 'grp'),
    `_r := _r + _sep + "children" + _sep + "\\n"`,
    '_o.children().forEach(_c:',
    '  IF _c.className = "ExtendedTransport" THEN',
    pipeRowNoKey('_c', '    '),
    '  ENDIF',
    ')',
    '_o.children().forEach(_c:',
    '  IF _c.className = "ExtendedTransport" THEN',
    childEcEmit('expression', '_c', '    '),
    '  ENDIF',
    ')',
    ...footer(),
  ].join('\n');
}

/**
 * fetchActionButtonFlow EC. The button itself carries direct EC (expression /
 * init / after) plus an indirect showExpression that resolves through
 * ExtendedExpression.expression. The chain target depends on actionType:
 *   ACTION   → walk actionObject (NotificationTransportGroup) → ExtendedTransport
 *   ADD / NAVIGATE → expression on the button IS the EC (no chain to walk)
 *   EDIT     → actionObject is the edit target (no EC chain)
 */
export function buildActionButtonFlowEc(ref: string): string {
  return [
    ...preamble(ref),
    '_act := _o.actionObject',
    '_actType := _o.actionType.whenMissing("")',
    `_r := _r + _sep + "ab" + _sep + _o.rid.whenMissing("") + "|" + _o.id.whenMissing("") + "|" + _o.name.whenMissing("") + "|" + _o.className.whenMissing("") + "|" + _actType + "\\n"`,
    scalarBlock('ab_expression', 'output(_o.expression.whenMissing(""))'),
    scalarBlock('ab_initExpression', 'output(_o.initExpression.whenMissing(""))'),
    scalarBlock('ab_afterExpression', 'output(_o.afterExpression.whenMissing(""))'),
    scalarBlock('ab_showExpression', 'output(_o.showExpression.expression.whenMissing(""))'),
    // RID of the ExtendedExpression that backs showExpression. Walker uses this
    // so the Edit button on the indirect EC opens the TARGET's `.expression`
    // field, not the AB's `.showExpression` (which is a Reference, not an EC).
    scalarBlock('ab_showExpression_rid', '_o.showExpression.rid.whenMissing("")'),
    'IF _act != MISSING THEN',
    pipeRow('_act', 'act', '  '),
    `  _r := _r + _sep + "actchildren" + _sep + "\\n"`,
    '  _act.children().forEach(_c:',
    '    IF _c.className = "ExtendedTransport" THEN',
    pipeRowNoKey('_c', '      '),
    '    ENDIF',
    '  )',
    '  _act.children().forEach(_c:',
    '    IF _c.className = "ExtendedTransport" THEN',
    `      _r := _r + _sep + "actchild_expression_" + _c.rid.whenMissing("") + _sep + output(_c.expression.whenMissing("")) + "\\n"`,
    '    ENDIF',
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
    scalarBlock('lbl_defaultExpression', 'output(_o.defaultExpression.whenMissing(""))'),
    scalarBlock('lbl_expression', 'output(_o.expression.whenMissing(""))'),
    ...footer(),
  ].join('\n');
}

// ── Object pane ──────────────────────────────────────────────────

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
    '_p := _o.webParent',
    '_t := _o.linkedTo',
    'IF _t = MISSING THEN _t := _o.template ENDIF',
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
  for (const prop of paneProps) {
    validateEcIdentifier(prop);
    lines.push(scalarBlock(`inst_${prop}`, `output(_o.${prop}.whenMissing(""))`));
    lines.push(scalarBlock(`tmpl_${prop}`, `output(_t.${prop}.whenMissing(""))`));
  }
  // Code fields — union across all known types.
  for (const cf of ALL_CODE_FIELDS) {
    validateEcIdentifier(cf);
    lines.push(scalarBlock(`code_${cf}`, `output(_o.${cf}.whenMissing(""))`));
  }
  // Reference edges — RID + business ID + name + className per edge.
  for (const rf of ALL_REFERENCE_FIELDS) {
    validateEcIdentifier(rf);
    lines.push(scalarBlock(`ref_${rf}_rid`, `_o.${rf}.rid.whenMissing("")`));
    lines.push(scalarBlock(`ref_${rf}_id`, `_o.${rf}.id.whenMissing("")`));
    lines.push(scalarBlock(`ref_${rf}_name`, `_o.${rf}.name.whenMissing("")`));
    lines.push(scalarBlock(`ref_${rf}_type`, `_o.${rf}.className.whenMissing("")`));
  }
  // Indirect code fields — Reference → ExtendedExpression.expression.
  // We also capture the reference's own rid so the Edit button can target the
  // ExtendedExpression directly (otherwise it'd open the source object's
  // same-named property, which is the Reference handle — not editable as EC).
  for (const ind of ALL_INDIRECT_FIELDS) {
    lines.push(scalarBlock(`ind_${ind.prop}_${ind.targetProp}`,
      `output(_o.${ind.prop}.${ind.targetProp}.whenMissing(""))`));
    lines.push(scalarBlock(`ind_${ind.prop}_${ind.targetProp}_rid`,
      `_o.${ind.prop}.rid.whenMissing("")`));
  }
  // Context fields (enum / boolean) — list-ref handled separately below.
  for (const ctx of ALL_CONTEXT_FIELDS) {
    if (ctx.kind === 'list-ref') continue;
    lines.push(scalarBlock(`ctx_${ctx.prop}`, `output(_o.${ctx.prop}.whenMissing(""))`));
  }
  // Gate values — booleans that control whether a code field is active.
  for (const eb of ALL_ENABLED_BY_PROPS) {
    lines.push(scalarBlock(`gate_${eb}`, `output(_o.${eb}.whenMissing(""))`));
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
  lines.push(...footer());
  return lines.join('\n');
}

// Re-export ContextFieldDef so test files can import from one place if needed.
export type { ContextFieldDef, PaneProp };
