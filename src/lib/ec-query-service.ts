/**
 * EC-query service — the "build EC string → run it → parse rows" family,
 * extracted from bmp-client.ts (plan 021). BmpClient owns transport / auth /
 * identity cache / binary commands / health probing and forwards to this
 * service for everything that's a pure EC round trip.
 *
 * Constructor deps are two BmpClient methods (bound dynamically, so tests
 * that monkey-patch `client.executeEc` / `client.resolveRef` after
 * construction still keep working) plus the PANE_PROPS allowlist. No
 * back-reference to BmpClient itself — see plan 021 for the coupling analysis.
 *
 * New EC queries go here; new binary commands stay in bmp-client.ts.
 */

import type { EcResult, TemplateResolution, EditorContextData, ObjectPaneSibling, ObjectPaneRef, ObjectPaneData } from './bmp-client';
import { log } from './logger';
import { BATCH_CHUNK_SIZE, MAX_PARALLEL } from './constants';
import { pMap } from './util';
import { parsePipeLines, parseSepBlocks, parseSepMultiObject } from './ec-parser';
import { buildRowEc, identityRow, parseDelimitedLines, parseDelimitedRow } from './ec-row-codec';
import { validateEcIdentifier } from './ec-guards';
import { ecResolveTemplate } from './template-link';
import { LAYOUT_SEP, parseLayoutNodes } from './layout-wire';
import { stripWidgetContent } from './layout/model';
import type { ColorSetData, ObjectPaneCard, ObjectPaneIdentity, AccessSubject, LayoutNode } from './types';
import {
  parsePipeRow, parsePipeRowWithKey, parseAbRow, makeCodeField, splitNamedRow,
} from './flow-parser';
import type { FlowChain, FlowStep, FlowIdentity, FlowCodeField } from './flow-parser';
import {
  buildInputViewFlowEc, buildInputSetFlowEc, buildTransportGroupFlowEc,
  buildActionButtonFlowEc, buildLabelFlowEc, buildObjectPaneEc, FLOW_SEP,
} from './ec-codegen';
import {
  ALL_CODE_FIELDS, ALL_REFERENCE_FIELDS,
  ALL_INDIRECT_FIELDS, ALL_CONTEXT_FIELDS, ALL_ENABLED_BY_PROPS,
  normalizeBmpEnum,
} from './widget-metadata';

/** Build the FlowCodeField[] for an InputSet child (input field, ButtonInput,
 *  Label) from the sep-block-parsed walker response. Shared between the IV
 *  walker (which walks IV → IS → children) and the IS walker (which starts
 *  at IS). Each child has up to 5 EC props (after/expression/default/show/
 *  enable); show + enable are gated by the matching useShow/useEnable flags. */
function buildChildCodeFields(
  data: Record<string, string>,
  childRid: string,
  inputKeys: Array<{ key: string; sourceRid: string }>,
): FlowCodeField[] {
  const out: FlowCodeField[] = [];
  const after = data[`child_afterExpression_${childRid}`];
  if (after) out.push(makeCodeField('afterExpression', after, inputKeys));
  const expr = data[`child_expression_${childRid}`];
  if (expr) out.push(makeCodeField('expression', expr, inputKeys));
  const def = data[`child_defaultExpression_${childRid}`];
  if (def) out.push(makeCodeField('defaultExpression', def, inputKeys));
  const useShow = data[`child_useShowExpression_${childRid}`] ?? '';
  const showEc = data[`child_showExpression_${childRid}`];
  if (showEc) {
    const f = makeCodeField('showExpression', showEc, inputKeys);
    f.gateProp = 'useShowExpression';
    f.gateValue = useShow;
    out.push(f);
  }
  const useEnable = data[`child_useEnableExpression_${childRid}`] ?? '';
  const enableEc = data[`child_enableExpression_${childRid}`];
  if (enableEc) {
    const f = makeCodeField('enableExpression', enableEc, inputKeys);
    f.gateProp = 'useEnableExpression';
    f.gateValue = useEnable;
    out.push(f);
  }
  return out;
}

/** Code fields for one action/transport-group child, keyed by `keyPrefix`
 *  (`child` for the transport-group walk, `actchild` for the action-button
 *  walk). Mirrors transportChildEc in ec-codegen: ExtendedTransport.expression
 *  and ChangePropertyTransport.value / function / dateFunction. Non-EC
 *  transports yield no fields and render as a bare node. */
function buildTransportCodeFields(
  data: Record<string, string>,
  childRid: string,
  keyPrefix: string,
): FlowCodeField[] {
  const out: FlowCodeField[] = [];
  for (const prop of ['expression', 'value', 'function', 'dateFunction'] as const) {
    const text = data[`${keyPrefix}_${prop}_${childRid}`];
    if (text) out.push(makeCodeField(prop, text, []));
  }
  return out;
}

/** Nest the action graph (parsed from the supplemental blocks emitted by
 *  inputActionEc) under each action-bearing InputSet button: button →
 *  actionObject (transport group) → transports + their EC. `childByRid` maps a
 *  child's rid to its FlowStep so owners are found in one pass. */
function attachActionSubtrees(data: Record<string, string>, childByRid: Map<string, FlowStep>): void {
  // Both blocks carry 3 leading id columns + a free-text name + 1 trailing
  // className (see inputActionEc), so a `|` in a name can't shift the columns.
  const splitRows = (block: string | undefined): string[][] =>
    (block ?? '').split('\n').map(l => splitNamedRow(l, 3, 1)).filter((r): r is string[] => r !== null);

  // A transport group can be referenced by more than one button (e.g. a form
  // button and a group button both fire the same action), so map each ntgRid to
  // ALL its owner-nested copies and fan the transports out to every one.
  const ntgByRid = new Map<string, FlowStep[]>();
  for (const [ownerRid, ntgRid, ntgId, ntgName, ntgClass] of splitRows(data.actiongroups)) {
    const owner = ownerRid ? childByRid.get(ownerRid) : undefined;
    if (!owner || !ntgRid) continue;
    const ntgStep: FlowStep = {
      identity: { rid: ntgRid, businessId: ntgId ?? '', name: ntgName ?? '', type: ntgClass ?? '' },
      edgeLabel: 'actionObject',
      children: [],
    };
    (owner.children ??= []).push(ntgStep);
    const copies = ntgByRid.get(ntgRid);
    if (copies) copies.push(ntgStep); else ntgByRid.set(ntgRid, [ntgStep]);
  }
  // Transports are emitted once per owner, so the same (group, transport) pair
  // repeats — dedupe before fanning out.
  const seen = new Set<string>();
  for (const [ntgRid, transRid, id, name, cls] of splitRows(data.actiontransports)) {
    if (!ntgRid || !transRid || seen.has(`${ntgRid}|${transRid}`)) continue;
    seen.add(`${ntgRid}|${transRid}`);
    const targets = ntgByRid.get(ntgRid);
    if (!targets) continue;
    for (const ntg of targets) {
      const tStep: FlowStep = { identity: { rid: transRid, businessId: id ?? '', name: name ?? '', type: cls ?? '' } };
      const code = buildTransportCodeFields(data, transRid, 'child');
      if (code.length > 0) tStep.codeFields = code;
      ntg.children!.push(tStep);
    }
  }
}

