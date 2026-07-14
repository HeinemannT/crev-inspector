/**
 * BMP client facade — composes BmpAuth + BmpTransport.
 * Public API unchanged for all consumers.
 */

import {
  registerBmpTypes,
  makeUpdateCommand,
  makeExtendedExecuteCommand,
  makeTreeItemCommand,
  makeAccessTraceCommand,
  parseEcResults,
  parseTreeNodeInfo,
} from './bmp-types';
import { deserializeStream } from './java-serial';
import { colorLinkBid } from './color-util';
import { styleAssignRhs, INVALID_COLOR_BID } from './style-ec';
import type { ColorSetData, ObjectPaneCard, AccessTraceAction, AccessTraceNode, AccessSubject, BmpObject, LayoutNode } from './types';
import { log } from './logger';
import { HEALTH_TIMEOUT, EC_TIMEOUT } from './constants';
import { BmpAuth, AuthError } from './bmp-auth';
import type { AuthMode, AuthErrorCode, AuthVia } from './bmp-auth';
import { BmpTransport } from './bmp-transport';
import { compareVersions } from './util';
import { validateRid, validateEcIdentifier, formatEcLiteral } from './ec-guards';
import { resolveNamespace } from './namespace';
import { ecResolveTemplate } from './template-link';
import type { FlowChain } from './flow-parser';
import { EcQueryService } from './ec-query-service';
export { buildAccessSubjectsEc, parseAccessSubjectsLog, parseResolveTemplateLog, buildLayoutTreeEc, parseAwtColor } from './ec-query-service';

/** The subset of BMP's GraphQL quickSearch response we read (external, evolving
 *  schema — fields are optional and loosely typed on purpose). */
interface QuickSearchHit {
  epmObject?: {
    rid?: string | number; name?: string; type?: string;
    webParentRid?: string | number; webParentName?: string;
    hasChildren?: boolean; tabRid?: string | number;
  };
  pageLocationInfo?: { rid?: string | number; name?: string };
}
interface QuickSearchData { totalHits?: number; hits?: QuickSearchHit[]; }

// Ensure BMP types are registered once
registerBmpTypes();

/** Validate that a RID is a numeric string (positive or negative). Prevents EC injection. */
// Identifier / RID guards live in ec-guards.ts so ec-codegen can apply
// them at every interpolation slot too (defence-in-depth for the walker
// EC, not just the save paths).

export interface ConnectionResult {
  ok: boolean;
  message: string;
  authenticated: boolean;
  /** Machine-readable cause on failure — drives the connection UI state. */
  code?: AuthErrorCode;
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
  /** Effective detail card — the object's own `.card`, else the template's
   *  `.card` (enterprise objects carry the card on their EnterpriseTemplate,
   *  not the instance). `viaTemplate` is true when it was inherited. */
  card: ObjectPaneCard | null;
  /** Property values keyed by name. Empty string means "not set" on server. */
  instanceProps: Record<string, string>;
  templateProps: Record<string, string>;
  /** Siblings under the same parent — empty if parent is null. Capped at
   *  SIBLING_CAP rows; `siblingTotal` carries the true count. */
  siblings: ObjectPaneSibling[];
  /** True number of children under the parent (siblings may be a capped
   *  slice). Equals siblings.length when nothing was truncated. */
  siblingTotal: number;
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
  // HasWidgetColors declares only headerColor + fontColor (no bgColor —
  // verified against every decompiled BeanInfo + the live type schema).
  'headerColor', 'fontColor',
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

// ── Access-trace parsing ──────────────────────────────────────────
// The deserialized tree uses boxed java.lang.Boolean ({value}), HashMaps
// ({$map} / {$entries}), and ArrayLists ({$elements}); java.time.Duration is
// skipped by the deserializer (cosmetic). These coercers normalise that into
// a clean AccessTraceNode the UI can render directly.

function atCoerceBool(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  if (v && typeof v === 'object' && typeof (v as { value?: unknown }).value === 'boolean') {
    return (v as { value: boolean }).value;
  }
  return null;
}

function atStringify(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'object') {
    const o = v as { value?: unknown; identifier?: unknown };
    if (o.value != null) return String(o.value);
    if (o.identifier != null) return String(o.identifier);
    return '';
  }
  return String(v);
}

