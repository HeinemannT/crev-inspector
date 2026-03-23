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

// Ensure BMP types are registered once
registerBmpTypes();

/** Validate that a RID is a numeric string (positive or negative). Prevents EC injection. */
function validateRid(rid: string): string {
  if (!/^-?\d+$/.test(rid)) throw new Error(`Invalid RID: ${rid}`);
  return rid;
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
    if (cached?.businessId) return `t.${cached.businessId}`;

    // Binary GetObject fallback
    const identity = await this.getObjectIdentity(rid);
    if (!identity?.businessId) throw new Error(`Cannot resolve object ${rid} — not found on server`);
    return `t.${identity.businessId}`;
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

  /** Batch enrich: get businessId, type, name for multiple RIDs in a single EC call */
  async batchEnrich(rids: string[], signal?: AbortSignal): Promise<{ results: Record<string, { businessId?: string; type?: string; name?: string; templateBusinessId?: string }>; error?: string }> {
    let valid = rids.filter(Boolean).filter(rid => /^-?\d+$/.test(rid));
    if (valid.length === 0) return { results: {} };
    if (valid.length > BATCH_CHUNK_SIZE) valid = valid.slice(0, BATCH_CHUNK_SIZE);

    const lines = ['_d := "|||"', '_r := ""'];
    for (const rid of valid) {
      lines.push(`_o := lookup(${rid})`);
      lines.push('IF _o != MISSING THEN');
      lines.push('  _t := _o.linkedTo');
      lines.push('  _tid := IF _t != MISSING THEN _t.id.whenMissing("") ELSE "" ENDIF');
      lines.push('  _r := _r + _o.rid.whenMissing("SKIP") + _d + _o.id.whenMissing("") + _d + _o.className.whenMissing("") + _d + _o.name.whenMissing("") + _d + _tid + "\\n"');
      lines.push('ENDIF');
    }
    lines.push('_r');
    const code = lines.join('\n');

    const result = await this.executeEc(code, undefined, false, signal);
    if (!result.ok) { log.debug('batchEnrich', `EC failed for ${valid.length} RIDs:`, result.error); return { results: {}, error: result.error ?? 'EC execution failed' }; }
    if (result.log == null) { log.debug('batchEnrich', 'EC returned null output'); return { results: {}, error: 'EC returned null output' }; }
    if (result.log.trim() === '') { log.debug('batchEnrich', `EC returned empty for ${valid.length} RIDs:`, valid); return { results: {} }; }

    const out: Record<string, { businessId?: string; type?: string; name?: string; templateBusinessId?: string }> = {};
    for (const parts of parsePipeLines(result.log, 4)) {
      // Format: rid|||bid|||type|||name|||templateBid (5th field optional)
      const rid = parts[0];
      const bid = parts[1] || undefined;
      const typ = parts[2] || undefined;
      const name = parts[3] || undefined;
      const tbid = parts[4] || undefined;
      out[rid] = { businessId: bid, type: typ, name, templateBusinessId: tbid };
    }
    const missed = valid.filter(r => !(r in out));
    if (missed.length > 0) log.debug('batchEnrich', `${missed.length}/${valid.length} RIDs not found by lookup():`, missed);
    return { results: out };
  }

  /** Lightweight identity fetch for a single RID (version-aware) */
  async lookupIdentity(rid: string): Promise<{ name?: string; type?: string; businessId?: string; templateBusinessId?: string } | null> {
    if (this.supportsLookup !== false) {
      const { results } = await this.batchEnrich([rid]);
      return results[rid] ?? null;
    }
    const identity = await this.getObjectIdentity(rid);
    if (!identity) return null;
    return { name: identity.name, type: identity.type, businessId: identity.businessId };
  }

  /** Binary fallback: enrich via TreeItemCommand (one per RID, parallel).
   *  Uses lightweight tree node metadata — avoids the NullPointerException
   *  that GetObjectCommand hits on some old BMP objects. */
  async batchEnrichBinary(rids: string[], signal?: AbortSignal): Promise<{ results: Record<string, { businessId?: string; type?: string; name?: string }>; error?: string }> {
    let valid = rids.filter(Boolean).filter(rid => /^-?\d+$/.test(rid));
    if (valid.length === 0) return { results: {} };
    if (valid.length > BATCH_CHUNK_SIZE) valid = valid.slice(0, BATCH_CHUNK_SIZE);

    const out: Record<string, { businessId?: string; type?: string; name?: string }> = {};

    await pMap(valid, async (rid) => {
      try {
        const parsed = await this.fetchTreeItem(rid, signal);
        if (parsed) {
          out[rid] = { businessId: parsed.businessId, type: parsed.type, name: parsed.name };
        }
      } catch {
        // Individual RID failed — skip
      }
    }, MAX_PARALLEL);

    return { results: out };
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
