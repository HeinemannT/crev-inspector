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
  ctx.favorites.toggle(msg.rid, { name: msg.name, type: msg.objectType, businessId: msg.businessId });
  respond({ type: 'FAVORITES_DATA', entries: ctx.favorites.getAll() });
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
