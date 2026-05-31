/**
 * Activity log — ring buffer persisted to local storage.
 *
 * Persisted to chrome.storage.local (NOT .session) so the feed survives a
 * browser restart. The user complaint "the log empties itself" was caused by
 * (a) the 50-entry cap (now 300, see constants.ts) and (b) session storage
 * being wiped on browser close. Local storage has a 10 MB quota; the ring
 * buffer caps at ~30 KB so cost is negligible.
 */

import type { ActivityEntry } from './types';
import { getCtx } from './sw-context';
import { debounce } from './util';
import { log } from './logger';
import { ACTIVITY_MAX, ACTIVITY_PERSIST_DELAY } from './constants';

const activityLog: ActivityEntry[] = [];
let activitySeq = 0;

const persistActivity = debounce(() => {
  chrome.storage.local.set({ crev_activity: { entries: activityLog, seq: activitySeq } }).catch(e => log.swallow('activity:persist', e));
}, ACTIVITY_PERSIST_DELAY);

/** Restore the activity log from local storage. One-time migration moves the
 *  old session-storage entries over for users upgrading from earlier builds. */
export async function restoreActivity(): Promise<void> {
  try {
    const session = await chrome.storage.session.get('crev_activity');
    if (session.crev_activity) {
      await chrome.storage.local.set({ crev_activity: session.crev_activity });
      await chrome.storage.session.remove('crev_activity');
    }
    const local = await chrome.storage.local.get('crev_activity');
    const saved = local.crev_activity as { entries: ActivityEntry[]; seq: number } | undefined;
    if (saved?.entries?.length) {
      activityLog.push(...saved.entries);
      activitySeq = saved.seq ?? saved.entries.length;
    }
  } catch (e) { log.swallow('activity:restore', e); }
}

export function logActivity(level: ActivityEntry['level'], message: string, detail?: string) {
  const ctx = getCtx();
  const profileId = ctx.settings?.activeProfileId || undefined;
  const entry: ActivityEntry = { id: ++activitySeq, time: Date.now(), level, message, detail, profileId };
  activityLog.push(entry);
  if (activityLog.length > ACTIVITY_MAX) activityLog.shift();
  ctx.sendToPanel({ type: 'ACTIVITY_ENTRY', entry });
  persistActivity();
}

/** Wipe everything. Called by the "Reset all state" affordance — see
 *  src/lib/handlers/objects.ts CLEAR_CACHE handler when invoked with
 *  scope === 'all'. */
export function clearActivityLog(): void {
  activityLog.length = 0;
  activitySeq = 0;
  chrome.storage.local.remove('crev_activity').catch(e => log.swallow('activity:clear', e));
}

export function getActivityLog(): ActivityEntry[] {
  return activityLog;
}
