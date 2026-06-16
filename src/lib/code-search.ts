/**
 * Code search engine — runs in the service worker.
 *
 * Search flow per type:
 *   1. Enumerate with `SELECT <Type> FROM root` (or `FROM <subtreeRef>`)
 *      — class-indexed, ~10 ms regardless of workspace size.
 *   2. Case-sensitive queries: a server-side prefilter EC walks each
 *      instance, checks every code property with `indexOf(_q) >= 0`,
 *      and emits ONLY the matched rids. Case-insensitive falls back
 *      to "enumerate all, fetch all, grep client-side" because EC
 *      has no `.toLower()`.
 *   3. Fetch identity + code bodies for the matched rids (chunked).
 *   4. Client-side line-by-line grep for highlight context.
 *
 * EC quirks that shape the design (verified live, do not "simplify"):
 *   - String concatenation has a ~500-1000 char ceiling per operand;
 *     longer concats turn the accumulator into MISSING. We emit rids
 *     only (≈20 bytes/match), never code bodies, from EC.
 *   - Method chaining inside forEach parse-errors. Every
 *     `output(x).whenMissing("")` is split into per-step temp vars.
 *
 * Concurrency: `activeGeneration` is bumped on every start. In-flight
 * loops capture their generation and bail when it moves on, so a new
 * search auto-supersedes the previous one without an explicit STOP
 * (chrome.runtime.sendMessage is not FIFO across calls, so a
 * STOP-then-START dance would race).
 *
 * Security: type names from the panel are validated against
 * `CODE_PROPS_FOR_TYPE` before interpolation, so a compromised panel
 * can't inject arbitrary EC.
 */

import { getCtx } from './sw-context';
import { CODE_SEARCH_BATCH_SIZE } from './constants';
import { CODE_PROPS_FOR_TYPE, SCRIPT_PROPS } from './types';
import type { CodeSearchResult } from './types';
import { log } from './logger';
import { sendFireForget } from './messaging';
import type { BmpClient } from './bmp-client';

/** Bumped on every start; in-flight loops capture and check it to
 *  short-circuit when superseded. Concurrent start+stop is safe. */
let activeGeneration = 0;

/** Last progress snapshot — so stopCodeSearch() can broadcast a final DONE
 *  (otherwise the panel's "searching" flag never clears: the in-flight loops
 *  bail on abort WITHOUT broadcasting done, leaving the Stop button stuck). */
let lastProgress = { results: 0, searched: 0, total: 0 };

interface ScopeInfo { rid: string; businessId: string; name: string; type: string; }

/** Resolve the search scope from a user string: a numeric RID or a
 *  namespace.bid ref (e.g. `t.118`, `ceiss.bar`). Returns the EC ref to scope
 *  the SELECT (FROM <ref>) plus the resolved object's identity for the UI, or
 *  null if the input is malformed or the object doesn't exist. The ref shape
 *  is validated before interpolation so it can't inject EC. */
async function resolveScope(
  client: NonNullable<ReturnType<typeof getCtx>['client']>,
  input: string,
): Promise<{ ref: string; scope: ScopeInfo } | null> {
  const trimmed = input.trim();
  let ref: string;
  if (/^-?\d+$/.test(trimmed)) {
    try { ref = await client.resolveRef(trimmed); } catch { return null; }
  } else if (/^[a-z]+\.[A-Za-z0-9_-]+$/.test(trimmed)) {
    ref = trimmed; // namespace.bid — already a valid, injection-safe EC accessor
  } else {
    return null;
  }
  const ec = [
    `_o := ${ref}`,
    '_o.rid.whenMissing("MISSING") + "|||" + _o.id.whenMissing("") + "|||" + _o.name.whenMissing("") + "|||" + _o.className.whenMissing("")',
  ].join('\n');
  const res = await client.executeEc(ec, undefined, false);
  if (!res.ok || !res.log) return null;
  const line = res.log.split('\n').map(l => l.trim()).find(l => l.includes('|||'));
  if (!line) return null;
  const [rid, businessId, name, type] = line.split('|||');
  if (!rid || rid === 'MISSING') return null;
  return { ref, scope: { rid, businessId: businessId || '', name: name || '', type: type || '' } };
}

