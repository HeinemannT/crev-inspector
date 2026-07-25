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
import {
  CODE_SEARCH_BATCH_SIZE,
  CODE_SEARCH_RID_CAP_PER_TYPE,
  CODE_SEARCH_RID_CHUNK_SIZE,
} from './constants';
import { CODE_PROPS_FOR_TYPE, SCRIPT_PROPS } from './types';
import type { CodeSearchResult } from './types';
import { errorMessage, log } from './logger';
import { sendFireForget } from './messaging';
import type { BmpClient } from './bmp-client';
import { buildRowEc, identityRow, parseDelimitedRow, parseDelimitedLines } from './ec-row-codec';

/** Triple-pipe delimiter used by this file's identity-row EC (matches the
 *  convention `ec-parser.ts`/`handlers/objects.ts` use elsewhere). */
const PIPE3 = '|||';
const IDENTITY_FIELDS = ['rid', 'id', 'name', 'className'];
const SCAN_MARKER = '<<<CREV_CODE_SEARCH>>>';
const SCAN_DONE = `${SCAN_MARKER}DONE`;

/** Bumped on every start; in-flight loops capture and check it to
 *  short-circuit when superseded. Concurrent start+stop is safe. */
let activeGeneration = 0;

/** Last progress snapshot — so stopCodeSearch() can broadcast a final DONE
 *  (otherwise the panel's "searching" flag never clears: the in-flight loops
 *  bail on abort WITHOUT broadcasting done, leaving the Stop button stuck). */
let lastProgress = { results: 0, searched: 0, total: 0 };

interface ScopeInfo { rid: string; businessId: string; name: string; type: string; }
interface RidScanResult {
  rids: string[];
  total: number;
  truncated: boolean;
}
interface TypeSearchResult {
  results: CodeSearchResult[];
  warnings: string[];
}

/** Build the EC that resolves `ref` to its identity row for scope resolution.
 *  Exported so a golden test can lock the exact EC string in. */
export function buildScopeResolveEc(ref: string): string {
  return [
    `_o := ${ref}`,
    buildRowEc(identityRow('_o', { ridDefault: '"MISSING"' }), PIPE3),
  ].join('\n');
}

/** Parse the `buildScopeResolveEc` output into an identity row, or null when
 *  the object doesn't exist / the log carries no identity line. */
export function parseScopeResolveLog(ecLog: string): ScopeInfo | null {
  const line = ecLog.split('\n').map(l => l.trim()).find(l => l.includes(PIPE3));
  if (!line) return null;
  const row = parseDelimitedRow(line, IDENTITY_FIELDS, PIPE3);
  if (!row || !row.rid || row.rid === 'MISSING') return null;
  return { rid: row.rid, businessId: row.id || '', name: row.name || '', type: row.className || '' };
}

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
    try { ref = await client.resolveRef(trimmed); }
    catch (e) { throw new Error(`Scope resolution failed: ${errorMessage(e)}`); }
  } else if (/^[a-z]+\.[A-Za-z0-9_-]+$/.test(trimmed)) {
    ref = trimmed; // namespace.bid — already a valid, injection-safe EC accessor
  } else {
    return null;
  }
  const res = await client.executeEc(buildScopeResolveEc(ref), undefined, false);
  if (!res.ok) throw new Error(res.error || res.log || 'Scope resolution EC failed');
  if (res.hasWarning) throw new Error(res.error || 'Scope resolution returned warnings and may be incomplete');
  if (res.log == null) throw new Error('Scope resolution returned no result');
  const scope = parseScopeResolveLog(res.log);
  if (!scope) return null;
  return { ref, scope };
}

function broadcastScope(scope: ScopeInfo | null, error?: string): void {
  sendFireForget({ type: 'CODE_SEARCH_SCOPE', scope, error });
}

/** SELECT enumerations are class-indexed (~10 ms per type) so the
 *  parallel cap keeps a workspace-wide search responsive. BMP can
 *  occasionally return a warning-only or markerless response at this
 *  concurrency; executeRidScan proves completion and retries that read once. */
const MAX_ENUM_PARALLEL = 8;

