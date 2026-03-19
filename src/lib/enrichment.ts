import type { BmpObject } from './types';
import { getCtx } from './sw-context';
import { pMap } from './util';
import { errorMessage } from './logger';
import { BATCH_CHUNK_SIZE, MAX_PARALLEL, ENRICHMENT_RETRY_DELAY, MAX_PERMANENTLY_FAILED } from './constants';

const enrichedRids = new Set<string>();
const permanentlyFailed = new Set<string>();
let enrichmentGeneration = 0;

type EnrichmentData = { businessId?: string; type?: string; name?: string };

/** Evict oldest entries from permanentlyFailed if over cap */
function capPermanentlyFailed() {
  if (permanentlyFailed.size <= MAX_PERMANENTLY_FAILED) return;
  const excess = permanentlyFailed.size - MAX_PERMANENTLY_FAILED;
  let count = 0;
  for (const rid of permanentlyFailed) {
    if (count >= excess) break;
    permanentlyFailed.delete(rid);
    count++;
  }
}

export function resetEnrichment() {
  enrichedRids.clear();
  permanentlyFailed.clear();
}

export function incrementGeneration() {
  enrichmentGeneration++;
  enrichedRids.clear();
  permanentlyFailed.clear();
}

export async function enrichBadges(rids: string[]) {
  const ctx = getCtx();
  if (!ctx.client) {
    ctx.logActivity('warn', 'Enrichment skipped — not connected');
    return;
  }

  const gen = enrichmentGeneration;
  const cancelled = () => gen !== enrichmentGeneration;

  const newRids = rids.map(r => r.trim()).filter(rid => rid && !enrichedRids.has(rid));
  if (newRids.length === 0) return;

  // Immediately broadcast empty enrichment for permanently-failed RIDs (so labels don't stay "loading")
  const alreadyFailed = newRids.filter(rid => permanentlyFailed.has(rid));
  if (alreadyFailed.length > 0) {
    const fail: Record<string, EnrichmentData> = {};
    for (const rid of alreadyFailed) fail[rid] = {};
    ctx.broadcastToContent({ type: 'BADGE_ENRICHMENT', enrichments: fail });
  }
  const toProcess = newRids.filter(rid => !permanentlyFailed.has(rid));

  // Phase 1: Send cache hits immediately (zero latency)
  const cacheHits: Record<string, EnrichmentData> = {};
  const uncached: string[] = [];

  for (const rid of toProcess) {
    const cached = ctx.cache.get(rid);
    if (cached?.businessId) {
      cacheHits[rid] = { businessId: cached.businessId, type: cached.type, name: cached.name };
      enrichedRids.add(rid);
    } else {
      uncached.push(rid);
    }
  }

  const cacheHitCount = Object.keys(cacheHits).length;

  if (cacheHitCount > 0) {
    ctx.broadcastToContent({ type: 'BADGE_ENRICHMENT', enrichments: cacheHits });
  }

  if (uncached.length === 0) {
    if (cacheHitCount > 0 || alreadyFailed.length > 0) {
      if (cacheHitCount > 0) ctx.logActivity('success', `Enriched ${cacheHitCount} (cached)`);
      ctx.sendToPanel({ type: 'CACHE_STATS', count: ctx.cache.size });
    }
    return;
  }

  // Enrichment mode: EC lookup() on 5.6.3+, binary GetObject on older versions
  const useEc = ctx.client.supportsLookup;

  ctx.logActivity('info', useEc
    ? `Enriching ${uncached.length} from server\u2026`
    : `Enriching ${uncached.length} via binary commands\u2026`);

  // Phase 2: Batch enrich — chunks of BATCH_CHUNK_SIZE, parallel with concurrency cap
  const failedRids: string[] = [];
  const batchFailedChunks: { chunk: string[]; errorMsg?: string }[] = [];
  let total = cacheHitCount;

  async function processChunk(chunk: string[], isCancelled: () => boolean): Promise<{ failed: string[]; batchError: boolean; errorMsg?: string }> {
    if (isCancelled()) return { failed: chunk, batchError: false };
    const failed: string[] = [];
    try {
      const { results: batchResults, error: batchError } = useEc
        ? await ctx.client!.batchEnrich(chunk)
        : await ctx.client!.batchEnrichBinary(chunk);
      if (isCancelled()) return { failed: chunk, batchError: false };
      if (batchError) {
        return { failed: chunk, batchError: true, errorMsg: batchError };
      }
      const chunkHits: Record<string, EnrichmentData> = {};
      const cacheObjs: BmpObject[] = [];
      const now = Date.now();
      for (const rid of chunk) {
        const data = batchResults[rid];
        if (data) {
          chunkHits[rid] = data;
          enrichedRids.add(rid);
          cacheObjs.push({ rid, businessId: data.businessId, type: data.type, name: data.name, source: 'server', discoveredAt: now, updatedAt: now });
          total++;
        } else {
          failed.push(rid);
        }
      }
      if (cacheObjs.length > 0 && !isCancelled()) {
        ctx.cache.putAll(cacheObjs);
        ctx.broadcastToContent({ type: 'BADGE_ENRICHMENT', enrichments: chunkHits });
      }
      return { failed, batchError: false };
    } catch (e) {
      return { failed: chunk, batchError: true, errorMsg: errorMessage(e) };
    }
  }

  const chunks: string[][] = [];
  for (let i = 0; i < uncached.length; i += BATCH_CHUNK_SIZE) {
    chunks.push(uncached.slice(i, i + BATCH_CHUNK_SIZE));
  }

  if (cancelled()) { ctx.logActivity('info', 'Enrichment cancelled (profile changed)'); return; }
  const chunkResults = await pMap(chunks, chunk => processChunk(chunk, cancelled), MAX_PARALLEL);

  for (let i = 0; i < chunkResults.length; i++) {
    const result = chunkResults[i];
    if (result.batchError) {
      batchFailedChunks.push({ chunk: chunks[i], errorMsg: result.errorMsg });
      ctx.logActivity('warn', `Batch failed: ${result.errorMsg ?? 'unknown error'}`);
    } else {
      failedRids.push(...result.failed);
    }
  }

  // Retry failed batch chunks once after a short delay (parallel)
  if (batchFailedChunks.length > 0 && !cancelled()) {
    const jitter = Math.random() * ENRICHMENT_RETRY_DELAY * 0.3;
    const retryDelay = ENRICHMENT_RETRY_DELAY + jitter;
    ctx.logActivity('info', `Retrying ${batchFailedChunks.length} failed batch(es) in ${Math.round(retryDelay / 1000)}s\u2026`);
    await new Promise(r => setTimeout(r, retryDelay));
    if (cancelled()) { ctx.logActivity('info', 'Enrichment cancelled (profile changed)'); return; }
    const retryResults = await pMap(
      batchFailedChunks,
      ({ chunk }) => processChunk(chunk, cancelled),
      MAX_PARALLEL,
    );
    for (let i = 0; i < retryResults.length; i++) {
      const result = retryResults[i];
      if (result.batchError) {
        for (const rid of batchFailedChunks[i].chunk) permanentlyFailed.add(rid);
        ctx.logActivity('warn', `Batch retry failed (${result.errorMsg ?? 'unknown'}) — ${batchFailedChunks[i].chunk.length} RIDs skipped`);
      } else {
        failedRids.push(...result.failed);
      }
    }
  }

  if (cancelled()) { ctx.logActivity('info', 'Enrichment cancelled (profile changed)'); return; }

  // Mark remaining failures as permanently failed (no Phase 3 binary fallback)
  for (const rid of failedRids) permanentlyFailed.add(rid);
  capPermanentlyFailed();

  // Broadcast empty enrichment for failed RIDs so content removes loading state
  if (failedRids.length > 0) {
    const failedEnrichments: Record<string, EnrichmentData> = {};
    for (const rid of failedRids) failedEnrichments[rid] = {};
    ctx.broadcastToContent({ type: 'BADGE_ENRICHMENT', enrichments: failedEnrichments });
  }

  ctx.logActivity('success', `Enriched ${total} object${total !== 1 ? 's' : ''}`);
  ctx.sendToPanel({ type: 'CACHE_STATS', count: ctx.cache.size });
}

/** Clear enrichment state and trigger re-enrichment on all connected tabs */
export function refreshEnrichment() {
  const ctx = getCtx();
  incrementGeneration();
  ctx.logActivity('info', 'Refreshing badge enrichment\u2026');
  ctx.broadcastToContent({ type: 'RE_ENRICH' });
}