function broadcastScope(scope: ScopeInfo | null, error?: string): void {
  sendFireForget({ type: 'CODE_SEARCH_SCOPE', scope, error });
}

/** SELECT enumerations are class-indexed (~10 ms per type) so the
 *  parallel cap is generous but finite — keeps BMP's EC queue
 *  unsaturated for other clients. */
const MAX_ENUM_PARALLEL = 8;

export async function startCodeSearch(
  query: string,
  subtreeRid?: string,
  types?: string[],
  options: { caseSensitive?: boolean } = {},
): Promise<void> {
  const ctx = getCtx();
  await ctx.settingsReady;
  if (!ctx.client) return;
  if (!query.trim()) return;

  const myGen = ++activeGeneration;
  const aborted = () => myGen !== activeGeneration;

  const caseSensitive = options.caseSensitive ?? true;
  // Allowlist type names against the known code-bearing types — they
  // get interpolated into EC unescaped below, so untrusted input must
  // be filtered, not just escaped.
  const validTypes = new Set(Object.keys(CODE_PROPS_FOR_TYPE));
  const searchTypes = (types ?? [...validTypes]).filter(t => validTypes.has(t));
  if (searchTypes.length === 0) {
    broadcastDone(0, 0);
    return;
  }

  // Resolve the scope once; reuse for every per-type call. Accepts a numeric
  // RID or a namespace.bid ref (e.g. t.118). Surface the resolved object — or
  // a failure — to the panel instead of silently widening to workspace-wide.
  let subtreeRef: string | null = null;
  if (subtreeRid) {
    const resolved = await resolveScope(ctx.client, subtreeRid);
    if (aborted()) return;
    if (!resolved) {
      broadcastScope(null, `Couldn't resolve scope "${subtreeRid}". Use a numeric RID or namespace.bid (e.g. t.118).`);
      broadcastDone(0, 0);
      return;
    }
    subtreeRef = resolved.ref;
    broadcastScope(resolved.scope);
  } else {
    broadcastScope(null);
  }

  const allResults: CodeSearchResult[] = [];
  let typesDone = 0;
  lastProgress = { results: 0, searched: 0, total: searchTypes.length };

  const runOneType = async (typeName: string) => {
    if (aborted()) return;
    try {
      const typeResults = await searchOneType(
        ctx.client!,
        typeName,
        query.trim(),
        caseSensitive,
        subtreeRef,
        aborted,
      );
      if (aborted()) return;
      allResults.push(...typeResults);
    } catch (e) {
      log.swallow('codeSearch:type', e);
    }
    typesDone++;
    if (!aborted()) {
      lastProgress = { results: allResults.length, searched: typesDone, total: searchTypes.length };
      sendFireForget({
        type: 'CODE_SEARCH_PROGRESS',
        results: [...allResults],
        searched: typesDone,
        total: searchTypes.length,
      });
    }
  };

  for (let i = 0; i < searchTypes.length; i += MAX_ENUM_PARALLEL) {
    if (aborted()) return;
    const batch = searchTypes.slice(i, i + MAX_ENUM_PARALLEL);
    await Promise.all(batch.map(runOneType));
  }

  if (!aborted()) broadcastDone(allResults.length, typesDone);
}

export function stopCodeSearch(): void {
  // Supersede in-flight loops (they bail on the next aborted() check) AND tell
  // the panel we're done — otherwise its "searching" flag never clears and the
  // Stop button stays stuck. Partial results already shown via PROGRESS stay.
  activeGeneration++;
  broadcastDone(lastProgress.results, lastProgress.searched);
}

// ── Per-type search pipeline ─────────────────────────────────────

