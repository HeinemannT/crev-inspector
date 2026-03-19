/**
 * BMP client facade — composes BmpAuth + BmpTransport.
 * Public API unchanged for all consumers.
 */

import {
  registerBmpTypes,
  makeUpdateCommand,
  makeExtendedExecuteCommand,
  parseEcResults,
} from './bmp-types';
import { log } from './logger';
import { HEALTH_TIMEOUT, BATCH_CHUNK_SIZE } from './constants';
import { BmpAuth } from './bmp-auth';
import { BmpTransport } from './bmp-transport';
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
}

/**
 * Direct BMP client — facade over BmpAuth + BmpTransport.
 */
export class BmpClient {
  readonly auth: BmpAuth;
  private transport: BmpTransport;

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
  async executeEc(code: string, objectRid?: string, transactional = false): Promise<EcResult> {
    try {
      const cmd = makeExtendedExecuteCommand(code, {
        objectRid: objectRid ? BigInt(objectRid) : undefined,
        transactional,
      });
      const objects = await this.transport.sendStreamingCommand(cmd);
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
    const code = [
      `_o := lookup(${validateRid(rid)})`,
      `_t := _o.linkedTo`,
      `_t.rid.whenMissing("MISSING") + "|||" + _t.name.whenMissing("") + "|||" + _t.className.whenMissing("")`,
    ].join('\n');
    const ecResult = await this.executeEc(code, undefined, false);
    if (!ecResult.ok || !ecResult.log) return { templateRid: null };

    // Find the output line (contains |||) — skip "Result : 0", "Duration" etc.
    const lines = ecResult.log.trim().split('\n');
    const match = lines.find(l => l.includes('|||'))?.trim();
    if (!match || match.startsWith('MISSING')) return { templateRid: null };

    const [tRid, ...rest] = match.split('|||');
    const tType = rest.pop() ?? '';
    const tName = rest.join('|||');
    if (!tRid || tRid === 'MISSING') return { templateRid: null };
    return {
      templateRid: tRid.trim(),
      templateName: tName?.trim() || undefined,
      templateType: tType?.trim() || undefined,
    };
  }

  /** Batch enrich: get businessId, type, name for multiple RIDs in a single EC call */
  async batchEnrich(rids: string[]): Promise<{ results: Record<string, { businessId?: string; type?: string; name?: string }>; error?: string }> {
    if (rids.length === 0) return { results: {} };

    const trimmed = rids.filter(Boolean);
    if (trimmed.length === 0) return { results: {} };

    let valid = trimmed.filter(rid => /^-?\d+$/.test(rid));
    if (valid.length === 0) return { results: {} };
    if (valid.length > BATCH_CHUNK_SIZE) valid = valid.slice(0, BATCH_CHUNK_SIZE);

    const lines = ['_d := "|||"', '_r := ""'];
    for (const rid of valid) {
      lines.push(`_o := lookup(${rid})`);
      lines.push('IF _o != MISSING THEN');
      lines.push('  _r := _r + _o.rid.whenMissing("SKIP") + _d + _o.id.whenMissing("") + _d + _o.className.whenMissing("") + _d + _o.name.whenMissing("") + "\\n"');
      lines.push('ENDIF');
    }
    lines.push('_r');
    const code = lines.join('\n');

    const result = await this.executeEc(code, undefined, false);
    if (!result.ok) return { results: {}, error: result.error ?? 'EC execution failed' };
    if (result.log == null) return { results: {}, error: 'EC returned null output' };
    if (result.log.trim() === '') return { results: {} };

    const out: Record<string, { businessId?: string; type?: string; name?: string }> = {};
    for (const parts of parsePipeLines(result.log, 4)) {
      const [rid, bid, typ, ...rest] = parts;
      const name = rest.join('|||').trim();
      out[rid] = {
        businessId: bid || undefined,
        type: typ || undefined,
        name: name || undefined,
      };
    }
    return { results: out };
  }

  /** Lightweight identity fetch for a single RID */
  async lookupIdentity(rid: string): Promise<{ name?: string; type?: string; businessId?: string } | null> {
    const { results } = await this.batchEnrich([rid]);
    return results[rid] ?? null;
  }

  /** Fetch code properties via EC */
  async fetchCodeViaEc(rid: string, properties: string[]): Promise<Record<string, string>> {
    if (properties.length === 0) return {};
    const sep = '<<<CREV_SEP>>>';
    const lines = [`_o := lookup(${validateRid(rid)})`];
    lines.push('_r := ""');
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
    const lookups = valid.map(rid => `lookup(${rid})`).join(', ');
    const propLines = properties.map(
      prop => `  _r := _r + "${sep}${prop}${sep}" + output(_o.${prop}.whenMissing("")) + "\\n"`,
    );
    const code = [
      `_sep := "${sep}"`,
      '_r := ""',
      `LIST(${lookups}).forEach(_o:`,
      `  _r := _r + _sep + "OBJ" + _sep + _o.rid.whenMissing("SKIP") + "\\n"`,
      ...propLines,
      ')',
      `_r := _r + "${sep}DONE"`,
      '_r',
    ].join('\n');

    const ecResult = await this.executeEc(code);
    if (!ecResult.ok || !ecResult.log) return result;
    return parseSepMultiObject(ecResult.log, sep);
  }

  /** Fetch direct children of an object via EC */
  async fetchChildren(rid: string): Promise<Array<{ rid: string; name?: string; type?: string; businessId?: string }>> {
    const code = [
      `_o := lookup(${validateRid(rid)})`,
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

  /** Save a code property via EC */
  async saveCodeViaEc(rid: string, property: string, code: string): Promise<{ ok: boolean; error?: string }> {
    const escaped = code
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n');
    const ec = `_o := lookup(${validateRid(rid)})\n_o.change(${property} := "${escaped}")`;
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
