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

    const lines = ecResult.log.trim().split('\n');
    const last = lines[lines.length - 1]?.trim();
    if (!last || last.startsWith('MISSING')) return { templateRid: null };

    const [tRid, ...rest] = last.split('|||');
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

    const lookups = valid.map(rid => `lookup(${rid})`).join(', ');
    const code = [
      '_d := "|||"',
      '_r := ""',
      `LIST(${lookups}).forEach(_o:`,
      '  _r := _r + _o.rid.whenMissing("SKIP") + _d + _o.id.whenMissing("") + _d + _o.className.whenMissing("") + _d + _o.name.whenMissing("") + "\\n"',
      ')',
      '_r',
    ].join('\n');

    const result = await this.executeEc(code, undefined, false);
    if (!result.ok) return { results: {}, error: result.error ?? 'EC execution failed' };
    if (result.log == null) return { results: {}, error: 'EC returned null output' };
    if (result.log.trim() === '') return { results: {} };

    const out: Record<string, { businessId?: string; type?: string; name?: string }> = {};
    for (const line of result.log.trim().split('\n')) {
      const parts = line.split('|||');
      if (parts.length < 4) continue;
      const [rid, bid, typ, ...rest] = parts;
      const name = rest.join('|||');
      if (rid && rid !== 'MISSING' && rid !== 'SKIP') {
        out[rid.trim()] = {
          businessId: bid?.trim() || undefined,
          type: typ?.trim() || undefined,
          name: name?.trim() || undefined,
        };
      }
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
    for (const prop of properties) {
      lines.push(`output("${sep}${prop}${sep}")`);
      lines.push(`output(_o.${prop}.whenMissing(""))`);
    }
    lines.push(`output("${sep}DONE")`);
    lines.push('0');
    const result = await this.executeEc(lines.join('\n'));
    if (!result.ok || !result.log) return {};

    const out: Record<string, string> = {};
    const parts = result.log.split(sep);
    for (let i = 1; i < parts.length; i += 2) {
      const propName = parts[i];
      if (propName === 'DONE') break;
      const value = (parts[i + 1] ?? '').replace(/^\n/, '').replace(/\n$/, '');
      if (value) out[propName] = value;
    }
    return out;
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