/** Nest each ButtonGroup's child buttons (from the `groupkids` block) under the
 *  group FlowStep, with their input EC. Newly nested buttons are added to
 *  `childByRid` so a later action pass can still resolve them as owners. */
function attachButtonGroups(
  data: Record<string, string>,
  childByRid: Map<string, FlowStep>,
  inputKeys: Array<{ key: string; sourceRid: string }>,
): void {
  for (const line of (data.groupkids ?? '').split('\n')) {
    // groupRid|childRid|id|name|className|key — 3 leading ids, name, 2 trailing.
    const cols = splitNamedRow(line, 3, 2);
    if (!cols) continue;
    const [groupRid, childRid, id, name, cls, key] = cols;
    const group = groupRid ? childByRid.get(groupRid) : undefined;
    if (!group || !childRid) continue;
    const btn: FlowStep = { identity: { rid: childRid, businessId: id ?? '', name: name ?? '', type: cls ?? '' } };
    if (key) btn.inputKey = key;
    const code = buildChildCodeFields(data, childRid, inputKeys);
    if (code.length > 0) btn.codeFields = code;
    (group.children ??= []).push(btn);
    childByRid.set(childRid, btn);
  }
}

/** Populate an InputSet FlowStep with its children: the flat `children` block
 *  (+ per-child EC + cross-reference keys), ButtonGroup expansion, then every
 *  action-bearing button's actionObject graph. Shared by the InputView and
 *  InputSet walkers, which differ only in their wrapper step. `isStep.children`
 *  must already be initialized. */
function populateInputSetChildren(data: Record<string, string>, isStep: FlowStep): void {
  const childRows = (data.children ?? '').split('\n')
    .map(parsePipeRowWithKey)
    .filter((r): r is { rid: string; businessId: string; name: string; type: string; key: string } => r !== null);
  const inputKeys: Array<{ key: string; sourceRid: string }> = [];
  for (const c of childRows) {
    if (c.key) inputKeys.push({ key: c.key, sourceRid: c.rid });
  }

  const childByRid = new Map<string, FlowStep>();
  for (const c of childRows) {
    const child: FlowStep = { identity: { rid: c.rid, businessId: c.businessId, name: c.name, type: c.type } };
    if (c.key) child.inputKey = c.key;
    const code = buildChildCodeFields(data, c.rid, inputKeys);
    if (code.length > 0) child.codeFields = code;
    isStep.children!.push(child);
    childByRid.set(c.rid, child);
  }
  // Expand ButtonGroups first so group buttons can own actions too, then nest
  // each action-bearing button's actionObject → transport graph.
  attachButtonGroups(data, childByRid, inputKeys);
  attachActionSubtrees(data, childByRid);
}

/** Parse a `<prefix>Rid/Id/Name/Type` identity block out of a parseSepBlocks
 *  map. Returns null when the rid is absent/`MISSING`. Shared by
 *  fetchEditorContext (inst/tmpl) and fetchObjectPane (inst/par/tmpl/card) so
 *  the blocks can't drift apart. */
function parseIdentityBlock(data: Record<string, string | undefined>, prefix: string): ObjectPaneIdentity | null {
  const rid = data[`${prefix}Rid`];
  if (!rid || rid === 'MISSING') return null;
  return {
    rid,
    businessId: data[`${prefix}Id`] ?? '',
    type: data[`${prefix}Type`] ?? '',
    name: data[`${prefix}Name`] ?? '',
  };
}

/** Build the EC for `listAccessSubjects`: every user then every role, each as
 *  a `kind|||rid|||id|||name` row. Exported so a golden test can lock the
 *  exact EC string in. */
export function buildAccessSubjectsEc(): string {
  const userRow = buildRowEc([
    { name: 'kind', expr: '"user"' },
    { name: 'rid', expr: '_u.rid' },
    { name: 'id', expr: '_u.id.whenMissing("")' },
    { name: 'name', expr: '_u.name.whenMissing("")' },
  ], '|||');
  const roleRow = buildRowEc([
    { name: 'kind', expr: '"role"' },
    { name: 'rid', expr: '_r.rid' },
    { name: 'id', expr: '_r.id.whenMissing("")' },
    { name: 'name', expr: '_r.name.whenMissing("")' },
  ], '|||');
  return [
    '_out := ""',
    'root.user.children().forEach(_u:',
    `     _out := _out + ${userRow} + "\\n"`,
    ')',
    'root.role.children().forEach(_r:',
    `     _out := _out + ${roleRow} + "\\n"`,
    ')',
    '_out',
  ].join('\n');
}

/** Parse the `buildAccessSubjectsEc` output into sorted access subjects. */
export function parseAccessSubjectsLog(ecLog: string): AccessSubject[] {
  const subjects: AccessSubject[] = [];
  for (const row of parseDelimitedLines(ecLog, ['kind', 'rid', 'id', 'name'], '|||')) {
    if ((row.kind !== 'user' && row.kind !== 'role') || !row.rid || row.rid === 'MISSING') continue;
    subjects.push({
      rid: row.rid,
      name: row.name || row.id || row.rid,
      kind: row.kind,
      businessId: row.id || undefined,
    });
  }
  return subjects.sort((a, b) => a.name.localeCompare(b.name));
}

/** Parse `resolveTemplate`'s `rid|||name|||className|||id` output line
 *  (skipping BMP's "Result : 0" / "Duration" log noise) into a
 *  TemplateResolution. Exported so a golden test can lock the exact
 *  field order + MISSING-sentinel handling in. */
