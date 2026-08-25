/**
 * BMP client facade — composes BmpAuth + BmpTransport.
 * Public API unchanged for all consumers.
 */

import {
  registerBmpTypes,
  makeGetObjectCommand,
  makeUpdateCommand,
  makeExtendedExecuteCommand,
  makeTreeItemCommand,
  makeAccessTraceCommand,
  parseEcResults,
  parseCommandResponse,
  parseObjectData,
  parseTreeNodeInfo,
  type EcOutputEntry,
} from './bmp-types';
import { colorLinkBid } from './color-util';
import { styleAssignRhs, INVALID_COLOR_BID } from './style-ec';
import type {
  ColorSetData, AccessTraceAction, AccessTraceNode, AccessSubject, BmpObject,
  LayoutNode, ObjectPanePayload,
} from './types';
import { log } from './logger';
import { assertHostAccess } from './site-access';
import { HEALTH_TIMEOUT, AUTH_TIMEOUT, EC_TIMEOUT } from './constants';
import { BmpAuth, AuthError } from './bmp-auth';
import type { CommandAuthMode, AuthErrorCode } from './bmp-auth';
import { BmpTransport, type BmpTransportOutcome } from './bmp-transport';
import { compareVersions } from './util';
import { validateBusinessId, validateRid, validateEcIdentifier, formatEcLiteral } from './ec-guards';
import { resolveNamespace } from './namespace';
import { ecResolveTemplate } from './template-link';
import type { FlowChain } from './flow-parser';
import { EcQueryService } from './ec-query-service';
import type { IdentityChangeSet } from './object-identity';
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

export type BuildNumberProbeResult =
  | { status: 'known'; version: string }
  | { status: 'auth-required' }
  | { status: 'unavailable' }
  | { status: 'transient' };