async function searchOneType(
  client: BmpClient,
  typeName: string,
  query: string,
  caseSensitive: boolean,
  subtreeRef: string | null,
  aborted: () => boolean,
): Promise<CodeSearchResult[]> {
  // Narrow to candidate rids: server-side prefilter when we can
  // (case-sensitive), enumerate all and grep client-side when we
  // can't (EC has no .toLower()).
  const rids = caseSensitive
    ? await prefilterMatchedRids(client, typeName, query, subtreeRef)
    : await enumerateAllRids(client, typeName, subtreeRef);

  if (aborted() || rids.length === 0) return [];

  const props = CODE_PROPS_FOR_TYPE[typeName] ?? [...SCRIPT_PROPS];
  const identityMap = await fetchIdentitiesForRids(client, rids);
  if (aborted()) return [];

  const out: CodeSearchResult[] = [];

  for (let i = 0; i < rids.length; i += CODE_SEARCH_BATCH_SIZE) {
    if (aborted()) break;
    const batchRids = rids.slice(i, i + CODE_SEARCH_BATCH_SIZE);
    let codeMap: Map<string, Record<string, string>>;
    try {
      codeMap = await client.batchFetchCode(batchRids, [...props]);
    } catch (e) {
      log.swallow('codeSearch:batchFetchCode', e);
      continue;
    }
    for (const rid of batchRids) {
      const codeProps = codeMap.get(rid);
      if (!codeProps) continue;
      const identity = identityMap.get(rid) ?? { name: '', businessId: '' };
      for (const [propName, code] of Object.entries(codeProps)) {
        if (!code) continue;
        const matchingLines = searchInCode(code, query, caseSensitive);
        if (matchingLines.length > 0) {
          out.push({
            rid,
            name: identity.name,
            type: typeName,
            businessId: identity.businessId,
            property: propName,
            matchingLines,
          });
        }
      }
    }
  }
  return out;
}

/** Server-side prefilter: EC walks every instance of `typeName` and
 *  emits the rids whose code props contain `query`. Returns rids
 *  only — body inlining hits EC's string concatenation ceiling. */
async function prefilterMatchedRids(
  client: BmpClient,
  typeName: string,
  query: string,
  subtreeRef: string | null,
): Promise<string[]> {
  const props = CODE_PROPS_FOR_TYPE[typeName] ?? [...SCRIPT_PROPS];
  const safeQuery = escapeEcString(query);
  // Queries with \r\n can't be safely embedded in EC string literals;
  // fall back to client-side grep instead of silently mangling.
  if (safeQuery == null) return enumerateAllRids(client, typeName, subtreeRef);

  const propChecks = props.map(prop => [
    `     _v_raw_${prop} := output(_o.${prop})`,
    `     _v_${prop} := _v_raw_${prop}.whenMissing("")`,
    `     _idx_raw_${prop} := _v_${prop}.indexOf(_q)`,
    `     _idx_${prop} := _idx_raw_${prop}.whenMissing(-1)`,
    `     IF _idx_${prop} >= 0 THEN`,
    `          _hit := TRUE`,
    `     ENDIF`,
  ].join('\n')).join('\n');

  const collection = subtreeRef
    ? `SELECT ${typeName} FROM ${subtreeRef}`
    : `SELECT ${typeName} FROM root`;

  const ec = [
    `_q := "${safeQuery}"`,
    `_list := ${collection}`,
    '_r := ""',
    '_list.forEach(_o:',
    '     _hit := FALSE',
    propChecks,
    '     IF _hit THEN',
    '          _rid := _o.rid.whenMissing("")',
    '          _r := _r + _rid + "\\n"',
    '     ENDIF',
    ')',
    '_r',
  ].join('\n');

  try {
    const result = await client.executeEc(ec);
    if (!result.ok || !result.log) return [];
    return parseRidLines(result.log);
  } catch (e) {
    log.swallow('codeSearch:prefilter', e);
    return [];
  }
}

/** Enumerate every instance of `typeName` — used by the
 *  case-insensitive path and as the prefilter fallback for queries
 *  that contain characters we can't embed in an EC string literal. */
