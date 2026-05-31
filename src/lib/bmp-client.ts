/**
 * BMP client facade — composes BmpAuth + BmpTransport.
 * Public API unchanged for all consumers.
 */

import {
  registerBmpTypes,
  makeUpdateCommand,
  makeExtendedExecuteCommand,
  makeTreeItemCommand,
  parseEcResults,
  parseTreeNodeInfo,
} from './bmp-types';
import { deserializeStream } from './java-serial';
import { log } from './logger';
import { HEALTH_TIMEOUT, BATCH_CHUNK_SIZE, MAX_PARALLEL } from './constants';
import { BmpAuth } from './bmp-auth';
import { BmpTransport } from './bmp-transport';
import { pMap, compareVersions } from './util';
import { parsePipeLines, parseSepBlocks, parseSepMultiObject } from './ec-parser';
import { validateRid, validateEcIdentifier } from './ec-guards';
import { resolveNamespace } from './namespace';
import {
  parsePipeRow, parsePipeRowWithKey, parseAbRow, makeCodeField,
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

// Ensure BMP types are registered once
registerBmpTypes();

/** Validate that a RID is a numeric string (positive or negative). Prevents EC injection. */
// Identifier / RID guards live in ec-guards.ts so ec-codegen can apply
// them at every interpolation slot too (defence-in-depth for the walker
// EC, not just the save paths).

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

export interface ConnectionResult {
  ok: boolean;
  message: string;
  authenticated: boolean;
}

export interface EcResult {
  ok: boolean;
  log?: string;
  hasError?: boolean;
  hasWarning?: boolean;
  error?: string;
}

export interface TemplateResolution {
  templateRid: string | null;
  templateName?: string;
  templateType?: string;
  templateBusinessId?: string;
}

/** Structured editor context returned by fetchEditorContext() — single EC call. */
export interface EditorContextData {
  instance: { rid: string; businessId: string; type: string; name: string };
  template: { rid: string; businessId: string; type: string; name: string } | null;
  instanceCode: Record<string, string>;
  templateCode: Record<string, string>;
  locationRid?: string;
}

/** Object pane data: identity + parent + template + style props + siblings.
 *  Used by the sidepanel DetailView's split-pane editor. */
export interface ObjectPaneSibling {
  rid: string;
  businessId: string;
  name: string;
  type: string;
  isCurrent: boolean;
}

export interface ObjectPaneRef {
  rid: string;
  businessId: string;
  name: string;
  type: string;
}

export interface ObjectPaneData {
  instance: { rid: string; businessId: string; type: string; name: string };
  parent: { rid: string; businessId: string; type: string; name: string } | null;
  template: { rid: string; businessId: string; type: string; name: string } | null;
  /** Property values keyed by name. Empty string means "not set" on server. */
  instanceProps: Record<string, string>;
  templateProps: Record<string, string>;
  /** Siblings under the same parent — empty if parent is null. */
  siblings: ObjectPaneSibling[];
  /** Code field full content keyed by property (only non-empty entries). */
  codeFields: Record<string, string>;
  /** Reference edges keyed by property → target identity (or null if unset). */
  references: Record<string, ObjectPaneRef | null>;
  /** Indirect code reached via ref→target; key is `<prop>_<targetProp>`. */
  indirectCode: Record<string, string>;
  /** RID of the reference target for each indirectCode entry. Keyed by the
   *  same `<prop>_<targetProp>` so the Edit button can target the right
   *  object instead of trying to edit the Reference handle itself. */
  indirectCodeRids: Record<string, string>;
  /** Enum / boolean values that shape interpretation (actionType, persistence…). */
  contextValues: Record<string, string>;
  /** Boolean gates referenced by `enabledBy` on a code field. */
  gateValues: Record<string, string>;
  /** List-typed refs (e.g. addableItems). */
  lists: Record<string, ObjectPaneRef[]>;
}

// Flow walker types + parsing helpers live in lib/flow-parser.ts.
// Re-export the types we hand back from fetchFlowChain so callers don't
// need a second import.
export type { FlowChain, FlowStep, FlowCodeField, FlowIdentity } from './flow-parser';

/** Properties surfaced by the object pane. Allowlisted to prevent EC injection
 *  via attacker-controlled keys and to gate UI editors per property type. */
export const PANE_PROPS = [
  'width', 'height',
  // Responsive width — verified live via bmp_type_fields on Scorecard subtypes;
  // ResponsiveWidth mixin attaches these to layout-bearing widgets. 0-6 each,
  // 0 == 6 (full width).
  'columnsLargeScreen', 'columnsMediumScreen', 'columnsSmallScreen',
  // Display-level toggles attached by HasToolsMenu / HasDisableSearch mixins.
  'showToolMenu', 'disableSearch',
  'headerColor', 'bgColor', 'fontColor',
  'shadow', 'transparency',
  'headerStyle', 'borderStyle',
  // Visibility — Visibillity mixin (`visible`) + ScreenSizeVisibility mixin
  // (per-breakpoint booleans). The legacy `hidden` field doesn't exist on
  // current BMP types; we read/write `visible` instead.
  'visible',
  'shownOnLargeDisplay', 'shownOnMediumDisplay', 'shownOnSmallDisplay',
  // HasColumnWidths mixin — list-bearing widgets (ExtendedTable,
  // IndicatorList, IssueList, RiskList, TaskList, …). Read-only in
  // the pane; the value is a `ColumnWidths` object that EC stringifies
  // to a readable summary. Editing is deferred — the constructor takes
  // a structured per-column map that we don't yet have a UI for.
  'columnWidths',
] as const;
export type PaneProp = typeof PANE_PROPS[number];
export const PANE_PROPS_SET: ReadonlySet<string> = new Set(PANE_PROPS);

// ALL_CODE_FIELDS / ALL_REFERENCE_FIELDS live in widget-metadata.ts where
// they're derived from TYPE_META at module load (single source of truth).

/** Lightweight cache interface — avoids coupling to ObjectCache. */
export interface IdentityCache {
  get(rid: string): { businessId?: string; type?: string } | undefined;
}

export class BmpClient {
  readonly auth: BmpAuth;
  private transport: BmpTransport;
  private _cache: IdentityCache | null = null;

  /** Whether server supports EC lookup(). null = unknown (not yet detected).
   *  Set by applyVersionFlags() after version detection. */
  supportsLookup: boolean | null = null;

  constructor(
    private bmpUrl: string,
    bmpUser: string,
    bmpPass: string,
    profileId?: string,
  ) {
    this.auth = new BmpAuth(bmpUrl, bmpUser, bmpPass, profileId);
    this.transport = new BmpTransport(bmpUrl, this.auth);
  }

  get jwt(): string | null { return this.auth.jwt; }
  get serverUrl(): string { return this.bmpUrl; }
  get username(): string { return this.auth.username; }
  updateCredentials(user: string, pass: string): void {
    this.auth.updateCredentials(user, pass);
  }

  /** Inject enrichment cache for resolveRef lookups. */
  set cache(c: IdentityCache) { this._cache = c; }

  /** Apply version flags — called once when BMP version is detected. */
  applyVersionFlags(version: string) {
    const v = version.replace(/^v\.?/i, '');
    const isOld = compareVersions(v, '5.6.3.0') < 0;
    this.transport.useTicketAuth = isOld;
    this.supportsLookup = !isOld;
  }

  /** Safe fallback when version detection fails — assume old BMP.
   *  Binary mode with ticket auth works on all BMP versions. */
  assumeOldBmp() {
    this.transport.useTicketAuth = true;
    this.supportsLookup = false;
  }

  // ── Auth delegation ──────────────────────────────────────────

  async testConnection(): Promise<ConnectionResult> {
    try {
      await this.auth.login();
      return { ok: true, message: 'Authenticated', authenticated: true };
    } catch (e) {
      return { ok: false, message: this.transport.formatError(e), authenticated: false };
    }
  }

  absorbAuth(other: BmpClient) { this.auth.absorbAuth(other.auth); }
  logout() { this.auth.logout(); }

  // ── Object resolution ────────────────────────────────────────

  /** Resolve a RID to an EC object reference expression.
   *  On 5.6.3+ (lookup available): returns "lookup(rid)".
   *  On pre-5.6.3: resolves business ID via cache or binary GetObject, returns "t.{bid}". */
  async resolveRef(rid: string): Promise<string> {
    validateRid(rid);
    if (this.supportsLookup !== false) return `lookup(${rid})`;

    // Try enrichment cache first
    const cached = this._cache?.get(rid);
    if (cached?.businessId) return `${resolveNamespace(cached.type ?? '')}.${cached.businessId}`;

    // Binary GetObject fallback
    const identity = await this.getObjectIdentity(rid);
    if (!identity?.businessId) throw new Error(`Cannot resolve object ${rid}: not found on server`);
    return `${resolveNamespace(identity.type ?? '')}.${identity.businessId}`;
  }

  /** Send a TreeItemCommand and extract the TreeNodeInformationDto from the response.
   *  Response format: ArrayList<IntegrationObjectResponse> where .response = TreeNodeInformationDto. */
  private async fetchTreeItem(rid: string, signal?: AbortSignal): Promise<ReturnType<typeof parseTreeNodeInfo>> {
    const cmd = makeTreeItemCommand(rid);
    const buffer = await this.transport.sendCommands([cmd], signal);
    const objects = deserializeStream(buffer);
    for (const obj of objects) {
      const cls = obj?.$class ?? '';
      if (cls.includes('ServerExceptionResponse')) continue;
      if (cls === 'java.util.ArrayList') {
        const dto = obj.$elements?.[0]?.response;
        if (dto?.$class?.includes('TreeNodeInformationDto')) {
          return parseTreeNodeInfo(dto);
        }
      }
    }
    return null;
  }

  /** Fetch identity (rid, businessId, type, name) via TreeItemCommand.
   *  Lighter than GetObjectCommand — avoids NullPointerException on old BMP. */
  private async getObjectIdentity(rid: string): Promise<{ rid: string; businessId?: string; type?: string; name?: string } | null> {
    try { return await this.fetchTreeItem(rid); }
    catch { return null; }
  }

  // ── Object operations ────────────────────────────────────────

  /** Save a single property back to BMP (binary serializer) */
  async saveProperty(rid: string, objectType: string, property: string, value: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const cmd = makeUpdateCommand(rid, objectType, { [property]: value });
      const buffer = await this.transport.sendCommands([cmd]);
      const raw = this.transport.deserializeResponse(buffer);

      if (raw?.$class?.includes('ServerExceptionResponse')) {
        return { ok: false, error: raw.message ?? 'Server error' };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: this.transport.formatError(e) };
    }
  }

  // ── EC operations ────────────────────────────────────────────

  /** Execute Extended Code */
  async executeEc(code: string, objectRid?: string, transactional = false, signal?: AbortSignal): Promise<EcResult> {
    try {
      const cmd = makeExtendedExecuteCommand(code, {
        objectRid: objectRid ? BigInt(objectRid) : undefined,
        transactional,
      });
      const objects = await this.transport.sendStreamingCommand(cmd, signal);
      return parseEcResults(objects);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') {
        return { ok: false, error: 'EC execution timed out (30s)' };
      }
      return { ok: false, error: this.transport.formatError(e) };
    }
  }

  /** Resolve template for a linked instance (pure EC) */
  async resolveTemplate(rid: string): Promise<TemplateResolution> {
    const ref = await this.resolveRef(rid);
    const code = [
      `_o := ${ref}`,
      '_t := _o.linkedTo',
      // Enterprise objects (CeIssue, CeRiskAssessment, etc.) use .template instead of .linkedTo
      'IF _t = MISSING THEN',
      '  _t := _o.template',
      'ENDIF',
      '_t.rid.whenMissing("MISSING") + "|||" + _t.name.whenMissing("") + "|||" + _t.className.whenMissing("") + "|||" + _t.id.whenMissing("")',
    ].join('\n');
    const ecResult = await this.executeEc(code, undefined, false);
    if (!ecResult.ok || !ecResult.log) return { templateRid: null };

    // Find the output line (contains |||) — skip "Result : 0", "Duration" etc.
    const lines = ecResult.log.trim().split('\n');
    const match = lines.find(l => l.includes('|||'))?.trim();
    if (!match || match.startsWith('MISSING')) return { templateRid: null };

    const parts = match.split('|||');
    const tRid = parts[0]?.trim();
    const tName = parts[1]?.trim();
    const tType = parts[2]?.trim();
    const tBid = parts[3]?.trim();
    if (!tRid || tRid === 'MISSING') return { templateRid: null };
    return {
      templateRid: tRid,
      templateName: tName || undefined,
      templateType: tType || undefined,
      templateBusinessId: tBid || undefined,
    };
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
      lines.push('  _t := _o.linkedTo');
      // Enterprise objects use .template instead of .linkedTo
      lines.push('  IF _t = MISSING THEN');
      lines.push('    _t := _o.template');
      lines.push('  ENDIF');
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
      lines.push(`  _r := _r + "${rid}" + _d + _o.id.whenMissing("") + _d + _cls.whenMissing("") + _d + _o.name.whenMissing("") + _d + _tid + _d + _cRid + _d + _cBid + _d + _cType + _d + _cName + "\\n"`);
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

  /** Lightweight identity fetch for a single RID (version-aware) */
  async lookupIdentity(rid: string): Promise<{ name?: string; type?: string; businessId?: string; templateBusinessId?: string } | null> {
    const { results } = await this.batchEnrich([rid]);
    return results[rid] ?? null;
  }

  /** Fetch code properties via EC */
  async fetchCodeViaEc(rid: string, properties: string[]): Promise<Record<string, string>> {
    if (properties.length === 0) return {};
    const sep = '<<<CREV_SEP>>>';
    const ref = await this.resolveRef(rid);
    const lines = [`_o := ${ref}`, '_r := ""'];
    for (const prop of properties) {
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

  /** Reposition an object relative to a sibling. BMP exposes
   *  `.moveBefore(other)` / `.moveAfter(other)` on every Node; this
   *  wraps both with a single EC round-trip. Used by the Page tab's
   *  drag-to-reorder for Tabs in a TabSet. */
  async moveObject(rid: string, relTo: string, position: 'above' | 'below'): Promise<{ ok: boolean; error?: string }> {
    const subj = await this.resolveRef(rid);
    const dest = await this.resolveRef(relTo);
    const method = position === 'above' ? 'moveBefore' : 'moveAfter';
    const code = `${subj}.${method}(${dest})`;
    const result = await this.executeEc(code, undefined, /* transactional */ true);
    return { ok: result.ok, error: result.error };
  }

  /** Walk the layout subtree of a Scorecard / TabSet / Tab / Container.
   *  Returns flat nodes with parent linkage + responsive sizing — the
   *  panel folds these into a tree client-side. Single round trip via
   *  EC `.descendants()` so even deep nests cost one server call.
   *
   *  Returned types: Tab, TabSet, Container, plus widget objects bound to
   *  any container in the subtree (rendered as leaves with their cell
   *  reference). */
  async fetchLayoutTree(rid: string): Promise<Array<{
    rid: string; parentRid?: string; containerRid?: string;
    businessId?: string; name?: string; type: string;
    columnsLargeScreen?: number; columnsMediumScreen?: number; columnsSmallScreen?: number;
  }>> {
    const ref = await this.resolveRef(rid);
    const sep = '<<<CREV_LAYOUT>>>';
    // Fields: rid|bid|name|type|parentRid|containerRid|L|M|S
    // Empty L/M/S indicate "this type doesn't carry the prop" (TabSet,
    // widgets without responsive sizing) — we render those without a
    // size pill in the UI.
    const ec = `
_root := ${ref}
_r := ""
_root.descendants().forEach(_n:
     _p := _n.parent
     _c := _n.container
     _r := _r + "${sep}" + _n.rid + "|" + _n.id.whenMissing("") + "|" + _n.name.whenMissing("") + "|" + _n.className.whenMissing("") + "|" + _p.rid.whenMissing("") + "|" + _c.rid.whenMissing("") + "|" + _n.columnsLargeScreen.whenMissing("") + "|" + _n.columnsMediumScreen.whenMissing("") + "|" + _n.columnsSmallScreen.whenMissing("") + "\\n"
)
_r := _r + "${sep}" + _root.rid + "|" + _root.id.whenMissing("") + "|" + _root.name.whenMissing("") + "|" + _root.className.whenMissing("") + "||||" + _root.columnsLargeScreen.whenMissing("") + "|" + _root.columnsMediumScreen.whenMissing("") + "|" + _root.columnsSmallScreen.whenMissing("") + "\\n"
_r
`.trim();
    const result = await this.executeEc(ec);
    if (!result.ok || !result.log) return [];
    const nodes: Array<{
      rid: string; parentRid?: string; containerRid?: string;
      businessId?: string; name?: string; type: string;
      columnsLargeScreen?: number; columnsMediumScreen?: number; columnsSmallScreen?: number;
    }> = [];
    const seen = new Set<string>();
    for (const block of result.log.split(sep)) {
      const line = block.split('\n', 1)[0].trim();
      if (!line) continue;
      const parts = line.split('|');
      if (parts.length < 9) continue;
      const [nodeRid, bid, name, type, parentRid, containerRid, l, m, s] = parts;
      if (!nodeRid || seen.has(nodeRid)) continue;
      seen.add(nodeRid);
      const numOrUndef = (v: string) => v && /^-?\d+$/.test(v) ? parseInt(v, 10) : undefined;
      nodes.push({
        rid: nodeRid,
        businessId: bid || undefined,
        name: name || undefined,
        type: type || 'Unknown',
        parentRid: parentRid || undefined,
        containerRid: containerRid || undefined,
        columnsLargeScreen: numOrUndef(l),
        columnsMediumScreen: numOrUndef(m),
        columnsSmallScreen: numOrUndef(s),
      });
    }
    return nodes;
  }

  /** Fetch direct children of an object via EC */
  async fetchChildren(rid: string): Promise<Array<{ rid: string; name?: string; type?: string; businessId?: string }>> {
    const ref = await this.resolveRef(rid);
    const code = [
      `_o := ${ref}`,
      '_r := ""',
      '_o.children().forEach(_c:',
      '  _r := _r + _c.rid.whenMissing("SKIP") + "|||" + _c.id.whenMissing("") + "|||" + _c.className.whenMissing("") + "|||" + _c.name.whenMissing("") + "\\n"',
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
  async fetchEditorContext(rid: string): Promise<EditorContextData | null> {
    const ref = await this.resolveRef(rid);
    const sep = '<<<CREV_SEP>>>';
    // Fetch all possible code properties — empty ones filtered out after parsing.
    const codeProps = ['expression', 'html', 'javascript'];
    const lines = [
      `_sep := "${sep}"`,
      `_inst := ${ref}`,
      '_r := ""',
      `_r := _r + _sep + "instRid" + _sep + _inst.rid.whenMissing("MISSING") + "\\n"`,
      `_r := _r + _sep + "instId" + _sep + _inst.id.whenMissing("") + "\\n"`,
      `_r := _r + _sep + "instName" + _sep + _inst.name.whenMissing("") + "\\n"`,
      `_r := _r + _sep + "instType" + _sep + _inst.className.whenMissing("") + "\\n"`,
      '_tmpl := _inst.linkedTo',
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
    if (!data.instRid || data.instRid === 'MISSING') return null;

    const instance = {
      rid: data.instRid,
      businessId: data.instId ?? '',
      type: data.instType ?? '',
      name: data.instName ?? '',
    };

    const hasTemplate = !!data.tmplRid && data.tmplRid !== 'MISSING';
    const template = hasTemplate ? {
      rid: data.tmplRid!,
      businessId: data.tmplId ?? '',
      type: data.tmplType ?? '',
      name: data.tmplName ?? '',
    } : null;

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

  /** Save a code property via EC */
  async saveCodeViaEc(rid: string, property: string, code: string): Promise<{ ok: boolean; error?: string }> {
    validateEcIdentifier(property);
    const escaped = code
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n');
    const ref = await this.resolveRef(rid);
    const ec = `_o := ${ref}\n_o.change(${property} := "${escaped}")`;
    const result = await this.executeEc(ec, undefined, true);
    if (!result.ok) {
      return { ok: false, error: result.error ?? result.log ?? 'EC save failed' };
    }
    return { ok: true };
  }

  /** Single EC round trip that powers the sidepanel object pane.
   *  Returns identity + parent + template + allowlisted style props + siblings.
   *  Handles both model (.linkedTo) and enterprise (.template) objects. */
  async fetchObjectPane(rid: string, signal?: AbortSignal): Promise<ObjectPaneData | null> {
    const ref = await this.resolveRef(rid);
    const result = await this.executeEc(buildObjectPaneEc(ref, PANE_PROPS), undefined, false, signal);
    // Distinguish "EC failed" (throw — handler surfaces the message) from
    // "object truly not found" (return null — generic message is correct).
    if (!result.ok) throw new Error(result.error ?? result.log ?? 'EC fetch failed');
    if (!result.log) throw new Error('Empty EC response');

    const data = parseSepBlocks(result.log, FLOW_SEP);
    if (!data.instRid || data.instRid === 'MISSING') return null;

    const instance = {
      rid: data.instRid,
      businessId: data.instId ?? '',
      type: data.instType ?? '',
      name: data.instName ?? '',
    };

    const parent = data.parRid && data.parRid !== 'MISSING' ? {
      rid: data.parRid,
      businessId: data.parId ?? '',
      type: data.parType ?? '',
      name: data.parName ?? '',
    } : null;

    const template = data.tmplRid && data.tmplRid !== 'MISSING' ? {
      rid: data.tmplRid,
      businessId: data.tmplId ?? '',
      type: data.tmplType ?? '',
      name: data.tmplName ?? '',
    } : null;

    const instanceProps: Record<string, string> = {};
    const templateProps: Record<string, string> = {};
    for (const prop of PANE_PROPS) {
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

    return {
      instance, parent, template,
      instanceProps, templateProps, siblings,
      codeFields, references,
      indirectCode, indirectCodeRids, contextValues, gateValues, lists,
    };
  }

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
    const result = await this.executeEc(buildInputViewFlowEc(ref), undefined, false, signal);
    if (!result.ok || !result.log) return null;
    const data = parseSepBlocks(result.log, FLOW_SEP);

    const iv = parsePipeRow(data.iv);
    if (!iv) return null;
    const ivStep: FlowStep = { identity: iv };

    const isRow = parsePipeRow(data.is);
    if (!isRow) return { steps: [ivStep] };
    const isStep: FlowStep = { identity: isRow, edgeLabel: 'inputSet', children: [] };
    ivStep.children = [isStep];

    // Collect children rows + their EC content
    const childRows = (data.children ?? '').split('\n')
      .map(parsePipeRowWithKey)
      .filter((r): r is { rid: string; businessId: string; name: string; type: string; key: string } => r !== null);
    const inputKeys: Array<{ key: string; sourceRid: string }> = [];
    for (const c of childRows) {
      if (c.key) inputKeys.push({ key: c.key, sourceRid: c.rid });
    }

    for (const c of childRows) {
      const child: FlowStep = {
        identity: { rid: c.rid, businessId: c.businessId, name: c.name, type: c.type },
      };
      if (c.key) child.inputKey = c.key;

      const code = buildChildCodeFields(data, c.rid, inputKeys);
      if (code.length > 0) child.codeFields = code;

      isStep.children!.push(child);
    }

    return { steps: [ivStep] };
  }

  /** Walk just an InputSet → its children. Used when the user clicks the
   *  cascade pill on an InputView (which navigates directly to the InputSet
   *  in the sidebar) so they immediately see the form fields + their EC. */
  private async fetchInputSetFlow(rid: string, signal?: AbortSignal): Promise<FlowChain | null> {
    const ref = await this.resolveRef(rid);
    const result = await this.executeEc(buildInputSetFlowEc(ref), undefined, false, signal);
    if (!result.ok || !result.log) return null;
    const data = parseSepBlocks(result.log, FLOW_SEP);

    const isRow = parsePipeRow(data.is);
    if (!isRow) return null;
    const isStep: FlowStep = { identity: isRow, children: [] };

    const childRows = (data.children ?? '').split('\n')
      .map(parsePipeRowWithKey)
      .filter((r): r is { rid: string; businessId: string; name: string; type: string; key: string } => r !== null);
    const inputKeys: Array<{ key: string; sourceRid: string }> = [];
    for (const c of childRows) {
      if (c.key) inputKeys.push({ key: c.key, sourceRid: c.rid });
    }

    for (const c of childRows) {
      const child: FlowStep = { identity: { rid: c.rid, businessId: c.businessId, name: c.name, type: c.type } };
      if (c.key) child.inputKey = c.key;
      const code = buildChildCodeFields(data, c.rid, inputKeys);
      if (code.length > 0) child.codeFields = code;
      isStep.children!.push(child);
    }

    return { steps: [isStep] };
  }

  /** Walk a NotificationTransportGroup → its ExtendedTransport children.
   *  Used when the user clicks the cascade pill on an ActionButton (which
   *  jumps directly to the group) so they immediately see each transport's
   *  EC without re-drilling through the button. */
  private async fetchTransportGroupFlow(rid: string, signal?: AbortSignal): Promise<FlowChain | null> {
    const ref = await this.resolveRef(rid);
    const result = await this.executeEc(buildTransportGroupFlowEc(ref), undefined, false, signal);
    if (!result.ok || !result.log) return null;
    const data = parseSepBlocks(result.log, FLOW_SEP);

    const grpRow = parsePipeRow(data.grp);
    if (!grpRow) return null;
    const grpStep: FlowStep = { identity: grpRow, children: [] };

    const childRows = (data.children ?? '').split('\n').map(line => {
      const trimmed = line.trim();
      if (!trimmed) return null;
      const parts = trimmed.split('|');
      if (parts.length < 4) return null;
      const [crid, businessId, name, type] = parts;
      if (!crid) return null;
      return { rid: crid, businessId: businessId ?? '', name: name ?? '', type: type ?? '' };
    }).filter((r): r is { rid: string; businessId: string; name: string; type: string } => r !== null);

    for (const c of childRows) {
      const child: FlowStep = { identity: c };
      const expr = data[`child_expression_${c.rid}`];
      if (expr) child.codeFields = [makeCodeField('expression', expr, [])];
      grpStep.children!.push(child);
    }

    return { steps: [grpStep] };
  }

  private async fetchActionButtonFlow(rid: string, signal?: AbortSignal): Promise<FlowChain | null> {
    const ref = await this.resolveRef(rid);
    const result = await this.executeEc(buildActionButtonFlowEc(ref), undefined, false, signal);
    if (!result.ok) throw new Error(result.error ?? result.log ?? 'EC flow fetch failed');
    if (!result.log) throw new Error('Empty EC response');
    const data = parseSepBlocks(result.log, FLOW_SEP);

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
    if (data.ab_showExpression) {
      const f = makeCodeField('showExpression', data.ab_showExpression, []);
      // Hint that this EC came via the ExtendedExpression reference indirection.
      f.firstLine = `via showExpression → expression: ${f.firstLine}`;
      // Edit must open the ExtendedExpression's .expression, not the AB's
      // .showExpression (which is the Reference handle). Without this
      // redirect, the editor falls back to the AB's `expression` field —
      // silently editing the wrong EC. The walker EC fetched the target rid
      // alongside the content; pass both to the renderer.
      const targetRid = data.ab_showExpression_rid;
      if (targetRid) {
        f.targetRid = targetRid;
        f.targetProp = 'expression';
      }
      localCode.push(f);
    }
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
      const trimmed = s.trim();
      if (!trimmed) return null;
      const parts = trimmed.split('|');
      if (parts.length < 4) return null;
      const [crid, businessId, name, type] = parts;
      if (!crid) return null;
      return { rid: crid, businessId: businessId ?? '', name: name ?? '', type: type ?? '' } as FlowIdentity;
    }).filter((r): r is FlowIdentity => r !== null);
    for (const c of childRows) {
      const child: FlowStep = { identity: c };
      const childExpr = data[`actchild_expression_${c.rid}`];
      if (childExpr) child.codeFields = [makeCodeField('expression', childExpr, [])];
      actStep.children!.push(child);
    }

    return { steps: [abStep] };
  }

  private async fetchLabelFlow(rid: string, signal?: AbortSignal): Promise<FlowChain | null> {
    const ref = await this.resolveRef(rid);
    const result = await this.executeEc(buildLabelFlowEc(ref), undefined, false, signal);
    if (!result.ok || !result.log) return null;
    const data = parseSepBlocks(result.log, FLOW_SEP);

    const lblRow = parsePipeRow(data.lbl);
    if (!lblRow) return null;
    const step: FlowStep = { identity: lblRow };
    const code: FlowCodeField[] = [];
    if (data.lbl_defaultExpression) code.push(makeCodeField('defaultExpression', data.lbl_defaultExpression, []));
    if (data.lbl_expression) code.push(makeCodeField('expression', data.lbl_expression, []));
    if (code.length > 0) step.codeFields = code;
    return { steps: [step] };
  }

  /** Apply a batched style change to a single object via _o.change(...).
   *  Property names MUST be in PANE_PROPS_SET; values are escaped client-side.
   *  Atomic per the EC change() semantics — partial application is impossible. */
  async applyObjectChanges(
    rid: string,
    target: 'instance' | 'template',
    changes: Record<string, string | number | boolean>,
  ): Promise<{ ok: boolean; error?: string }> {
    const props = Object.keys(changes);
    if (props.length === 0) return { ok: true };
    for (const p of props) {
      if (!PANE_PROPS_SET.has(p)) {
        // Print enough context to diagnose the cause. We had a report
        // ("Property not allowed: disableSearch") for a prop that's
        // explicitly in PANE_PROPS — the most likely cause is a stale
        // bundled SW or a hidden-character name mismatch. Code-point
        // dump catches the latter; the set size tells us if the SW's
        // PANE_PROPS_SET is somehow empty.
        const codepoints = [...p].map(c => c.codePointAt(0)?.toString(16)).join(',');
        return {
          ok: false,
          error: `Property not allowed: "${p}" (codepoints ${codepoints}; ${PANE_PROPS_SET.size} props in allowlist). If this prop normally works, try Disable + Re-enable the extension to refresh the service worker.`,
        };
      }
      // Defense-in-depth: PANE_PROPS_SET is already an allowlist, but valid-
      // ating the identifier shape ensures even a corrupted allowlist can't
      // become an injection vector.
      validateEcIdentifier(p);
    }
    const ref = await this.resolveRef(rid);
    const assignments: string[] = [];
    for (const p of props) {
      assignments.push(`${p} := ${this.formatEcLiteral(changes[p])}`);
    }
    const lines: string[] = [
      `_o := ${ref}`,
    ];
    if (target === 'template') {
      lines.push('_t := _o.linkedTo');
      lines.push('IF _t = MISSING THEN _t := _o.template ENDIF');
      lines.push('IF _t = MISSING THEN');
      lines.push('  "no template"');
      lines.push('ELSE');
      lines.push(`  _t.change(${assignments.join(', ')})`);
      lines.push('ENDIF');
    } else {
      lines.push(`_o.change(${assignments.join(', ')})`);
    }
    const result = await this.executeEc(lines.join('\n'), undefined, true);
    if (!result.ok) return { ok: false, error: result.error ?? result.log ?? 'Change failed' };
    if (result.log?.includes('no template')) return { ok: false, error: 'Object has no template' };
    return { ok: true };
  }

  /** Format a JS value as an EC literal: strings double-quoted with escapes,
   *  numbers as-is, booleans as TRUE/FALSE. */
  private formatEcLiteral(value: string | number | boolean): string {
    if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
    if (typeof value === 'number') return String(value);
    const escaped = String(value)
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n');
    return `"${escaped}"`;
  }

  // ── Static health checks ─────────────────────────────────────

  static async checkHealth(bmpUrl: string): Promise<{ up: boolean; reachable: boolean; responseMs: number }> {
    const start = performance.now();
    try {
      const res = await fetch(`${bmpUrl}health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT) });
      const ms = Math.round(performance.now() - start);
      if (res.status === 401 || res.status === 404 || res.status === 403) {
        return { up: true, reachable: true, responseMs: ms };
      }
      if (!res.ok) return { up: false, reachable: true, responseMs: ms };
      const data = await res.json().catch(() => null);
      if (!data) return { up: true, reachable: true, responseMs: ms };
      return { up: data.status === 'up', reachable: true, responseMs: ms };
    } catch (e) {
      log.swallow('bmpClient:checkHealth', e);
      return { up: false, reachable: false, responseMs: Math.round(performance.now() - start) };
    }
  }

  static async getBuildNumber(bmpUrl: string, jwt?: string): Promise<string | null> {
    try {
      const headers: Record<string, string> = {};
      if (jwt) headers['Authorization'] = `Bearer ${jwt}`;
      const res = await fetch(`${bmpUrl}buildNum`, { headers, signal: AbortSignal.timeout(HEALTH_TIMEOUT) });
      if (!res.ok) return null;
      const data = await res.json().catch(() => null);
      return data?.version?.trim() || null;
    } catch (e) {
      log.swallow('bmpClient:getBuildNumber', e);
      return null;
    }
  }

}