export function parseResolveTemplateLog(ecLog: string): TemplateResolution {
  // Find the output line (contains |||) — skip "Result : 0", "Duration" etc.
  const lines = ecLog.trim().split('\n');
  const match = lines.find(l => l.includes('|||'))?.trim();
  if (!match || match.startsWith('MISSING')) return { templateRid: null };

  // minFields: 1 — the row's trailing fields (name/className/id) are genuinely
  // optional in practice (BMP can emit a short row); only rid is required.
  const row = parseDelimitedRow(match, ['rid', 'name', 'className', 'id'], '|||', { minFields: 1 });
  const tRid = row?.rid;
  if (!tRid || tRid === 'MISSING') return { templateRid: null };
  return {
    templateRid: tRid,
    templateName: row.name || undefined,
    templateType: row.className || undefined,
    templateBusinessId: row.id || undefined,
  };
}

/** Build the EC for `fetchLayoutTree`. Emits the shared layout wire format
 *  (see layout-wire.ts): one node per LAYOUT_SEP marker, fields
 *  rid|bid|type|parentRid|containerRid|L|M|S|chartHeight|name. `name` is
 *  LAST (free-text, parsed as the rest) so a `|` in a name can't shift the
 *  structural fields. Exported so a golden test can lock the exact EC
 *  string in. */
export function buildLayoutTreeEc(ref: string): string {
  const nodeRow = buildRowEc([
    { name: 'rid', expr: '_n.rid' },
    { name: 'id', expr: '_n.id.whenMissing("")' },
    { name: 'className', expr: '_n.className.whenMissing("")' },
    { name: 'parentRid', expr: '_p.rid.whenMissing("")' },
    { name: 'containerRid', expr: '_c.rid.whenMissing("")' },
    { name: 'L', expr: '_n.columnsLargeScreen.whenMissing("")' },
    { name: 'M', expr: '_n.columnsMediumScreen.whenMissing("")' },
    { name: 'S', expr: '_n.columnsSmallScreen.whenMissing("")' },
    { name: 'chartHeight', expr: '_n.chartHeight.whenMissing("")' },
    { name: 'name', expr: '_n.name.whenMissing("")' },
  ], '|');
  // Root row: same 10-field shape, but the root has no parent/container/
  // chartHeight of its own — those three columns are literal empties.
  const rootRow = buildRowEc([
    { name: 'rid', expr: '_root.rid' },
    { name: 'id', expr: '_root.id.whenMissing("")' },
    { name: 'className', expr: '_root.className.whenMissing("")' },
    { name: 'parentRid', expr: '""' },
    { name: 'containerRid', expr: '""' },
    { name: 'L', expr: '_root.columnsLargeScreen.whenMissing("")' },
    { name: 'M', expr: '_root.columnsMediumScreen.whenMissing("")' },
    { name: 'S', expr: '_root.columnsSmallScreen.whenMissing("")' },
    { name: 'chartHeight', expr: '""' },
    { name: 'name', expr: '_root.name.whenMissing("")' },
  ], '|');
  return `
_root := ${ref}
_r := ""
_root.descendants().forEach(_n:
     _p := _n.parent
     _c := _n.container
     _r := _r + "${LAYOUT_SEP}" + ${nodeRow} + "\\n"
)
_r := _r + "${LAYOUT_SEP}" + ${rootRow} + "\\n"
_r
`.trim();
}

/** Parse `java.awt.Color[r=219,g=132,b=61]` → `rgb(219,132,61)`, else ''. */
export function parseAwtColor(s: string): string {
  const m = /r=(\d+),\s*g=(\d+),\s*b=(\d+)/.exec(s);
  return m ? `rgb(${m[1]},${m[2]},${m[3]})` : '';
}

export class EcQueryService {
  constructor(
    /** BmpClient.executeEc, called dynamically (not `.bind()`-captured) so
     *  tests that monkey-patch `client.executeEc` after construction still
     *  intercept calls made through this service. */
    private readonly executeEc: (
      code: string,
      objectRid?: string,
      transactional?: boolean,
      signal?: AbortSignal,
      timeoutMs?: number,
    ) => Promise<EcResult>,
    /** BmpClient.resolveRef, same dynamic-dispatch rationale. */
    private readonly resolveRef: (rid: string) => Promise<string>,
    /** BmpClient.PANE_PROPS — passed by value so this file doesn't need to
     *  import a runtime value back out of bmp-client.ts. */
    private readonly paneProps: readonly string[],
  ) {}

  // ── Access-trace subject listing ─────────────────────────────

  /** List users + roles (the possible trace subjects) via EC, sorted by name. */
  async listAccessSubjects(): Promise<AccessSubject[]> {
    const result = await this.executeEc(buildAccessSubjectsEc());
    return parseAccessSubjectsLog(result.log ?? '');
  }

  // ── Template / enrichment ─────────────────────────────────────

  /** Resolve template for a linked instance (pure EC) */
  async resolveTemplate(rid: string): Promise<TemplateResolution> {
    const ref = await this.resolveRef(rid);
    const code = [
      `_o := ${ref}`,
      ...ecResolveTemplate('_o', '_t'),
      buildRowEc(identityRow('_t', { ridDefault: '"MISSING"', order: ['rid', 'name', 'className', 'id'] }), '|||'),
    ].join('\n');
    const ecResult = await this.executeEc(code, undefined, false);
    if (!ecResult.ok || !ecResult.log) return { templateRid: null };
    return parseResolveTemplateLog(ecResult.log);
  }

