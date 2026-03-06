/**
 * Activity log — ring buffer persisted to session storage.
 */

import type { ActivityEntry } from './types';
import { getCtx } from './sw-context';
import { debounce } from './util';
import { log } from './logger';
import { ACTIVITY_MAX, ACTIVITY_PERSIST_DELAY } from './constants';

const activityLog: ActivityEntry[] = [];
let activitySeq = 0;

const persistActivity = debounce(() => {
  chrome.storage.session.set({ crev_activity: { entries: activityLog, seq: activitySeq } }).catch(e => log.swallow('activity:persist', e));
}, ACTIVITY_PERSIST_DELAY);

/** Restore activity log from session storage (survives SW kill) */
export async function restoreActivity(): Promise<void> {
  try {
    const session = await chrome.storage.session.get('crev_activity');
    const saved = session.crev_activity as { entries: ActivityEntry[]; seq: number } | undefined;
    if (saved?.entries?.length) {
      activityLog.push(...saved.entries);
      activitySeq = saved.seq ?? saved.entries.length;
    }
  } catch (e) { log.swallow('activity:restore', e); }
}

export function logActivity(level: ActivityEntry['level'], message: string, detail?: string) {
  const entry: ActivityEntry = { id: ++activitySeq, time: Date.now(), level, message, detail };
  activityLog.push(entry);
  if (activityLog.length > ACTIVITY_MAX) activityLog.shift();
  getCtx().sendToPanel({ type: 'ACTIVITY_ENTRY', entry });
  persistActivity();
}

export function getActivityLog(): ActivityEntry[] {
  return activityLog;
}