export async function startCodeSearch(
  query: string,
  subtreeRid?: string,
  types?: string[],
  options: { caseSensitive?: boolean } = {},
): Promise<void> {
  const ctx = getCtx();
  await ctx.settingsReady;
  if (!ctx.client) {
    broadcastDone(0, 0, 'Code Search is not connected to BMP.');
    return;
  }
  if (!query.trim()) {
    broadcastDone(0, 0, 'Enter a search pattern.');
    return;
  }

  const myGen = ++activeGeneration;
  const aborted = () => myGen !== activeGeneration;

  const caseSensitive = options.caseSensitive ?? true;
  // Allowlist type names against the known code-bearing types — they
  // get interpolated into EC unescaped below, so untrusted input must
  // be filtered, not just escaped.
  const validTypes = new Set(Object.keys(CODE_PROPS_FOR_TYPE));
  const requestedTypes = types ?? [...validTypes];
  const invalidTypes = requestedTypes.filter(t => !validTypes.has(t));
  const searchTypes = requestedTypes.filter(t => validTypes.has(t));
  if (searchTypes.length === 0) {
    broadcastDone(0, 0, invalidTypes.length > 0
      ? `No searchable types remain. Unsupported: ${invalidTypes.join(', ')}.`
      : 'No searchable types selected.');
    return;
  }

  // Resolve the scope once; reuse for every per-type call. Accepts a numeric
  // RID or a namespace.bid ref (e.g. t.118). Surface the resolved object — or
  // a failure — to the panel instead of silently widening to workspace-wide.
  let subtreeRef: string | null = null;
  if (subtreeRid) {
    let resolved: Awaited<ReturnType<typeof resolveScope>>;
    try {
      resolved = await resolveScope(ctx.client, subtreeRid);
    } catch (e) {
      if (!aborted()) {
        const message = errorMessage(e);
        broadcastScope(null, message);
        broadcastDone(0, 0, message);
      }
      return;
    }
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
  const issues = invalidTypes.map(type => `Unsupported type: ${type}`);
  let typesDone = 0;
  lastProgress = { results: 0, searched: 0, total: searchTypes.length };

  const runOneType = async (typeName: string) => {
    if (aborted()) return;
    try {
      const typeResult = await searchOneType(
        ctx.client!,
        typeName,
        query.trim(),
        caseSensitive,
        subtreeRef,
        aborted,
      );
      if (aborted()) return;
      allResults.push(...typeResult.results);
      issues.push(...typeResult.warnings.map(warning => `${typeName}: ${warning}`));
    } catch (e) {
      const message = errorMessage(e);
      issues.push(`${typeName}: ${message}`);
      log.error('codeSearch:type', e);
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

  if (!aborted()) {
    const error = issues.length > 0
      ? `${allResults.length > 0 ? 'Partial results' : 'Code Search failed'}: ${summarizeIssues(issues, searchTypes.length)}`
      : undefined;
    broadcastDone(allResults.length, typesDone, error);
  }
}

/** Synchronous, broadcast-free code search — used by the AI `code_search`
 *  tool. Reuses the same per-type pipeline as the streaming engine but
 *  collects the results into a single array (capped) instead of streaming
 *  progress. Never throws: a connection / EC failure resolves to an empty
 *  result with `error` set so the caller can hand the model a readable string. */
export async function collectCodeSearch(
  query: string,
  opts: { types?: string[]; subtreeRid?: string; caseSensitive?: boolean; cap?: number } = {},
): Promise<{ results: CodeSearchResult[]; capped: boolean; error?: string }> {
  const ctx = getCtx();
  await ctx.settingsReady;
  if (!ctx.client) return { results: [], capped: false, error: 'Not connected to BMP' };
  if (!query.trim()) return { results: [], capped: false, error: 'Empty search pattern' };

  const cap = opts.cap ?? 30;
  const caseSensitive = opts.caseSensitive ?? true;
  const validTypes = new Set(Object.keys(CODE_PROPS_FOR_TYPE));
  const requestedTypes = opts.types ?? [...validTypes];
  const invalidTypes = requestedTypes.filter(t => !validTypes.has(t));
  const searchTypes = requestedTypes.filter(t => validTypes.has(t));
  if (searchTypes.length === 0) {
    return {
      results: [],
      capped: false,
      error: invalidTypes.length > 0
        ? `Unsupported searchable type(s): ${invalidTypes.join(', ')}`
        : 'No searchable types',
    };
  }

  let subtreeRef: string | null = null;
  if (opts.subtreeRid) {
    let resolved: Awaited<ReturnType<typeof resolveScope>>;
    try {
      resolved = await resolveScope(ctx.client, opts.subtreeRid);
    } catch (e) {
      return { results: [], capped: false, error: errorMessage(e) };
    }
    if (!resolved) return { results: [], capped: false, error: `Couldn't resolve scope "${opts.subtreeRid}"` };
    subtreeRef = resolved.ref;
  }

  const never = () => false;
  const all: CodeSearchResult[] = [];
  const issues = invalidTypes.map(type => `Unsupported type: ${type}`);
  for (let i = 0; i < searchTypes.length; i += MAX_ENUM_PARALLEL) {
    const batch = searchTypes.slice(i, i + MAX_ENUM_PARALLEL);
    const perType = await Promise.all(batch.map(async (t) => {
      try {
        const outcome = await searchOneType(ctx.client!, t, query.trim(), caseSensitive, subtreeRef, never);
        issues.push(...outcome.warnings.map(warning => `${t}: ${warning}`));
        return outcome.results;
      } catch (e) {
        issues.push(`${t}: ${errorMessage(e)}`);
        log.error('codeSearch:collect', e);
        return [] as CodeSearchResult[];
      }
    }));
    for (const r of perType) all.push(...r);
    if (all.length >= cap) break;
  }

  const capped = all.length > cap;
  return {
    results: capped ? all.slice(0, cap) : all,
    capped,
    ...(issues.length > 0 ? {
      error: `${all.length > 0 ? 'Partial results' : 'Code Search failed'}: ${summarizeIssues(issues, searchTypes.length)}`,
    } : {}),
  };
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
): Promise<TypeSearchResult> {
  // Narrow to candidate rids: server-side prefilter when we can
  // (case-sensitive), enumerate all and grep client-side when we
  // can't (EC has no .toLower()).
  const scan = caseSensitive
    ? await prefilterMatchedRids(client, typeName, query, subtreeRef)
    : await enumerateAllRids(client, typeName, subtreeRef);

  if (aborted() || scan.rids.length === 0) {
    return {
      results: [],
      warnings: scan.truncated
        ? [`scanned only ${scan.rids.length} of ${scan.total} objects; refine the search or use case-sensitive mode`]
        : [],
    };
  }

  const props = CODE_PROPS_FOR_TYPE[typeName] ?? [...SCRIPT_PROPS];
  const identity = await fetchIdentitiesForRids(client, scan.rids);
  if (aborted()) return { results: [], warnings: [] };

  const out: CodeSearchResult[] = [];

  for (let i = 0; i < scan.rids.length; i += CODE_SEARCH_BATCH_SIZE) {
    if (aborted()) break;
    const batchRids = scan.rids.slice(i, i + CODE_SEARCH_BATCH_SIZE);
    const codeMap = await client.batchFetchCode(batchRids, [...props]);
    for (const rid of batchRids) {
      const codeProps = codeMap.get(rid);
      if (!codeProps) continue;
      const objectIdentity = identity.objects.get(rid) ?? { name: '', businessId: '' };
      for (const [propName, code] of Object.entries(codeProps)) {
        if (!code) continue;
        const matchingLines = searchInCode(code, query, caseSensitive);
        if (matchingLines.length > 0) {
          out.push({
            rid,
            name: objectIdentity.name,
            type: typeName,
            businessId: objectIdentity.businessId,
            property: propName,
            matchingLines,
          });
        }
      }
    }
  }
  const warnings: string[] = [];
  if (scan.truncated) {
    warnings.push(caseSensitive
      ? `more than ${scan.rids.length} matching objects; results are capped (type contains ${scan.total} objects)`
      : `scanned only ${scan.rids.length} of ${scan.total} objects; refine the search or use case-sensitive mode`);
  }
  if (identity.missing > 0) warnings.push(`identity metadata missing for ${identity.missing} object(s)`);
  return { results: out, warnings };
}

/** Server-side prefilter: EC walks every instance of `typeName` and
 *  emits the rids whose code props contain `query`. Returns rids
 *  only — body inlining hits EC's string concatenation ceiling. */
async function prefilterMatchedRids(
  client: BmpClient,
  typeName: string,
  query: string,
  subtreeRef: string | null,
): Promise<RidScanResult> {
  const safeQuery = escapeEcString(query);
  // Queries with \r\n can't be safely embedded in EC string literals;
  // fall back to client-side grep instead of silently mangling.
  if (safeQuery == null) return enumerateAllRids(client, typeName, subtreeRef);

  return executeRidScan(client, buildRidScanEc(typeName, subtreeRef, safeQuery));
}

/** Enumerate every instance of `typeName` — used by the
 *  case-insensitive path and as the prefilter fallback for queries
 *  that contain characters we can't embed in an EC string literal. */
async function enumerateAllRids(
  client: BmpClient,
  typeName: string,
  subtreeRef: string | null,
): Promise<RidScanResult> {
  return executeRidScan(client, buildRidScanEc(typeName, subtreeRef));
}

/** Build a bounded RID scan with explicit completion metadata. `query` is
 *  already escaped for an EC string literal; omitted means enumerate all.
 *  Exported so tests can lock the safety markers and chunking contract. */
export function buildRidScanEc(
  typeName: string,
  subtreeRef: string | null,
  query?: string,
): string {
  const props = CODE_PROPS_FOR_TYPE[typeName] ?? [...SCRIPT_PROPS];
  const collection = subtreeRef
    ? `SELECT ${typeName} FROM ${subtreeRef}`
    : `SELECT ${typeName} FROM root`;

  const propChecks = query == null ? [] : props.flatMap(prop => [
    `     _v_raw_${prop} := output(_o.${prop})`,
    `     _v_${prop} := _v_raw_${prop}.whenMissing("")`,
    `     _idx_raw_${prop} := _v_${prop}.indexOf(_q)`,
    `     _idx_${prop} := _idx_raw_${prop}.whenMissing(-1)`,
    `     IF _idx_${prop} >= 0 THEN`,
    '          _hit := TRUE',
    '     ENDIF',
  ]);

  return [
    ...(query == null ? [] : [`_q := "${query}"`]),
    `_list := ${collection}`,
    '_total := _list.size()',
    `_r := "${SCAN_MARKER}START\\n"`,
    '_chunk := ""',
    '_chunkCount := 0',
    '_seen := 0',
    '_emitted := 0',
    '_list.forEach(_o:',
    `     _hit := ${query == null ? 'TRUE' : 'FALSE'}`,
    ...propChecks,
    '     IF _hit THEN',
    '          _seen := _seen + 1',
    `          IF _emitted < ${CODE_SEARCH_RID_CAP_PER_TYPE} THEN`,
    '               _rid := _o.rid.whenMissing("")',
    '               _chunk := _chunk + _rid + "\\n"',
    '               _chunkCount := _chunkCount + 1',
    '               _emitted := _emitted + 1',
    `               IF _chunkCount >= ${CODE_SEARCH_RID_CHUNK_SIZE} THEN`,
    '                    _r := _r + _chunk',
    '                    _chunk := ""',
    '                    _chunkCount := 0',
    '               ELSE',
    '                    _r := _r',
    '               ENDIF',
    '          ENDIF',
    '     ENDIF',
    ')',
    '_r := _r + _chunk',
    `_r := _r + "${SCAN_MARKER}STATS|" + str(_total) + "|" + str(_seen) + "|" + str(_emitted) + "\\n"`,
    `_r := _r + "${SCAN_DONE}"`,
    '_r',
  ].join('\n');
}

/** Parse and validate a bounded RID scan. A missing DONE marker means BMP
 *  truncated/overflowed the accumulator or returned unrelated log noise. */
export function parseRidScanLog(raw: string): RidScanResult {
  if (!raw.includes(SCAN_DONE)) throw new Error('RID scan returned an incomplete result (completion marker missing)');
  const statsLine = raw.split('\n').map(line => line.trim())
    .find(line => line.startsWith(`${SCAN_MARKER}STATS|`));
  if (!statsLine) throw new Error('RID scan returned no statistics');
  const [, totalRaw, seenRaw, emittedRaw] = statsLine.slice(SCAN_MARKER.length).split('|');
  const total = Number(totalRaw);
  const seen = Number(seenRaw);
  const emitted = Number(emittedRaw);
  if (![total, seen, emitted].every(Number.isSafeInteger) || total < 0 || seen < 0 || emitted < 0) {
    throw new Error('RID scan returned invalid statistics');
  }
  const rids = parseRidLines(raw);
  if (rids.length !== emitted) {
    throw new Error(`RID scan expected ${emitted} row(s), received ${rids.length}`);
  }
  return { rids, total, truncated: seen > emitted };
}

async function executeRidScan(client: BmpClient, ec: string): Promise<RidScanResult> {
  let lastError = 'RID scan failed';
  // A read-only retry is safe. BMP occasionally yields a warning-only or
  // markerless EC response when several class scans finish together; accept
  // the retry only if it independently carries the full completion contract.
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await client.executeEc(ec);
    // Auth, HTTP, timeout and parser failures are already definitive and
    // actionable. Retrying them multiplies the same error across every type.
    if (!result.ok) throw new Error(result.error || result.log || 'RID scan EC failed');
    try {
      if (result.hasWarning) throw new Error(result.error || 'RID scan returned warnings and may be incomplete');
      if (result.log == null) throw new Error('RID scan returned no result');
      return parseRidScanLog(result.log);
    } catch (e) {
      lastError = errorMessage(e);
    }
  }
  throw new Error(`${lastError} (failed twice)`);
}

/** Enrich the matched rids with name + businessId. Chunked so the
 *  generated EC script stays small enough for BMP to parse cleanly. */
const IDENTITY_FETCH_CHUNK = 50;
async function fetchIdentitiesForRids(
  client: BmpClient,
  rids: string[],
): Promise<{ objects: Map<string, { name: string; businessId: string }>; missing: number }> {
  const out = new Map<string, { name: string; businessId: string }>();
  if (rids.length === 0) return { objects: out, missing: 0 };
  for (let i = 0; i < rids.length; i += IDENTITY_FETCH_CHUNK) {
    const chunk = rids.slice(i, i + IDENTITY_FETCH_CHUNK);
    await fetchIdentityChunk(client, chunk, out);
  }
  return { objects: out, missing: rids.length - out.size };
}

/** Build the per-entry EC lines for `fetchIdentityChunk`: one `_o := <ref>`
 *  read plus a `rid|||bid|||name` row appended to the shared `_r`
 *  accumulator. `rid` is the caller's known-good rid (interpolated as an EC
 *  string literal), not re-read from the object — cheaper and avoids a
 *  `.rid` access on a resolveRef() that may have raced. Exported so a golden
 *  test can lock the row shape in. */
export function buildIdentityChunkRowLines(rid: string, ref: string): string[] {
  return [
    `_o := ${ref}`,
    `_bid := _o.id.whenMissing("")`,
    `_name := _o.name.whenMissing("")`,
    `_r := _r + ${buildRowEc([{ name: 'rid', expr: `"${rid}"` }, { name: 'bid', expr: '_bid' }, { name: 'name', expr: '_name' }], PIPE3)} + "\\n"`,
  ];
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
  if (valid.length === 0) throw new Error('Could not resolve any identity RID in the batch');

  const lines = ['_r := ""'];
  for (const { rid, ref } of valid) {
    lines.push(...buildIdentityChunkRowLines(rid, ref));
  }
  lines.push('_r');
  const ec = lines.join('\n');

  const result = await client.executeEc(ec);
  if (!result.ok) throw new Error(result.error || result.log || 'Identity fetch EC failed');
  if (result.hasWarning) throw new Error(result.error || 'Identity fetch returned warnings and may be incomplete');
  if (result.log == null) throw new Error('Identity fetch returned no result');
  for (const row of parseDelimitedLines(result.log, ['rid', 'businessId', 'name'], PIPE3)) {
    if (!row.rid) continue;
    out.set(row.rid, { name: row.name, businessId: row.businessId });
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

/** Collapse identical per-type failures into one readable banner. */
export function summarizeIssues(issues: string[], totalTypes: number): string {
  const grouped = new Map<string, string[]>();
  for (const issue of issues) {
    const split = issue.indexOf(': ');
    if (split <= 0) {
      grouped.set(issue, grouped.get(issue) ?? []);
      continue;
    }
    const type = issue.slice(0, split);
    const message = issue.slice(split + 2);
    const types = grouped.get(message) ?? [];
    types.push(type);
    grouped.set(message, types);
  }
  return [...grouped.entries()].map(([message, types]) => {
    if (types.length === 0) return message;
    if (types.length === totalTypes) return `All ${totalTypes} types: ${message}`;
    if (types.length > 3) return `${types.length} types (${types.slice(0, 3).join(', ')}, …): ${message}`;
    return `${types.join(', ')}: ${message}`;
  }).join('; ');
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