  /** Batch enrich: get businessId, type, name, templateBusinessId for multiple RIDs.
   *  Version-aware: uses resolveRef() which returns lookup(rid) on 5.6.3+ or
   *  namespace refs (t.{bid}) on pre-5.6.3. Works on all BMP versions. */
  async batchEnrich(rids: string[], signal?: AbortSignal): Promise<{ results: Record<string, { businessId?: string; type?: string; name?: string; templateBusinessId?: string; cascade?: { rid: string; businessId?: string; type?: string; name?: string } }>; error?: string }> {
    let valid = rids.filter(Boolean).filter(rid => /^-?\d+$/.test(rid));
    if (valid.length === 0) return { results: {} };
    if (valid.length > BATCH_CHUNK_SIZE) valid = valid.slice(0, BATCH_CHUNK_SIZE);

    // Resolve all refs in parallel (version-aware: lookup() or t.{bid})
    const resolved = await pMap(valid, async (rid): Promise<{ rid: string; ref: string } | null> => {
      try {
        const ref = await this.resolveRef(rid);
        return { rid, ref };
      } catch (e) {
        log.debug('batchEnrich', `resolveRef failed for ${rid}:`, e);
        return null;
      }
    }, MAX_PARALLEL);
    const refs = resolved.filter((r): r is { rid: string; ref: string } => r !== null);

    if (refs.length === 0) {
      return { results: {}, error: `All ${valid.length} RIDs failed ref resolution` };
    }

    const lines = ['_d := "|||"', '_r := ""'];
    for (const { rid, ref } of refs) {
      lines.push(`_o := ${ref}`);
      lines.push('IF _o != MISSING THEN');
      lines.push(...ecResolveTemplate('_o', '_t', '  '));
      lines.push('  _tid := (IF _t != MISSING THEN _t.id.whenMissing("") ELSE "" ENDIF)');
      // Cascade target — for flow-bearing widgets we surface the next link in
      // the chain so the badge can render a second pill. Non-flow types skip
      // the body via className guards (cheap when not matched).
      lines.push('  _cls := _o.className');
      lines.push('  _cRid := ""');
      lines.push('  _cBid := ""');
      lines.push('  _cType := ""');
      lines.push('  _cName := ""');
      lines.push('  IF _cls = "InputView" THEN');
      lines.push('    _cRid := output(_o.inputSet.rid.whenMissing(""))');
      lines.push('    _cBid := _o.inputSet.id.whenMissing("")');
      lines.push('    _cType := _o.inputSet.className.whenMissing("")');
      lines.push('    _cName := _o.inputSet.name.whenMissing("")');
      lines.push('  ENDIF');
      lines.push('  IF _cls = "ActionButton" THEN');
      lines.push('    _cRid := output(_o.actionObject.rid.whenMissing(""))');
      lines.push('    _cBid := _o.actionObject.id.whenMissing("")');
      lines.push('    _cType := _o.actionObject.className.whenMissing("")');
      lines.push('    _cName := _o.actionObject.name.whenMissing("")');
      lines.push('  ENDIF');
      const row = buildRowEc([
        { name: 'rid', expr: `"${rid}"` },
        { name: 'id', expr: '_o.id.whenMissing("")' },
        { name: 'className', expr: '_cls.whenMissing("")' },
        { name: 'name', expr: '_o.name.whenMissing("")' },
        { name: 'templateBid', expr: '_tid' },
        { name: 'cascadeRid', expr: '_cRid' },
        { name: 'cascadeBid', expr: '_cBid' },
        { name: 'cascadeType', expr: '_cType' },
        { name: 'cascadeName', expr: '_cName' },
      ], '|||');
      lines.push(`  _r := _r + ${row} + "\\n"`);
      lines.push('ENDIF');
    }
    lines.push('_r');
    const code = lines.join('\n');

    const result = await this.executeEc(code, undefined, false, signal);
    if (!result.ok) { log.debug('batchEnrich', `EC failed for ${refs.length} RIDs:`, result.error); return { results: {}, error: result.error ?? 'EC execution failed' }; }
    if (result.log == null) { log.debug('batchEnrich', 'EC returned null output'); return { results: {}, error: 'EC returned null output' }; }
    if (result.log.trim() === '') { log.debug('batchEnrich', `EC returned empty for ${refs.length} RIDs:`, refs.map(r => r.rid)); return { results: {} }; }

    const out: Record<string, { businessId?: string; type?: string; name?: string; templateBusinessId?: string; cascade?: { rid: string; businessId?: string; type?: string; name?: string } }> = {};
    for (const parts of parsePipeLines(result.log, 4)) {
      // Format: rid|||bid|||type|||name|||tbid|||chainRid|||chainBid|||chainType|||chainName
      const rid = parts[0];
      const bid = parts[1] || undefined;
      const typ = parts[2] || undefined;
      const name = parts[3] || undefined;
      const tbid = parts[4] || undefined;
      const cRid = parts[5];
      const cBid = parts[6] || undefined;
      const cType = parts[7] || undefined;
      const cName = parts[8] || undefined;
      const entry: { businessId?: string; type?: string; name?: string; templateBusinessId?: string; cascade?: { rid: string; businessId?: string; type?: string; name?: string } } = {
        businessId: bid, type: typ, name, templateBusinessId: tbid,
      };
      // Only attach cascade if we got a real rid back. For non-flow widgets
      // (Scorecard, KPI, etc.) the IF guards left these blank.
      if (cRid) entry.cascade = { rid: cRid, businessId: cBid, type: cType, name: cName };
      out[rid] = entry;
    }
    const missed = refs.filter(r => !(r.rid in out));
    if (missed.length > 0) log.debug('batchEnrich', `${missed.length}/${refs.length} RIDs not resolved in EC:`, missed.map(r => r.rid));
    return { results: out };
  }

  // ── Code / children / editor-context fetches ─────────────────

  /** Fetch code properties via EC */
  async fetchCodeViaEc(rid: string, properties: string[]): Promise<Record<string, string>> {
    if (properties.length === 0) return {};
    const sep = '<<<CREV_SEP>>>';
    const ref = await this.resolveRef(rid);
    const lines = [`_o := ${ref}`, '_r := ""'];
    for (const prop of properties) {
      // `_o.${prop}` is an identifier slot (bare, not a string literal), so it
      // must be a valid EC identifier — defence-in-depth matching saveCodeViaEc.
      validateEcIdentifier(prop);
      lines.push(`_r := _r + "${sep}${prop}${sep}" + output(_o.${prop}.whenMissing("")) + "\\n"`);
    }
    lines.push(`_r := _r + "${sep}DONE"`);
    lines.push('_r');
    const result = await this.executeEc(lines.join('\n'));
    if (!result.ok || !result.log) return {};
    return parseSepBlocks(result.log, sep);
  }

  /** Batch fetch code properties for multiple objects in a single EC call */
  async batchFetchCode(
    rids: string[],
    properties: string[],
  ): Promise<Map<string, Record<string, string>>> {
    const result = new Map<string, Record<string, string>>();
    if (rids.length === 0 || properties.length === 0) return result;

    const valid = rids.filter(rid => /^-?\d+$/.test(rid));
    if (valid.length === 0) return result;

    // `_o.${prop}` below is a bare identifier slot — validate before building EC.
    properties.forEach(validateEcIdentifier);

    const sep = '<<<CREV_SEP>>>';
    const refs = await Promise.all(valid.map(rid => this.resolveRef(rid).catch(() => null)));
    const lines = [`_sep := "${sep}"`, '_r := ""'];
    for (let i = 0; i < valid.length; i++) {
      const ref = refs[i];
      if (!ref) continue; // skip unresolvable RIDs
      lines.push(`_o := ${ref}`);
      lines.push(`_r := _r + _sep + "OBJ" + _sep + _o.rid.whenMissing("SKIP") + "\\n"`);
      for (const prop of properties) {
        lines.push(`_r := _r + "${sep}${prop}${sep}" + output(_o.${prop}.whenMissing("")) + "\\n"`);
      }
    }
    lines.push(`_r := _r + "${sep}DONE"`);
    lines.push('_r');
    const code = lines.join('\n');

    const ecResult = await this.executeEc(code);
    if (!ecResult.ok || !ecResult.log) return result;
    return parseSepMultiObject(ecResult.log, sep);
  }