function atCoerceStringMap(v: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!v || typeof v !== 'object') return out;
  const o = v as { $map?: Record<string, unknown>; $entries?: [unknown, unknown][] };
  if (o.$map && typeof o.$map === 'object') {
    for (const [k, val] of Object.entries(o.$map)) out[String(k)] = atStringify(val);
  } else if (Array.isArray(o.$entries)) {
    for (const [k, val] of o.$entries) out[atStringify(k)] = atStringify(val);
  }
  return out;
}

export function parseAccessTraceNode(dto: any): AccessTraceNode {
  const kids = dto?.childrenDTOs?.$elements ?? dto?.childrenDTOs ?? [];
  return {
    element: String(dto?.element ?? ''),
    result: atCoerceBool(dto?.result),
    timedOut: dto?.timedOut === true,
    details: atCoerceStringMap(dto?.details),
    children: Array.isArray(kids) ? kids.map(parseAccessTraceNode) : [],
  };
}

/** Pull the first trace tree out of a deserialized AccessTraceCommand response
 *  (`ArrayList<IntegrationObjectResponse>` → `.response.traces`). Throws on a
 *  server exception. Factored out so the unwrap is unit-testable without BMP. */
export function extractAccessTrace(objects: any[]): AccessTraceNode | null {
  for (const obj of objects) {
    if (obj?.$class?.includes('ServerExceptionResponse')) {
      throw new Error(obj.message ?? 'Access trace was rejected by BMP');
    }
    if (obj?.$class === 'java.util.ArrayList') {
      const resp = obj.$elements?.[0]?.response;
      const tracesRaw = resp?.traces;
      const traces = tracesRaw?.$elements ?? tracesRaw;
      if (Array.isArray(traces) && traces.length > 0) return parseAccessTraceNode(traces[0]);
    }
  }
  return null;
}

/** Lightweight cache interface — avoids coupling to ObjectCache. */
export interface IdentityCache {
  get(rid: string): { businessId?: string; type?: string } | undefined;
}

export class BmpClient {
  readonly auth: BmpAuth;
  private transport: BmpTransport;
  private _cache: IdentityCache | null = null;
  /** The EC-query family (build EC → executeEc → parse) — plan 021. New EC
   *  queries go here; new binary commands stay on BmpClient. */
  private ecQuery: EcQueryService;

  /** Whether server supports EC lookup(). null = unknown (not yet detected).
   *  Set by applyVersionFlags() after version detection. */
  supportsLookup: boolean | null = null;

  constructor(
    private bmpUrl: string,
    bmpUser: string,
    bmpPass: string,
    profileId?: string,
    authMode: AuthMode = 'auto',
  ) {
    this.auth = new BmpAuth(bmpUrl, bmpUser, bmpPass, profileId, authMode);
    this.transport = new BmpTransport(bmpUrl, this.auth);
    // Dynamic-dispatch wrappers (not `.bind()`) so tests that monkey-patch
    // `client.executeEc` / `client.resolveRef` on the instance after
    // construction still intercept calls made through the service.
    this.ecQuery = new EcQueryService(
      (code, objectRid, transactional, signal, timeoutMs) =>
        this.executeEc(code, objectRid, transactional, signal, timeoutMs),
      (rid) => this.resolveRef(rid),
      PANE_PROPS,
    );
  }

  get jwt(): string | null { return this.auth.jwt; }
  get serverUrl(): string { return this.bmpUrl; }
  get username(): string { return this.auth.username; }
  get authMode(): AuthMode { return this.auth.authMode; }
  /** How the live session was actually obtained (session-borrow vs password). */
  get authVia(): AuthVia | null { return this.auth.via; }
  updateCredentials(user: string, pass: string, authMode?: AuthMode): void {
    this.auth.updateCredentials(user, pass, authMode);
  }

  /** Inject enrichment cache for resolveRef lookups. */
  set cache(c: IdentityCache) { this._cache = c; }

