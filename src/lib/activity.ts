/**
 * Activity log — ring buffer persisted to local storage.
 *
 * Persisted to chrome.storage.local (NOT .session) so the feed survives a
 * browser restart. The user complaint "the log empties itself" was caused by
 * (a) the 50-entry cap (now 300, see constants.ts) and (b) session storage
 * being wiped on browser close. Details are bounded before insertion and the
 * ring buffer remains comfortably below Chrome's local-storage quota.
 */

import type { ActivityEntry, ActivityMeta } from './types';
import { getCtx } from './sw-context';
import { debounce } from './util';
import { log } from './logger';
import { ACTIVITY_MAX, ACTIVITY_PERSIST_DELAY } from './constants';
import { currentCommandActor } from './command-actor';

const activityLog: ActivityEntry[] = [];
let activitySeq = 0;
const COMMAND_CHANGE_ACTIONS = new Set(['save-property', 'edit-object']);

function describesCommandWork(meta: ActivityMeta | undefined): boolean {
  if (!meta) return false;
  if (meta.category === 'execution'
    || meta.category === 'blueprint'
    || meta.category === 'paint'
    || meta.category === 'studio') return true;
  return meta.category === 'change' && Boolean(meta.action && COMMAND_CHANGE_ACTIONS.has(meta.action));
}

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

export function logActivity(level: ActivityEntry['level'], message: string, detail?: string, meta?: ActivityMeta) {
  const ctx = getCtx();
  const profileId = ctx.settings?.activeProfileId || undefined;
  const actor = currentCommandActor();
  const commandActivity = describesCommandWork(meta);
  const entry: ActivityEntry = {
    id: ++activitySeq,
    time: Date.now(),
    level,
    message,
    detail,
    profileId,
    ...(actor && commandActivity ? { commandActor: actor.user, commandAuthSource: actor.source } : {}),
    ...meta,
  };
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