  /** Walk the layout subtree of a Scorecard / TabSet / Tab / Container.
   *  Returns flat nodes with parent linkage + responsive sizing — the
   *  panel folds these into a tree client-side. Single round trip via
   *  EC `.descendants()` so even deep nests cost one server call.
   *
   *  Returned types: Tab, TabSet, Container, plus widget objects bound to
   *  any container in the subtree (rendered as leaves with their cell
   *  reference). */
  async fetchLayoutTree(rid: string): Promise<LayoutNode[]> {
    const ref = await this.resolveRef(rid);
    const result = await this.executeEc(buildLayoutTreeEc(ref));
    if (!result.ok || !result.log) return [];
    // Drop content nodes (children of leaf widgets — e.g. indicators inside an
    // IndicatorList) generically, the same taxonomy strip loadModel applies, so
    // the Inspect Layout view + AI read_layout show layout structure, not list
    // members. See stripWidgetContent in layout/model.ts.
    return stripWidgetContent(parseLayoutNodes(result.log));
  }

  /** Fetch direct children of an object via EC */
  async fetchChildren(rid: string): Promise<Array<{ rid: string; name?: string; type?: string; businessId?: string }>> {
    const ref = await this.resolveRef(rid);
    const childRow = buildRowEc(identityRow('_c', { ridDefault: '"SKIP"', order: ['rid', 'id', 'className', 'name'] }), '|||');
    const code = [
      `_o := ${ref}`,
      '_r := ""',
      '_o.children().forEach(_c:',
      `  _r := _r + ${childRow} + "\\n"`,
      ')',
      '_r',
    ].join('\n');
    const result = await this.executeEc(code, undefined, false);
    if (!result.ok || !result.log) return [];

    return parsePipeLines(result.log, 4).map(([cRid, bid, typ, ...rest]) => ({
      rid: cRid,
      businessId: bid || undefined,
      type: typ || undefined,
      name: rest.join('|||').trim() || undefined,
    }));
  }

  /** Fetch full editor context in a single EC call: identity, template, code props for both.
   *  Replaces separate lookupIdentity + resolveTemplate + 2× fetchCodeViaEc round-trips. */
  async fetchEditorContext(rid: string, extraProps: string[] = []): Promise<EditorContextData | null> {
    const ref = await this.resolveRef(rid);
    const sep = '<<<CREV_SEP>>>';
    // Standard code props + any caller-requested property (e.g. afterExpression,
    // showExpression, initExpression, defaultExpression). Without the extra, an
    // Edit on a non-standard field would fetch nothing for it and the editor
    // silently fell back to `expression`. Validated — names are interpolated
    // into EC below.
    const extras = extraProps.filter(p => {
      try { validateEcIdentifier(p); return true; } catch { return false; }
    });
    const codeProps = [...new Set(['expression', 'html', 'javascript', ...extras])];
    const lines = [
      `_sep := "${sep}"`,
      `_inst := ${ref}`,
      '_r := ""',
      `_r := _r + _sep + "instRid" + _sep + _inst.rid.whenMissing("MISSING") + "\\n"`,
      `_r := _r + _sep + "instId" + _sep + _inst.id.whenMissing("") + "\\n"`,
      `_r := _r + _sep + "instName" + _sep + _inst.name.whenMissing("") + "\\n"`,
      `_r := _r + _sep + "instType" + _sep + _inst.className.whenMissing("") + "\\n"`,
      ...ecResolveTemplate('_inst', '_tmpl'),
      `_r := _r + _sep + "tmplRid" + _sep + _tmpl.rid.whenMissing("MISSING") + "\\n"`,
      `_r := _r + _sep + "tmplId" + _sep + _tmpl.id.whenMissing("") + "\\n"`,
      `_r := _r + _sep + "tmplName" + _sep + _tmpl.name.whenMissing("") + "\\n"`,
      `_r := _r + _sep + "tmplType" + _sep + _tmpl.className.whenMissing("") + "\\n"`,
      '_loc := _inst.location',
      `_r := _r + _sep + "locRid" + _sep + _loc.rid.whenMissing("MISSING") + "\\n"`,
    ];
    for (const prop of codeProps) {
      lines.push(`_r := _r + _sep + "inst_${prop}" + _sep + output(_inst.${prop}.whenMissing("")) + "\\n"`);
      lines.push(`_r := _r + _sep + "tmpl_${prop}" + _sep + output(_tmpl.${prop}.whenMissing("")) + "\\n"`);
    }
    lines.push(`_r := _r + _sep + "DONE"`);
    lines.push('_r');

    const result = await this.executeEc(lines.join('\n'));
    if (!result.ok || !result.log) return null;

    const data = parseSepBlocks(result.log, sep);
    const instance = parseIdentityBlock(data, 'inst');
    if (!instance) return null;
    const template = parseIdentityBlock(data, 'tmpl');

    // Extract code props, filtering empty values
    const instanceCode: Record<string, string> = {};
    const templateCode: Record<string, string> = {};
    for (const prop of codeProps) {
      const instVal = data[`inst_${prop}`];
      const tmplVal = data[`tmpl_${prop}`];
      if (instVal) instanceCode[prop] = instVal;
      if (tmplVal) templateCode[prop] = tmplVal;
    }

    const locationRid = data.locRid && data.locRid !== 'MISSING' ? data.locRid : undefined;
    return { instance, template, instanceCode, templateCode, locationRid };
  }