async function enumerateAllRids(
  client: BmpClient,
  typeName: string,
  subtreeRef: string | null,
): Promise<string[]> {
  const collection = subtreeRef
    ? `SELECT ${typeName} FROM ${subtreeRef}`
    : `SELECT ${typeName} FROM root`;

  const ec = [
    `_list := ${collection}`,
    '_r := ""',
    '_list.forEach(_o:',
    '     _rid := _o.rid.whenMissing("")',
    '     _r := _r + _rid + "\\n"',
    ')',
    '_r',
  ].join('\n');

  try {
    const result = await client.executeEc(ec);
    if (!result.ok || !result.log) return [];
    return parseRidLines(result.log);
  } catch (e) {
    log.swallow('codeSearch:enumerateAll', e);
    return [];
  }
}

/** Enrich the matched rids with name + businessId. Chunked so the
 *  generated EC script stays small enough for BMP to parse cleanly. */
const IDENTITY_FETCH_CHUNK = 50;
async function fetchIdentitiesForRids(
  client: BmpClient,
  rids: string[],
): Promise<Map<string, { name: string; businessId: string }>> {
  const out = new Map<string, { name: string; businessId: string }>();
  if (rids.length === 0) return out;
  for (let i = 0; i < rids.length; i += IDENTITY_FETCH_CHUNK) {
    const chunk = rids.slice(i, i + IDENTITY_FETCH_CHUNK);
    await fetchIdentityChunk(client, chunk, out);
  }
  return out;
}

async function fetchIdentityChunk(
  client: BmpClient,
  rids: string[],
  out: Map<string, { name: string; businessId: string }>,
): Promise<void> {
  const refs = await Promise.all(
    rids.map(rid => client.resolveRef(rid).then(r => ({ rid, ref: r })).catch(() => null)),
  );
  const valid = refs.filter((r): r is { rid: string; ref: string } => r !== null);
  if (valid.length === 0) return;

  const lines = ['_r := ""'];
  for (const { rid, ref } of valid) {
    lines.push(`_o := ${ref}`);
    lines.push(`_bid := _o.id.whenMissing("")`);
    lines.push(`_name := _o.name.whenMissing("")`);
    lines.push(`_r := _r + "${rid}|||" + _bid + "|||" + _name + "\\n"`);
  }
  lines.push('_r');
  const ec = lines.join('\n');

  try {
    const result = await client.executeEc(ec);
    if (!result.ok || !result.log) return;
    for (const line of result.log.split('\n')) {
      if (!line.includes('|||')) continue;
      const [rid, businessId, name] = line.split('|||');
      if (!rid) continue;
      out.set(rid.trim(), { name: (name ?? '').trim(), businessId: (businessId ?? '').trim() });
    }
  } catch (e) {
    log.swallow('codeSearch:fetchIdentityChunk', e);
  }
}

// ── Helpers ──────────────────────────────────────────────────────

/** Escape a query for embedding in an EC double-quoted string literal.
 *  Returns null for queries that contain a raw newline (no EC escape
 *  sequence we trust); caller falls back to client-side grep. */
function escapeEcString(s: string): string | null {
  if (/[\r\n]/.test(s)) return null;
  return s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function parseRidLines(raw: string): string[] {
  return raw
    .split('\n')
    .map(s => s.trim().replace(/^Result\s*:\s*/i, ''))
    .filter(s => /^-?\d+$/.test(s));
}

function searchInCode(
  code: string,
  query: string,
  caseSensitive: boolean,
): Array<{ lineNum: number; text: string }> {
  const fold = caseSensitive ? (s: string) => s : (s: string) => s.toLowerCase();
  const needle = fold(query);
  // /\r?\n/ tolerates Windows line endings without leaving stray \r.
  const lines = code.split(/\r?\n/);
  const matches: Array<{ lineNum: number; text: string }> = [];
  for (let i = 0; i < lines.length; i++) {
    if (fold(lines[i]).includes(needle)) matches.push({ lineNum: i + 1, text: lines[i] });
  }
  return matches;
}

function broadcastDone(totalResults: number, totalSearched: number, error?: string): void {
  sendFireForget({ type: 'CODE_SEARCH_DONE', totalResults, totalSearched, error });
}