export interface EcResult {
  ok: boolean;
  log?: string;
  outputEntries?: EcOutputEntry[];
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
export type ObjectPaneData = ObjectPanePayload;

// Flow walker types + parsing helpers live in lib/flow-parser.ts.
// Re-export the types we hand back from fetchFlowChain so callers don't
// need a second import.
export type { FlowChain, FlowStep, FlowCodeField, FlowIdentity } from './flow-parser';

/** Properties surfaced by the object pane. Allowlisted to prevent EC injection
 *  via attacker-controlled keys and to gate UI editors per property type. */
export const PANE_PROPS = [
  // Property-definition metadata. Missing safely on non-property objects.
  'description', 'category',
  'width', 'height',
  // Responsive width — verified live via bmp_type_fields on Scorecard subtypes;
  // ResponsiveWidth mixin attaches these to layout-bearing widgets. 0-6 each,
  // 0 == 6 (full width).
  'columnsLargeScreen', 'columnsMediumScreen', 'columnsSmallScreen',
  // Display-level toggles attached by HasToolsMenu / HasDisableSearch mixins.
  'showToolMenu', 'disableSearch',
  // HasWidgetColors declares only headerColor + fontColor (no bgColor —
  // verified against the live type schema).
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
  // EditField → property accessor on the business object created/edited by
  // the owning CreateObjectView. Full Object View renders a live class-schema
  // picker for this rather than a free-text box.
  'propertyMapping',
  // Essential EditField behaviour. Keep these in the same focused Field
  // section as propertyMapping; Blueprint owns structure, Object View owns
  // deliberate field configuration.
  'required', 'placeholder', 'propertyHint',
  // Label default mode. Both have concrete setters on Label and are edited
  // together through the pane's confirmed, atomic change() path.
  'textInputType', 'advancedDefault',
] as const;
export type PaneProp = typeof PANE_PROPS[number];
export const PANE_PROPS_SET: ReadonlySet<string> = new Set(PANE_PROPS);

/** Identity fields edited from Full Object View. Keep these separate from
 * PANE_PROPS: they are already returned as ObjectPaneIdentity, so adding them
 * to the pane-property query would fetch the same values a second time. */
export const OBJECT_IDENTITY_PROPS = ['name', 'id'] as const;
export const OBJECT_CHANGE_PROPS_SET: ReadonlySet<string> = new Set([
  ...PANE_PROPS,
  ...OBJECT_IDENTITY_PROPS,
]);

/** Preserve "unreadable metadata" as null instead of treating it as no overrides. */
export function parseObjectOverrideProps(raw: unknown): string[] | null {
  const response = raw as { response?: unknown } | null | undefined;
  const parsed = parseObjectData(response?.response ?? response);
  return parsed ? parsed.overridden : null;
}

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
  invalidate?(rid: string): void;
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
    authMode: CommandAuthMode = 'portal',
    credentialRevision = '',
  ) {
    this.auth = new BmpAuth(bmpUrl, bmpUser, bmpPass, profileId, authMode, credentialRevision);
    this.transport = new BmpTransport(bmpUrl, this.auth);
    // Dynamic-dispatch wrappers (not `.bind()`) so tests that monkey-patch
    // `client.executeEc` / `client.resolveRef` on the instance after
    // construction still intercept calls made through the service.
    this.ecQuery = new EcQueryService(
      (code, objectRid, transactional, signal, timeoutMs, feature) =>
        this.executeEc(code, objectRid, transactional, signal, timeoutMs, feature),
      (rid) => this.resolveRef(rid),
      PANE_PROPS,
    );
  }

  get jwt(): string | null { return this.auth.jwt; }
  get serverUrl(): string { return this.bmpUrl; }
  get username(): string { return this.auth.username; }
  get authMode(): CommandAuthMode { return this.auth.authMode; }
  get commandUser(): string | null { return this.auth.commandUser; }
  get portalActor(): string | null { return this.auth.portalActor; }
  bindPortalActor(actor: string): void { this.auth.bindPortalActor(actor); }
  passwordMatches(pass: string): boolean { return this.auth.passwordMatches(pass); }
  setTransportOutcomeObserver(observer: ((outcome: BmpTransportOutcome) => void) | null): void {
    this.transport.setOutcomeObserver(observer);
  }
  /** Inject enrichment cache for resolveRef lookups. */
  set cache(c: IdentityCache) { this._cache = c; }

  /** Apply version flags — called once when BMP version is detected. */
  applyVersionFlags(version: string) {
    const v = version.replace(/^v\.?/i, '');
    const isOld = compareVersions(v, '5.6.3.0') < 0;
    // LoginTicket authentication is the transport's single cross-version
    // command path. Version only determines whether EC lookup() is available.
    this.supportsLookup = !isOld;
  }

  /** Safe fallback when version detection fails — assume old BMP.
   *  Binary mode with ticket auth works on all BMP versions. */
  assumeOldBmp() {
    this.supportsLookup = false;
  }

  // ── Auth delegation ──────────────────────────────────────────

  async testConnection(): Promise<ConnectionResult> {
    let authenticated = false;
    try {
      await this.auth.getLoginTicket();
      authenticated = true;
      // A connection probe is deliberately cheaper and more tightly bounded
      // than a user EC run. On cold start it owns the serialized command lane;
      // letting the trivial `1` probe consume the general 30-second EC window
      // makes the Extended Code surface appear frozen behind it.
      const probe = await this.executeEc('1', undefined, false, undefined, AUTH_TIMEOUT);
      if (!probe.ok) {
        return { ok: false, message: probe.error ?? probe.log ?? 'BMP command probe failed', authenticated: true };
      }
      return { ok: true, message: 'Authenticated and command channel ready', authenticated: true };
    } catch (e) {
      // AuthError carries a precise cause; everything else (network throw,
      // serializer error) is reported via the transport's generic formatter.
      if (e instanceof AuthError) {
        return { ok: false, message: e.message, authenticated: false, code: e.code };
      }
      return { ok: false, message: this.transport.formatError(e), authenticated };
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
    const buffer = await this.transport.sendCommands([cmd], 'read', signal);
    const objects = this.transport.deserializeStream(buffer);
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
    return this.saveProperties(rid, objectType, { [property]: value });
  }

  /** Save a related property set in one BMP update command. */
  async saveProperties(rid: string, objectType: string, properties: Record<string, string>): Promise<{ ok: boolean; error?: string }> {
    try {
      const cmd = makeUpdateCommand(rid, objectType, properties);
      const buffer = await this.transport.sendCommands([cmd], 'write');
      const raw = this.transport.deserializeResponse(buffer, 'write');

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
      await assertHostAccess(u.toString());
      const res = await fetch(u.toString(), { credentials: 'include', cache: 'no-store' });
      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          error: res.status === 401 || res.status === 403
            ? 'Portal login required for live CVO data. The stored command identity does not authenticate portal data.'
            : res.status === 400
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
      await assertHostAccess(u.toString());
      const res = await fetch(u.toString(), { credentials: 'include', cache: 'no-store' });
      if (!res.ok) {
        return {
          ok: false,
          status: res.status,
          error: res.status === 401 || res.status === 403
            ? 'Portal login required for resource downloads. The stored command identity does not authenticate portal files.'
            : `Download HTTP ${res.status}`,
        };
      }
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
    const buffer = await this.transport.sendCommands([makeAccessTraceCommand(rid, subjectRid, action)], 'read', signal);
    return extractAccessTrace(this.transport.deserializeStream(buffer));
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
      const r = parseEcResults(await this.transport.sendStreamingCommand(cmd, 'read'));
      if (!r.ok) return undefined; // transient failure: don't cache, retry next run
      const m = r.log?.match(/ORG=(-?\d+)/);
      const org = m && m[1] !== '0' ? BigInt(m[1]) : undefined;
      this.orgRidCache.set(objectRid, org); // cache only a definitive answer
      return org;
    } catch {
      return undefined; // network/unsupported: don't cache, so a recovery retries
    }
  }

  async executeEc(
    code: string,
    objectRid?: string,
    transactional = false,
    signal?: AbortSignal,
    timeoutMs?: number,
    feature?: import('./bmp-transport').BmpTransportMetrics['feature'],
  ): Promise<EcResult> {
    try {
      const cmd = makeExtendedExecuteCommand(code, {
        objectRid: objectRid ? BigInt(objectRid) : undefined,
        orgRid: objectRid ? await this.resolveOrgRid(objectRid) : undefined,
        transactional,
      });
      const objects = await this.transport.sendStreamingCommand(
        cmd,
        transactional ? 'write' : 'read',
        signal,
        timeoutMs,
        feature,
      );
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

  /** Lightweight identity fetch for a single RID (version-aware). `fresh` evicts a cached legacy
   *  business-ID reference first, which is required when verifying an ID-changing write. */
  async lookupIdentity(
    rid: string,
    options?: { fresh?: boolean },
  ): Promise<{ name?: string; type?: string; businessId?: string; templateBusinessId?: string } | null> {
    if (options?.fresh) this._cache?.invalidate?.(rid);
    const { results } = await this.batchEnrich([rid]);
    return results[rid] ?? null;
  }

  /** Fetch code properties via EC */
  async fetchCodeViaEc(rid: string, properties: string[]): Promise<Record<string, string>> {
    return this.ecQuery.fetchCodeViaEc(rid, properties);
  }

  /** Read a bounded exact property selection with explicit missing state and
   * structured reference identities where requested. */
  async fetchSelectedProperties(
    rid: string,
    properties: readonly import('./ec-query-service').SelectedPropertyRequest[],
    signal?: AbortSignal,
  ): Promise<import('./ec-query-service').SelectedPropertyValue[]> {
    return this.ecQuery.fetchSelectedProperties(rid, properties, signal);
  }

  /** Batch fetch code properties for multiple objects in a single EC call */
  async batchFetchCode(
    rids: string[],
    properties: string[],
    signal?: AbortSignal,
  ): Promise<Map<string, Record<string, string>>> {
    return this.ecQuery.batchFetchCode(rids, properties, signal);
  }

  /** Walk the layout subtree of a Scorecard / TabSet / Tab / Container.
   *  Returns flat nodes with parent linkage + responsive sizing — the
   *  panel folds these into a tree client-side. Single round trip via
   *  EC `.descendants()` so even deep nests cost one server call.
   *
   *  Returned types: Tab, TabSet, Container, plus widget objects bound to
   *  any container in the subtree (rendered as leaves with their cell
   *  reference). */
  async fetchLayoutTree(rid: string): Promise<{ nodes: LayoutNode[]; truncated: boolean }> {
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
    const data = await this.ecQuery.fetchObjectPane(rid, signal);
    if (!data) return null;
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    // Master properties use a compact, read-only pane and have no instance
    // override delta. Avoid the otherwise redundant binary GetObject command.
    if (data.isPropertyDefinition) return data;

    const overrideProps = await this.fetchObjectOverrideProps(rid, signal);
    if (overrideProps) {
      data.instanceOverrideProps = overrideProps;
    } else {
      // Some older BMP objects throw inside IntegrationGetObjectCommand. Keep
      // the pane usable with value comparison. This cannot reveal an explicit
      // same-value override, so authoritative metadata always wins when parsed.
      data.instanceOverrideProps = PANE_PROPS.filter(prop =>
        data.template != null
        && data.instanceProps[prop] !== data.templateProps[prop],
      );
    }
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    return data;
  }

  async fetchPropertyApplications(rid: string, signal?: AbortSignal) {
    return this.ecQuery.fetchPropertyApplications(rid, signal);
  }

  private async fetchObjectOverrideProps(rid: string, signal?: AbortSignal): Promise<string[] | null> {
    try {
      const buffer = await this.transport.sendCommands([makeGetObjectCommand(rid)], 'read', signal);
      const raw = this.transport.deserializeResponse(buffer);
      const first = parseCommandResponse(raw)[0];
      return parseObjectOverrideProps(first);
    } catch (e) {
      log.swallow('bmpClient:fetchObjectPane:overrides', e);
      return null;
    }
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

  /** Apply a batched pane/identity change to a single object via _o.change(...).
   *  Property names MUST be in OBJECT_CHANGE_PROPS_SET; values are escaped client-side.
   *  Callers must still read back persisted state: BMP execute mode commits writes,
   *  but does not provide rollback-on-error semantics. */
  async applyObjectChanges(
    rid: string,
    target: 'instance' | 'template',
    changes: Record<string, string | number | boolean>,
    resetProps: string[] = [],
  ): Promise<{ ok: boolean; error?: string }> {
    const props = Object.keys(changes);
    if (props.length === 0 && resetProps.length === 0) return { ok: true };
    if (target === 'template' && resetProps.length > 0) {
      return { ok: false, error: 'Template properties cannot be reset to an instance source' };
    }
    const duplicate = resetProps.find(prop => props.includes(prop));
    if (duplicate) return { ok: false, error: `Property cannot be changed and reset together: ${duplicate}` };
    for (const p of [...props, ...resetProps]) {
      if (!OBJECT_CHANGE_PROPS_SET.has(p)) {
        // Print enough context to diagnose the cause. We had a report
        // ("Property not allowed: disableSearch") for a prop that's
        // explicitly in PANE_PROPS — the most likely cause is a stale
        // bundled SW or a hidden-character name mismatch. Code-point
        // dump catches the latter; the set size tells us if the SW's
        // PANE_PROPS_SET is somehow empty.
        const codepoints = [...p].map(c => c.codePointAt(0)?.toString(16)).join(',');
        return {
          ok: false,
          error: `Property not allowed: "${p}" (codepoints ${codepoints}; ${OBJECT_CHANGE_PROPS_SET.size} props in allowlist). If this prop normally works, try Disable + Re-enable the extension to refresh the service worker.`,
        };
      }
      // Defense-in-depth: OBJECT_CHANGE_PROPS_SET is already an allowlist, but valid-
      // ating the identifier shape ensures even a corrupted allowlist can't
      // become an injection vector.
      validateEcIdentifier(p);
    }
    const ref = await this.resolveRef(rid);
    const assignments: string[] = [];
    for (const p of props) {
      // Shared rule (style-ec): colour links → `prop := t.<bid>` (a reference, never a quoted string,
      // which errors on a CorpoColor prop) or `:= ""` to CLEAR when empty; scalars → an EC literal.
      // Property editors store draft values as strings. `required` is outside
      // the style catalogue, so normalize it explicitly to an EC boolean
      // instead of persisting the string "true"/"false".
      const value = p === 'required'
        ? String(changes[p]).toLowerCase() === 'true'
        : changes[p];
      const rhs = styleAssignRhs(p, value, (v) => this.formatEcLiteral(v));
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
      if (assignments.length > 0) lines.push(`_o.change(${assignments.join(', ')})`);
      for (const prop of resetProps) lines.push(`_o.reset(${prop})`);
    }
    const result = await this.executeEc(lines.join('\n'), undefined, true);
    if (!result.ok) return { ok: false, error: result.error ?? result.log ?? 'Change failed' };
    if (result.log?.includes('no template')) return { ok: false, error: 'Object has no template' };
    return { ok: true };
  }

  /**
   * Preview, then apply the requested identity fields in one EC write.
   *
   * BMP's `transactional` flag means commit-vs-preview, not rollback on error.
   * The exact script is therefore previewed first, template resolution happens
   * before either write, and the lower-blast-radius instance change runs before
   * the linked-template ID change. The handler must always read back after a
   * write attempt and treat that persisted state as authoritative.
   */
  async applyIdentityChanges(
    rid: string,
    changes: IdentityChangeSet,
  ): Promise<{ ok: boolean; writeAttempted: boolean; error?: string }> {
    const changesTemplate = Object.hasOwn(changes, 'templateBusinessId');
    const instanceAssignments: string[] = [];

    if (changes.businessId !== undefined) {
      validateBusinessId(changes.businessId);
      instanceAssignments.push(`id := ${this.formatEcLiteral(changes.businessId)}`);
    }
    if (changes.name !== undefined) {
      if (!changes.name.trim()) {
        return { ok: false, writeAttempted: false, error: 'Name is required.' };
      }
      instanceAssignments.push(`name := ${this.formatEcLiteral(changes.name)}`);
    }
    if (changesTemplate) validateBusinessId(changes.templateBusinessId ?? '');
    if (instanceAssignments.length === 0 && !changesTemplate) {
      return { ok: true, writeAttempted: false };
    }

    const ref = await this.resolveRef(rid);
    const lines = [`_o := ${ref}`];
    const instanceChange = instanceAssignments.length > 0
      ? `_o.change(${instanceAssignments.join(', ')})`
      : null;

    if (changesTemplate) {
      lines.push(...ecResolveTemplate('_o', '_t'));
      lines.push('IF _t = MISSING THEN');
      lines.push('  "no template"');
      lines.push('ELSE');
      if (instanceChange) lines.push(`  ${instanceChange}`);
      lines.push(`  _t.change(id := ${this.formatEcLiteral(changes.templateBusinessId ?? '')})`);
      lines.push('ENDIF');
    } else if (instanceChange) {
      lines.push(instanceChange);
    }

    const script = lines.join('\n');
    const preview = await this.executeEc(script, undefined, false);
    if (!preview.ok || preview.hasWarning) {
      return {
        ok: false,
        writeAttempted: false,
        error: preview.error
          ?? (preview.hasWarning
            ? `BMP reported a warning during identity validation${preview.log ? `: ${preview.log}` : '.'}`
            : preview.log)
          ?? 'Identity validation failed',
      };
    }
    if (preview.log?.includes('no template')) {
      return { ok: false, writeAttempted: false, error: 'Could not resolve the linked template.' };
    }

    const result = await this.executeEc(script, undefined, true);
    if (!result.ok || result.hasWarning) {
      return {
        ok: false,
        writeAttempted: true,
        error: result.error
          ?? (result.hasWarning
            ? `BMP reported a warning while saving identity values${result.log ? `: ${result.log}` : '.'}`
            : result.log)
          ?? 'Identity change failed',
      };
    }
    if (result.log?.includes('no template')) {
      return { ok: false, writeAttempted: true, error: 'Could not resolve the linked template.' };
    }
    return { ok: true, writeAttempted: true };
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
    await assertHostAccess(this.bmpUrl);
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
    if (res.status === 401 || res.status === 403 || res.redirected
      || (res.url && new URL(res.url).origin !== new URL(this.bmpUrl).origin)) {
      throw new Error('Portal login required for workspace search. Stored command access does not broaden portal search.');
    }
    if (!res.ok) throw new Error(`quickSearch HTTP ${res.status}`);
    const contentType = res.headers?.get?.('content-type') ?? '';
    if (contentType && !contentType.includes('json')) {
      throw new Error('Portal login required for workspace search.');
    }
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
      await assertHostAccess(bmpUrl);
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

  static async getBuildNumber(bmpUrl: string, jwt?: string): Promise<BuildNumberProbeResult> {
    try {
      await assertHostAccess(bmpUrl);
      const headers: Record<string, string> = {};
      if (jwt) headers['Authorization'] = `Bearer ${jwt}`;
      const res = await fetch(`${bmpUrl}buildNum`, { headers, signal: AbortSignal.timeout(HEALTH_TIMEOUT) });
      if (res.status === 401 || res.status === 403) return { status: 'auth-required' };
      if (res.status === 408 || res.status === 425 || res.status === 429 || res.status >= 500) {
        return { status: 'transient' };
      }
      if (!res.ok) return { status: 'unavailable' };
      const data = await res.json().catch(() => null);
      const version = typeof data?.version === 'string' ? data.version.trim() : '';
      return version ? { status: 'known', version } : { status: 'unavailable' };
    } catch (e) {
      log.swallow('bmpClient:getBuildNumber', e);
      return { status: 'transient' };
    }
  }

}