  /** Single EC round trip that powers the sidepanel object pane.
   *  Returns identity + parent + template + allowlisted style props + siblings.
   *  Handles both model (.linkedTo) and enterprise (.template) objects. */
  async fetchObjectPane(rid: string, signal?: AbortSignal): Promise<ObjectPaneData | null> {
    const ref = await this.resolveRef(rid);
    const result = await this.executeEc(buildObjectPaneEc(ref, this.paneProps), undefined, false, signal);
    // Distinguish "EC failed" (throw — handler surfaces the message) from
    // "object truly not found" (return null — generic message is correct).
    if (!result.ok) throw new Error(result.error ?? result.log ?? 'EC fetch failed');
    if (!result.log) throw new Error('Empty EC response');

    const data = parseSepBlocks(result.log, FLOW_SEP);
    const instance = parseIdentityBlock(data, 'inst');
    if (!instance) return null;
    const parent = parseIdentityBlock(data, 'par');
    const template = parseIdentityBlock(data, 'tmpl');

    const cardBase = parseIdentityBlock(data, 'card');
    const card: ObjectPaneCard | null = cardBase ? {
      ...cardBase,
      // Instance had no own card → the effective card came from the template.
      // `.trim()` guards the load-bearing emptiness check: parseSepBlocks
      // strips only a trailing newline, not stray whitespace.
      viaTemplate: !data.instCardRid?.trim(),
    } : null;

    const instanceProps: Record<string, string> = {};
    const templateProps: Record<string, string> = {};
    for (const prop of this.paneProps) {
      instanceProps[prop] = data[`inst_${prop}`] ?? '';
      templateProps[prop] = data[`tmpl_${prop}`] ?? '';
    }

    const codeFields: Record<string, string> = {};
    for (const cf of ALL_CODE_FIELDS) {
      const v = data[`code_${cf}`];
      if (v) codeFields[cf] = v;
    }

    const references: Record<string, ObjectPaneRef | null> = {};
    for (const rf of ALL_REFERENCE_FIELDS) {
      const tRid = data[`ref_${rf}_rid`];
      if (tRid) {
        references[rf] = {
          rid: tRid,
          businessId: data[`ref_${rf}_id`] ?? '',
          name: data[`ref_${rf}_name`] ?? '',
          type: data[`ref_${rf}_type`] ?? '',
        };
      }
    }

    const indirectCode: Record<string, string> = {};
    const indirectCodeRids: Record<string, string> = {};
    for (const ind of ALL_INDIRECT_FIELDS) {
      const key = `${ind.prop}_${ind.targetProp}`;
      const v = data[`ind_${key}`];
      if (v) indirectCode[key] = v;
      const targetRid = data[`ind_${key}_rid`];
      if (targetRid) indirectCodeRids[key] = targetRid;
    }

    const contextValues: Record<string, string> = {};
    for (const ctx of ALL_CONTEXT_FIELDS) {
      if (ctx.kind === 'list-ref') continue;
      const v = data[`ctx_${ctx.prop}`];
      if (v != null && v !== '') contextValues[ctx.prop] = v;
    }

    const gateValues: Record<string, string> = {};
    for (const eb of ALL_ENABLED_BY_PROPS) {
      const v = data[`gate_${eb}`];
      if (v != null && v !== '') gateValues[eb] = v;
    }

    const lists: Record<string, ObjectPaneRef[]> = {};
    for (const ctx of ALL_CONTEXT_FIELDS) {
      if (ctx.kind !== 'list-ref') continue;
      const block = data[`list_${ctx.prop}`] ?? '';
      const items: ObjectPaneRef[] = [];
      for (const line of block.split('\n')) {
        const parts = line.split('|');
        if (parts.length < 4) continue;
        const [lRid, lId, lName, lType] = parts;
        if (!lRid) continue;
        items.push({ rid: lRid, businessId: lId ?? '', name: lName ?? '', type: lType ?? '' });
      }
      if (items.length > 0) lists[ctx.prop] = items;
    }

    const siblings: ObjectPaneSibling[] = [];
    const sibBlock = data.siblings ?? '';
    for (const line of sibBlock.split('\n')) {
      const parts = line.split('|');
      if (parts.length < 5) continue;
      const [sRid, sId, sName, sType, sCur] = parts;
      if (!sRid) continue;
      siblings.push({
        rid: sRid,
        businessId: sId ?? '',
        name: sName ?? '',
        type: sType ?? '',
        isCurrent: sCur === '1',
      });
    }

    // True child count from the EC (counts all children, not the capped slice).
    // Fall back to the emitted row count if the field is absent/garbled.
    const parsedTotal = Number((data.sibTotal ?? '').trim());
    const siblingTotal = Number.isFinite(parsedTotal) && parsedTotal >= siblings.length
      ? parsedTotal
      : siblings.length;

    return {
      instance, parent, template, card,
      instanceProps, templateProps, siblings, siblingTotal,
      codeFields, references,
      indirectCode, indirectCodeRids, contextValues, gateValues, lists,
    };
  }

  // ── Flow chain (InputView / InputSet / ActionButton / TransportGroup / Label) ──

  /** Build the Flow chain for an InputView / ActionButton / Label.
   *  One EC call walks the right reference chain and returns a tree of steps.
   *
   *  - InputView: → inputSet → children (Label, *Input, ButtonInput) with each
   *    child's key + relevant EC content. ButtonInput.afterExpression gets
   *    grepped against sibling keys for the cross-reference chips.
   *  - ActionButton: if buttonType='expression', single step with the
   *    expression. Else walk actionObject → its EC-bearing children (1 level).
   *  - Label: single step with defaultExpression / expression content.
   *
   *  Returns null for types that don't have a flow.
   */
  async fetchFlowChain(rid: string, type: string, signal?: AbortSignal): Promise<FlowChain | null> {
    if (type === 'InputView') return this.fetchInputViewFlow(rid, signal);
    if (type === 'InputSet') return this.fetchInputSetFlow(rid, signal);
    if (type === 'ActionButton') return this.fetchActionButtonFlow(rid, signal);
    if (type === 'NotificationTransportGroup') return this.fetchTransportGroupFlow(rid, signal);
    if (type === 'Label') return this.fetchLabelFlow(rid, signal);
    // EditPage and CreateObjectView are containers for Add-Object forms — they
    // hold InputSet(s) + ButtonInput. Walking the children directly via the
    // InputSet walker covers the common case (one InputSet per EditPage).
    if (type === 'EditPage' || type === 'CreateObjectView') return this.fetchPageFormFlow(rid, type, signal);
    return null;
  }

  /** Run a flow-walker EC round-trip and return the parsed sep-blocks. Throws
   *  on a bridge / EC failure so the caller surfaces a real error state — a
   *  failure must NOT be swallowed into `null` and shown as "no flow chain"
   *  (the bug that made InputView/InputSet/etc. silently mask EC errors). */
  private async runFlowEc(ec: string, signal?: AbortSignal): Promise<Record<string, string>> {
    const result = await this.executeEc(ec, undefined, false, signal);
    if (!result.ok) throw new Error(result.error ?? result.log ?? 'EC flow fetch failed');
    if (!result.log) throw new Error('Empty EC response');
    return parseSepBlocks(result.log, FLOW_SEP);
  }