  /** Apply version flags — called once when BMP version is detected. */
  applyVersionFlags(version: string) {
    const v = version.replace(/^v\.?/i, '');
    const isOld = compareVersions(v, '5.6.3.0') < 0;
    // Ticket authentication is accepted across BMP versions and is required
    // by current 5.6.10 /cs/command deployments. Version still determines
    // whether EC lookup() is available.
    this.transport.useTicketAuth = true;
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
      // AuthError carries a precise cause; everything else (network throw,
      // serializer error) is reported via the transport's generic formatter.
      if (e instanceof AuthError) {
        return { ok: false, message: e.message, authenticated: false, code: e.code };
      }
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

  /** Fetch a CustomVisualization's live `_data` from the data servlet. Unlike
   *  the binary command channel (JWT/ticket), this servlet auths by the BMP
   *  SESSION COOKIE — so it's a plain credentials:'include' GET that rides the
   *  browser's BMP session (the SW has host + cookies permissions). Returns the
   *  servlet JSON (expressions/tables/serverConnections/context). A 400 means
   *  the render context isn't org-rooted (the CVO must resolve under an
   *  Organisation) — surfaced as a clear message for the studio's live toggle. */
  async cvoData(
    cvoRid: string,
    businessObjectRid: string,
    periodType = 'M',
    periodMillis?: number,
  ): Promise<{ ok: boolean; data?: unknown; error?: string; status?: number }> {
    const u = new URL(`${this.transport.baseUrl}web/customvisualizationdata`);
    u.searchParams.set('customvizrid', cvoRid);
    u.searchParams.set('businessobjectrid', businessObjectRid);
    u.searchParams.set('selectedPeriodType', periodType);
    u.searchParams.set('selectedPeriod', String(periodMillis ?? Date.now()));
    u.searchParams.set('ytd', 'false');
    u.searchParams.set('_t', String(Date.now())); // cache-buster
    try {
      const res = await fetch(u.toString(), { credentials: 'include', cache: 'no-store' });
      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          error: res.status === 400
            ? 'Data servlet returned 400: the render context is not org-rooted. The CVO must resolve under an Organisation; pick an org-rooted scorecard or page rid as the render context.'
            : `Data servlet HTTP ${res.status}`,
        };
      }
      return { ok: true, data: await res.json() };
    } catch (e) {
      return { ok: false, error: this.transport.formatError(e) };
    }
  }

  /** Download a FileResource's decoded `content` bytes as text — the
   *  /web/download servlet decodes the stored `name;mime;base64` triplet and
   *  serves the real bytes (no nosniff), so a hosted JS library comes back as
   *  runnable source. Session-cookie auth (same as cvoData), so it's a plain
   *  credentials:'include' GET. Used by the studio to inject a CVO's hosted
   *  libraries into the sandbox preview. rid stays a string (Java long). */
  async downloadResource(rid: string): Promise<{ ok: boolean; text?: string; error?: string; status?: number }> {
    const u = new URL(`${this.transport.baseUrl}web/download`);
    u.searchParams.set('propName', 'content');
    u.searchParams.set('rid', rid);
    try {
      const res = await fetch(u.toString(), { credentials: 'include', cache: 'no-store' });
      if (!res.ok) return { ok: false, status: res.status, error: `Download HTTP ${res.status}` };
      return { ok: true, text: await res.text() };
    } catch (e) {
      return { ok: false, error: this.transport.formatError(e) };
    }
  }

  // ── Access trace (admin permission test) ──────────────────────

  /** Run AccessTraceCommand: trace whether `subjectRid` (a user OR role) has
   *  `action` access to `rid`. Returns the PBAC decision tree, or throws on a
   *  server-side rejection (e.g. insufficient privilege). */
  async fetchAccessTrace(
    rid: string,
    subjectRid: string,
    action: AccessTraceAction = 'READ',
    signal?: AbortSignal,
  ): Promise<AccessTraceNode | null> {
    const buffer = await this.transport.sendCommands([makeAccessTraceCommand(rid, subjectRid, action)], signal);
    return extractAccessTrace(deserializeStream(buffer));
  }

  /** List users + roles (the possible trace subjects) via EC, sorted by name. */
  async listAccessSubjects(): Promise<AccessSubject[]> {
    return this.ecQuery.listAccessSubjects();
  }

  // ── EC operations ────────────────────────────────────────────

  /** Execute Extended Code. `timeoutMs` widens the network window for known-long runs
   *  (blueprint layout fetch/apply on heavy pages) — defaults to EC_TIMEOUT in the transport. */
  /** objectRid → organisation rid, resolved once per session. `this.org` in EC
   *  reads the calculation context's orgRid. BMP's web context binds that to the
   *  object's owning organisation for a standard page; we sent 0, so `this.org`
   *  resolved to nothing (`this.object.organisation` still worked because it
   *  walks the object's own tree, not the context — see extended-code
   *  reference, "this.org vs this.object.organisation"). We bind the same
   *  owning org. Cache: the org binding of an object never changes mid-session. */
  private orgRidCache = new Map<string, bigint | undefined>();

  private async resolveOrgRid(objectRid: string): Promise<bigint | undefined> {
    if (this.orgRidCache.has(objectRid)) return this.orgRidCache.get(objectRid);
    try {
      // Tag the value with a marker: parseEcResults strips BMP's "Result : "
      // prefix, so a bare number would be indistinguishable from the status/
      // duration log lines. `whenMissing(0)` yields "ORG=0" for no owning org.
      const cmd = makeExtendedExecuteCommand(`"ORG=" + str(lookup(${objectRid}).organisation.rid.whenMissing(0))`, {});
      const r = parseEcResults(await this.transport.sendStreamingCommand(cmd));
      if (!r.ok) return undefined; // transient failure: don't cache, retry next run
      const m = r.log?.match(/ORG=(-?\d+)/);
      const org = m && m[1] !== '0' ? BigInt(m[1]) : undefined;
      this.orgRidCache.set(objectRid, org); // cache only a definitive answer
      return org;
    } catch {
      return undefined; // network/unsupported: don't cache, so a recovery retries
    }
  }

  async executeEc(code: string, objectRid?: string, transactional = false, signal?: AbortSignal, timeoutMs?: number): Promise<EcResult> {
    try {
      const cmd = makeExtendedExecuteCommand(code, {
        objectRid: objectRid ? BigInt(objectRid) : undefined,
        orgRid: objectRid ? await this.resolveOrgRid(objectRid) : undefined,
        transactional,
      });
      const objects = await this.transport.sendStreamingCommand(cmd, signal, timeoutMs);
      return parseEcResults(objects);
    } catch (e) {
      // AbortSignal.timeout → TimeoutError; a caller-passed abort → AbortError.
      if (e instanceof DOMException && (e.name === 'AbortError' || e.name === 'TimeoutError')) {
        return { ok: false, error: `EC execution timed out (${Math.round((timeoutMs ?? EC_TIMEOUT) / 1000)}s)` };
      }
      return { ok: false, error: this.transport.formatError(e) };
    }
  }

  /** Resolve template for a linked instance (pure EC) */
  async resolveTemplate(rid: string): Promise<TemplateResolution> {
    return this.ecQuery.resolveTemplate(rid);
  }

  /** Batch enrich: get businessId, type, name, templateBusinessId for multiple RIDs.
   *  Version-aware: uses resolveRef() which returns lookup(rid) on 5.6.3+ or
   *  namespace refs (t.{bid}) on pre-5.6.3. Works on all BMP versions. */
  async batchEnrich(rids: string[], signal?: AbortSignal): Promise<{ results: Record<string, { businessId?: string; type?: string; name?: string; templateBusinessId?: string; cascade?: { rid: string; businessId?: string; type?: string; name?: string } }>; error?: string }> {
    return this.ecQuery.batchEnrich(rids, signal);
  }

  /** Lightweight identity fetch for a single RID (version-aware) */
  async lookupIdentity(rid: string): Promise<{ name?: string; type?: string; businessId?: string; templateBusinessId?: string } | null> {
    const { results } = await this.batchEnrich([rid]);
    return results[rid] ?? null;
  }

  /** Fetch code properties via EC */
  async fetchCodeViaEc(rid: string, properties: string[]): Promise<Record<string, string>> {
    return this.ecQuery.fetchCodeViaEc(rid, properties);
  }

  /** Batch fetch code properties for multiple objects in a single EC call */
  async batchFetchCode(
    rids: string[],
    properties: string[],
  ): Promise<Map<string, Record<string, string>>> {
    return this.ecQuery.batchFetchCode(rids, properties);
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
    return this.ecQuery.fetchLayoutTree(rid);
  }

  /** Fetch direct children of an object via EC */
  async fetchChildren(rid: string): Promise<Array<{ rid: string; name?: string; type?: string; businessId?: string }>> {
    return this.ecQuery.fetchChildren(rid);
  }

  /** Fetch full editor context in a single EC call: identity, template, code props for both.
   *  Replaces separate lookupIdentity + resolveTemplate + 2× fetchCodeViaEc round-trips. */
  async fetchEditorContext(rid: string, extraProps: string[] = []): Promise<EditorContextData | null> {
    return this.ecQuery.fetchEditorContext(rid, extraProps);
  }

  /** Save a code property via EC */
  async saveCodeViaEc(rid: string, property: string, code: string): Promise<{ ok: boolean; error?: string }> {
    validateEcIdentifier(property);
    const escaped = formatEcLiteral(code);
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
    return this.ecQuery.fetchObjectPane(rid, signal);
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
    return this.ecQuery.fetchFlowChain(rid, type, signal);
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
      // Shared rule (style-ec): colour links → `prop := t.<bid>` (a reference, never a quoted string,
      // which errors on a CorpoColor prop) or `:= ""` to CLEAR when empty; scalars → an EC literal.
      const rhs = styleAssignRhs(p, changes[p], (v) => this.formatEcLiteral(v));
      if (rhs === INVALID_COLOR_BID) return { ok: false, error: `Invalid colour id "${colorLinkBid(changes[p])}"` };
      assignments.push(`${p} := ${rhs}`);
    }
    const lines: string[] = [
      `_o := ${ref}`,
    ];
    if (target === 'template') {
      lines.push(...ecResolveTemplate('_o', '_t'));
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

  /** Enumerate the workspace's colour sets + colours (for the link picker).
   *  Walks t.ColorRoot → CorpoColorSet → CorpoColor; each colour carries its
   *  bid (for linking via `t.<bid>`), name, and rgb (parsed from java.awt.Color). */
  async fetchColorSets(): Promise<ColorSetData[]> {
    return this.ecQuery.fetchColorSets();
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

  /**
   * Live workspace search via BMP's GraphQL `quickSearch` — the exact engine
   * the web portal's search box uses. Returns NAVIGABLE objects (pages,
   * scorecards, tasks, enterprise objects) ranked by relevance, with their web
   * parent + page-location breadcrumb. `totalHits` counts all index matches,
   * including non-navigable sub-objects that quickSearch does not materialise,
   * so it can exceed the returned object count.
   *
   * Auth rides the user's BMP web session (JSESSIONID cookie via
   * `credentials: 'include'`), NOT the binary protocol's JWT — same as the
   * portal. The SW has host permission for the BMP origin, so the cookie is
   * attached automatically.
   */
  async quickSearch(
    text: string,
    opts: { page?: number; pageSize?: number; signal?: AbortSignal } = {},
  ): Promise<{ totalHits: number; objects: BmpObject[] }> {
    const page = opts.page ?? 1;
    const pageSize = opts.pageSize ?? 40;
    const query =
      'query quickSearch($text: String, $pageSize: Int, $pageNumber: Int, $searchSlotConfigurationRid: String) {' +
      ' quickSearch(text: $text, pageSize: $pageSize, pageNumber: $pageNumber, searchSlotConfigurationRid: $searchSlotConfigurationRid) {' +
      ' totalHits hits { epmObject { rid name type webParentRid webParentName hasChildren tabRid } pageLocationInfo { rid name } } } }';
    const res = await fetch(`${this.bmpUrl}graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({
        operationName: 'quickSearch',
        variables: { text, pageNumber: page, pageSize, searchSlotConfigurationRid: '' },
        query,
      }),
      signal: opts.signal,
    });
    if (!res.ok) throw new Error(`quickSearch HTTP ${res.status}`);
    const json = await res.json();
    if (json.errors?.length) throw new Error(json.errors[0]?.message ?? 'GraphQL error');
    const q: QuickSearchData = json?.data?.quickSearch ?? { totalHits: 0, hits: [] };
    const now = Date.now();
    const objects: BmpObject[] = (q.hits ?? [])
      .map((hit): BmpObject | null => {
        const e = hit.epmObject;
        if (e?.rid == null) return null;
        return {
          rid: String(e.rid),
          name: e.name ?? undefined,
          type: e.type ?? undefined,
          webParentRid: e.webParentRid != null ? String(e.webParentRid) : undefined,
          webParentName: e.webParentName ?? undefined,
          hasChildren: !!e.hasChildren,
          tabRid: e.tabRid != null ? String(e.tabRid) : undefined,
          pageRid: hit.pageLocationInfo?.rid != null ? String(hit.pageLocationInfo.rid) : undefined,
          pageName: hit.pageLocationInfo?.name ?? undefined,
          source: 'server',
          discoveredAt: now,
          updatedAt: now,
        };
      })
      .filter((o): o is BmpObject => o !== null);
    return { totalHits: q.totalHits ?? objects.length, objects };
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
