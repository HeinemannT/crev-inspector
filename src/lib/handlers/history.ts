/**
 * History, favorites, and activity handlers.
 *
 * All handlers are gated on settingsReady at the router level —
 * no per-handler .then() wrappers needed.
 */

import { register } from '../handler-registry';
import { getCtx } from '../sw-context';
import { getActivityLog } from '../activity';

register('GET_HISTORY', (msg, respond) => {
  respond({ type: 'HISTORY_DATA', entries: getCtx().history.getAll() });
});

register('CLEAR_HISTORY', (msg, respond) => {
  const ctx = getCtx();
  ctx.history.clear();
  respond({ type: 'HISTORY_DATA', entries: [] });
});

register('TOGGLE_FAVORITE', (msg, respond) => {
  const ctx = getCtx();
  // Snapshot pre-state so we can tell the user whether they pinned or unpinned —
  // toggle returns the new state but the activity log reads better as a verb.
  const wasPinned = ctx.favorites.getAll().some(f => f.rid === msg.rid);
  ctx.favorites.toggle(msg.rid, { name: msg.name, type: msg.objectType, businessId: msg.businessId });
  respond({ type: 'FAVORITES_DATA', entries: ctx.favorites.getAll() });
  const label = msg.name || msg.businessId || msg.rid;
  ctx.logActivity('info', wasPinned ? `Unpinned ${label}` : `Pinned ${label}`);
});

register('GET_FAVORITES', (msg, respond) => {
  respond({ type: 'FAVORITES_DATA', entries: getCtx().favorites.getAll() });
});

register('GET_ACTIVITY', (msg, respond) => {
  respond({ type: 'ACTIVITY_LOG', entries: getActivityLog() });
});

register('GET_SCRIPT_HISTORY', (msg, respond) => {
  respond({ type: 'SCRIPT_HISTORY_DATA', entries: getCtx().scriptHistory.getAll() });
});