  /** Walk an EditPage / CreateObjectView for its Add-Object form chain.
   *  Strategy: scan immediate children, pick the first InputSet (typical
   *  shape), then walk it via the existing InputSet flow. ButtonInput
   *  siblings of the InputSet get added as standalone steps at depth 0. */
  private async fetchPageFormFlow(rid: string, type: string, signal?: AbortSignal): Promise<FlowChain | null> {
    try {
      const ref = await this.resolveRef(rid);
      // Pull the page identity + a list of (childRid, childType) — we
      // don't need much, just enough to find the InputSet child.
      const sep = '<<<CREV_SEP>>>';
      const ec = [
        '_p := ' + ref,
        '_r := ""',
        `_r := _r + "${sep}page${sep}" + _p.rid.whenMissing("") + "|" + _p.id.whenMissing("") + "|" + _p.name.whenMissing("") + "|" + _p.className.whenMissing("") + "\\n"`,
        '_p.children().forEach(_c:',
        `  _r := _r + "${sep}child${sep}" + _c.rid.whenMissing("") + "|" + _c.id.whenMissing("") + "|" + _c.name.whenMissing("") + "|" + _c.className.whenMissing("") + "\\n"`,
        ')',
        '_r',
      ].join('\n');
      const result = await this.executeEc(ec, undefined, false, signal);
      if (!result.ok || !result.log) return null;
      const data = parseSepBlocks(result.log, sep);

      const pageRow = parsePipeRow(data.page);
      if (!pageRow) return null;
      const pageStep: FlowStep = { identity: pageRow, children: [] };

      const childRows = (data.child ?? '').split('\n')
        .map(parsePipeRow)
        .filter((r): r is { rid: string; businessId: string; name: string; type: string } => r !== null);

      // Walk the first InputSet child via the dedicated InputSet flow walker;
      // attach its result as a sub-step. Other children (ButtonInput etc.) are
      // added as bare steps so the user sees the whole form layout.
      for (const c of childRows) {
        if (c.type === 'InputSet') {
          const sub = await this.fetchInputSetFlow(c.rid, signal);
          if (sub && sub.steps.length > 0) {
            const isStep = sub.steps[0];
            isStep.edgeLabel = type === 'CreateObjectView' ? 'editPage › inputSet' : 'inputSet';
            pageStep.children!.push(isStep);
            continue;
          }
        }
        pageStep.children!.push({ identity: c });
      }

      return { steps: [pageStep] };
    } catch {
      return null;
    }
  }

  private async fetchInputViewFlow(rid: string, signal?: AbortSignal): Promise<FlowChain | null> {
    const ref = await this.resolveRef(rid);
    const data = await this.runFlowEc(buildInputViewFlowEc(ref), signal);

    const iv = parsePipeRow(data.iv);
    if (!iv) return null;
    const ivStep: FlowStep = { identity: iv };

    const isRow = parsePipeRow(data.is);
    if (!isRow) return { steps: [ivStep] };
    const isStep: FlowStep = { identity: isRow, edgeLabel: 'inputSet', children: [] };
    ivStep.children = [isStep];
    populateInputSetChildren(data, isStep);

    return { steps: [ivStep] };
  }

  /** Walk just an InputSet → its children. Used when the user clicks the
   *  cascade pill on an InputView (which navigates directly to the InputSet
   *  in the sidebar) so they immediately see the form fields + their EC. */
  private async fetchInputSetFlow(rid: string, signal?: AbortSignal): Promise<FlowChain | null> {
    const ref = await this.resolveRef(rid);
    const data = await this.runFlowEc(buildInputSetFlowEc(ref), signal);

    const isRow = parsePipeRow(data.is);
    if (!isRow) return null;
    const isStep: FlowStep = { identity: isRow, children: [] };
    populateInputSetChildren(data, isStep);

    return { steps: [isStep] };
  }

  /** Walk a NotificationTransportGroup → its ExtendedTransport children.
   *  Used when the user clicks the cascade pill on an ActionButton (which
   *  jumps directly to the group) so they immediately see each transport's
   *  EC without re-drilling through the button. */
  private async fetchTransportGroupFlow(rid: string, signal?: AbortSignal): Promise<FlowChain | null> {
    const ref = await this.resolveRef(rid);
    const data = await this.runFlowEc(buildTransportGroupFlowEc(ref), signal);

    const grpRow = parsePipeRow(data.grp);
    if (!grpRow) return null;
    const grpStep: FlowStep = { identity: grpRow, children: [] };

    const childRows = (data.children ?? '').split('\n').map(line => {
      const cols = splitNamedRow(line, 2, 1);
      if (!cols) return null;
      const [crid, businessId, name, type] = cols;
      return { rid: crid, businessId, name, type };
    }).filter((r): r is { rid: string; businessId: string; name: string; type: string } => r !== null);

    for (const c of childRows) {
      const child: FlowStep = { identity: c };
      const code = buildTransportCodeFields(data, c.rid, 'child');
      if (code.length > 0) child.codeFields = code;
      grpStep.children!.push(child);
    }

    return { steps: [grpStep] };
  }

