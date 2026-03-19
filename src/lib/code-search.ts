/**
 * Code search engine — runs in the service worker.
 * Two-phase approach: enumerate targets by type via EC, then fetch and search code in batches.
 */

import { getCtx } from './sw-context';
import { CODE_SEARCH_BATCH_SIZE } from './constants';
import { CODE_PROPS_FOR_TYPE, SCRIPT_PROPS } from './types';
import type { CodeSearchResult, InspectorMessage } from './types';
import { log } from './logger';

let searchAborted = false;

interface SearchTarget {
  rid: string;
  name: string;
  businessId: string;
  type: string;
}

const MAX_ENUM_PARALLEL = 4;

export async function startCodeSearch(
  query: string,
  subtreeRid?: string,
  types?: string[],
): Promise<void> {
  const ctx = getCtx();
  await ctx.settingsReady;
  if (!ctx.client) return;

  searchAborted = false;

  const searchTypes = types ?? Object.keys(CODE_PROPS_FOR_TYPE);
  const allTargets: SearchTarget[] = [];

  // Phase 1: Enumerate targets by type (parallel, capped at MAX_ENUM_PARALLEL)
  const enumFns = searchTypes.map(typeName => () => enumerateType(ctx.client!, typeName, subtreeRid));

  for (let i = 0; i < enumFns.length; i += MAX_ENUM_PARALLEL) {
    if (searchAborted) break;
    const batch = enumFns.slice(i, i + MAX_ENUM_PARALLEL);
    const results = await Promise.all(batch.map(fn => fn()));
    for (const targets of results) allTargets.push(...targets);
  }

  if (searchAborted) return;

  const total = allTargets.length;
  const allResults: CodeSearchResult[] = [];
  let searched = 0;

  // Phase 2: Batch fetch code and search
  // Group targets by property set for efficient batching
  const byProps = new Map<string, SearchTarget[]>();
  for (const t of allTargets) {
    const props = CODE_PROPS_FOR_TYPE[t.type] ?? [...SCRIPT_PROPS];
    const key = [...props].join(',');
    if (!byProps.has(key)) byProps.set(key, []);
    byProps.get(key)!.push(t);
  }

  for (const [propKey, targets] of byProps) {
    const properties = propKey.split(',');

    for (let i = 0; i < targets.length; i += CODE_SEARCH_BATCH_SIZE) {
      if (searchAborted) break;

      const batch = targets.slice(i, i + CODE_SEARCH_BATCH_SIZE);
      const rids = batch.map(t => t.rid);

      try {
        const codeMap = await ctx.client!.batchFetchCode(rids, properties);

        for (const target of batch) {
          const props = codeMap.get(target.rid);
          if (props) {
            for (const [propName, code] of Object.entries(props)) {
              if (!code) continue;
              const matchingLines = searchInCode(code, query);
              if (matchingLines.length > 0) {
                allResults.push({
                  rid: target.rid,
                  name: target.name,
                  type: target.type,
                  businessId: target.businessId,
                  property: propName,
                  matchingLines,
                });
              }
            }
          }
          searched++;
        }
      } catch (e) {
        log.swallow('codeSearch:batchFetch', e);
        searched += batch.length;
      }

      // Send progress
      if (!searchAborted) {
        broadcastToSearchPages({
          type: 'CODE_SEARCH_PROGRESS',
          results: [...allResults],
          searched,
          total,
        });
      }
    }
  }

  // Done
  if (!searchAborted) {
    broadcastToSearchPages({
      type: 'CODE_SEARCH_DONE',
      totalResults: allResults.length,
      totalSearched: searched,
    });
  }
}

export function stopCodeSearch(): void {
  searchAborted = true;
}

async function enumerateType(
  client: import('./bmp-client').BmpClient,
  typeName: string,
  subtreeRid?: string,
): Promise<SearchTarget[]> {
  const rootExpr = subtreeRid ? `lookup(${subtreeRid})` : 'root';
  const lines = ['_r := ""'];
  if (subtreeRid) {
    lines.push(`_root := ${rootExpr}`);
    lines.push('IF _root != MISSING THEN');
    lines.push(`  _root.allDescendants().filter(_o: _o.className == "${typeName}").forEach(_o:`);
  } else {
    lines.push(`${rootExpr}.allDescendants().filter(_o: _o.className == "${typeName}").forEach(_o:`);
  }
  lines.push(`  _r := _r + _o.rid.whenMissing("SKIP") + "|||" + _o.id.whenMissing("") + "|||" + _o.name.whenMissing("") + "\\n"`);
  lines.push(')');
  if (subtreeRid) lines.push('ENDIF');
  lines.push('_r');
  const ec = lines.join('\n');

  try {
    const result = await client.executeEc(ec);
    if (!result.ok || !result.log) return [];

    const targets: SearchTarget[] = [];
    for (const line of result.log.trim().split('\n')) {
      if (!line.includes('|||')) continue;
      const [rid, businessId, name] = line.split('|||');
      if (!rid || rid === 'SKIP') continue;
      targets.push({ rid: rid.trim(), name: name?.trim() ?? '', businessId: businessId?.trim() ?? '', type: typeName });
    }
    return targets;
  } catch (e) {
    log.swallow('codeSearch:enumerate', e);
    return [];
  }
}

function searchInCode(code: string, query: string): Array<{ lineNum: number; text: string }> {
  const lowerQuery = query.toLowerCase();
  const lines = code.split('\n');
  const matches: Array<{ lineNum: number; text: string }> = [];

  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(lowerQuery)) {
      matches.push({ lineNum: i + 1, text: lines[i] });
    }
  }

  return matches;
}

function broadcastToSearchPages(msg: InspectorMessage) {
  // Send to all extension pages (codesearch windows will pick it up)
  chrome.runtime.sendMessage(msg).catch(() => {
    // No listeners — expected if search page was closed
  });
}
