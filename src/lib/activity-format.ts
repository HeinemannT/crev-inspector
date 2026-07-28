import type { EcResult } from './bmp-client';
import type { ObjectReference } from './types';

const ACTIVITY_DETAIL_LIMIT = 4_000;

export function boundedActivityDetail(value: string | undefined): string | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  return text.length <= ACTIVITY_DETAIL_LIMIT
    ? text
    : `${text.slice(0, ACTIVITY_DETAIL_LIMIT)}\n… output truncated`;
}

/** Keep actual BMP output useful without copying noisy WARNING entries or source code into storage. */
export function ecActivityDetail(result: EcResult): string | undefined {
  const entries = result.outputEntries
    ?.filter(entry => entry.logType.toUpperCase() !== 'WARNING')
    .map(entry => `${entry.result ? 'RESULT' : entry.logType || 'OUTPUT'}: ${entry.message}`);
  if (entries?.length) return boundedActivityDetail(entries.join('\n'));
  // When BMP supplied structured entries, never fall back to the flattened
  // log: it would re-introduce warnings that were deliberately filtered.
  if (!result.ok) {
    return boundedActivityDetail(result.error || (result.outputEntries?.length ? undefined : result.log));
  }
  return undefined;
}

export function activityObject(
  rid: string,
  cached?: { businessId?: string; name?: string; type?: string },
): ObjectReference {
  return {
    rid,
    ...(cached?.businessId ? { businessId: cached.businessId } : {}),
    ...(cached?.name ? { name: cached.name } : {}),
    ...(cached?.type ? { type: cached.type } : {}),
  };
}

export function activityObjectLabel(object: ObjectReference | undefined, fallback: string): string {
  return object?.name || object?.businessId || fallback;
}