  private async fetchActionButtonFlow(rid: string, signal?: AbortSignal): Promise<FlowChain | null> {
    const ref = await this.resolveRef(rid);
    const data = await this.runFlowEc(buildActionButtonFlowEc(ref), signal);

    const abRow = parseAbRow(data.ab);
    if (!abRow) return null;
    // Live BMP returns actionType as `"ActionType.action"` etc. — normalize
    // before comparing against the Java enum constants ACTION/ADD/EDIT/NAVIGATE.
    const actionType = normalizeBmpEnum(abRow.actionType);
    const abStep: FlowStep = { identity: abRow.identity };

    // Collect EC strings present on the button itself.
    const localCode: FlowCodeField[] = [];
    if (data.ab_expression) localCode.push(makeCodeField('expression', data.ab_expression, []));
    if (data.ab_initExpression) localCode.push(makeCodeField('initExpression', data.ab_initExpression, []));
    if (data.ab_afterExpression) localCode.push(makeCodeField('afterExpression', data.ab_afterExpression, []));
    // showExpression / enableExpression / validateExpression are indirect
    // (Reference → ExtendedExpression): the content derefs through `.expression`
    // and Edit must redirect to the TARGET's `.expression`, not the AB's
    // Reference handle (else the editor silently falls back to `expression`).
    const pushIndirect = (prop: string, text?: string, targetRid?: string): void => {
      if (!text) return;
      const f = makeCodeField(prop, text, []);
      f.firstLine = `via ${prop} → expression: ${f.firstLine}`;
      if (targetRid) {
        f.targetRid = targetRid;
        f.targetProp = 'expression';
      }
      localCode.push(f);
    };
    pushIndirect('showExpression', data.ab_showExpression, data.ab_showExpression_rid);
    pushIndirect('enableExpression', data.ab_enableExpression, data.ab_enableExpression_rid);
    pushIndirect('validateExpression', data.ab_validateExpression, data.ab_validateExpression_rid);
    // editExpression / refreshExpression are direct expression fields.
    if (data.ab_editExpression) localCode.push(makeCodeField('editExpression', data.ab_editExpression, []));
    if (data.ab_refreshExpression) localCode.push(makeCodeField('refreshExpression', data.ab_refreshExpression, []));
    if (localCode.length > 0) abStep.codeFields = localCode;

    const actRow = parsePipeRow(data.act);
    if (!actRow) {
      // No actionObject. Whether that's a problem depends on actionType:
      //   ADD / NAVIGATE → expression carries the action; no actionObject expected.
      //   ACTION / EDIT / (empty) → without actionObject the button does nothing.
      const expressionDriven = actionType === 'ADD' || actionType === 'NAVIGATE';
      if (!expressionDriven && !data.ab_expression) {
        abStep.hint = `No action set (actionType=${actionType || 'unset'})`;
      }
      return { steps: [abStep] };
    }

    const edgeLabel = actionType === 'ACTION' ? 'actionObject (transport group)' : 'actionObject';
    const actStep: FlowStep = { identity: actRow, edgeLabel, children: [] };
    abStep.children = [actStep];

    const childRows = (data.actchildren ?? '').split('\n').map(s => {
      const cols = splitNamedRow(s, 2, 1);
      if (!cols) return null;
      const [crid, businessId, name, type] = cols;
      return { rid: crid, businessId, name, type } as FlowIdentity;
    }).filter((r): r is FlowIdentity => r !== null);
    for (const c of childRows) {
      const child: FlowStep = { identity: c };
      const code = buildTransportCodeFields(data, c.rid, 'actchild');
      if (code.length > 0) child.codeFields = code;
      actStep.children!.push(child);
    }

    return { steps: [abStep] };
  }

  private async fetchLabelFlow(rid: string, signal?: AbortSignal): Promise<FlowChain | null> {
    const ref = await this.resolveRef(rid);
    const data = await this.runFlowEc(buildLabelFlowEc(ref), signal);

    const lblRow = parsePipeRow(data.lbl);
    if (!lblRow) return null;
    const step: FlowStep = { identity: lblRow };
    const code: FlowCodeField[] = [];
    if (data.lbl_defaultExpression) code.push(makeCodeField('defaultExpression', data.lbl_defaultExpression, []));
    if (data.lbl_expression) code.push(makeCodeField('expression', data.lbl_expression, []));
    if (code.length > 0) step.codeFields = code;
    return { steps: [step] };
  }

  // ── Colour sets ────────────────────────────────────────────────

  /** Enumerate the workspace's colour sets + colours (for the link picker).
   *  Walks t.ColorRoot → CorpoColorSet → CorpoColor; each colour carries its
   *  bid (for linking via `t.<bid>`), name, and rgb (parsed from java.awt.Color). */
  async fetchColorSets(): Promise<ColorSetData[]> {
    const sep = '<<<CREV_COL>>>';
    // SELECT finds every CorpoColorSet ANYWHERE in the portal tree — workspaces routinely keep
    // custom sets in their own Categories (Steadfast: swi_default_colors, cat_q_portal), which the
    // old `t.ColorRoot.children()` walk never saw (it also missed nesting; ColorRoot itself is a
    // portal Category, so the stock sets come through this same query — no second source needed).
    // Live-compared 2026-07-03 on Steadfast: SELECT = 25 sets in 6ms vs 12 sets for ColorRoot and
    // 171ms for a filtered portal-descendants walk. The set's parent Category id rides on the S
    // line so custom sets can lead the pickers. Per-node lines build in the small local `_l`
    // (one `_r` touch per set — the EC accumulator rule).
    const ec = [
      '_c := SELECT CorpoColorSet FROM root.portal',
      '_r := ""',
      '_c.forEach(_set:',
      `  _l := "${sep}S${sep}" + _set.id.whenMissing("") + "${sep}" + _set.name.whenMissing("") + "${sep}" + _set.parent.id.whenMissing("") + "\\n"`,
      '  _set.children().forEach(_col:',
      // Concatenate _col.color (java.awt.Color → toString) — NOT output(),
      // which is for expression *text* and is ~600× slower here (8.8s vs ~50ms
      // for ~100 colours). Guard on MISSING so non-colour children are skipped
      // and the accumulator stays a text value.
      '    _cv := _col.color',
      '    IF _cv != MISSING THEN',
      `      _l := _l + "${sep}C${sep}" + _col.id.whenMissing("") + "${sep}" + _col.name.whenMissing("") + "${sep}" + _cv + "\\n"`,
      '    ENDIF',
      '  )',
      '  _r := _r + _l',
      ')',
      '_r',
    ].join('\n');
    const result = await this.executeEc(ec);
    if (!result.ok || !result.log) return [];
    const sets: ColorSetData[] = [];
    let cur: ColorSetData | null = null;
    for (const line of result.log.split('\n')) {
      const parts = line.split(sep);
      if (parts[1] === 'S') {
        cur = { id: (parts[2] ?? '').trim(), name: (parts[3] ?? '').trim(), colors: [] };
        const folder = (parts[4] ?? '').trim();
        if (folder) cur.folder = folder;
        sets.push(cur);
      } else if (parts[1] === 'C' && cur) {
        const bid = (parts[2] ?? '').trim();
        const rgb = parseAwtColor(parts[4] ?? '');
        if (bid && rgb) cur.colors.push({ bid, name: (parts[3] ?? '').trim(), rgb });
      }
    }
    // Workspace-custom sets first (any Category other than the stock ColorRoot), stock palette
    // after — in the pickers you almost always want the workspace's own colours. Stable within
    // each group (server order).
    const custom = (s: ColorSetData): number => (s.folder && s.folder !== 'ColorRoot' ? 0 : 1);
    return sets.filter(s => s.colors.length > 0).sort((a, b) => custom(a) - custom(b));
  }
}
