/**
 * History, favorites, and activity handlers.
 */

import { register } from '../handler-registry';
import { getCtx } from '../sw-context';
import { getActivityLog } from '../activity';

register('GET_HISTORY', (msg, respond) => {
  respond({ type: 'HISTORY_DATA', entries: getCtx().history.getAll() });
}, true);

register('CLEAR_HISTORY', (msg, respond) => {
  getCtx().history.clear();
  respond({ type: 'HISTORY_DATA', entries: [] });
}, true);

register('TOGGLE_FAVORITE', (msg, respond) => {
  const ctx = getCtx();
  ctx.favorites.toggle(msg.rid, { name: msg.name, type: msg.objectType, businessId: msg.businessId });
  respond({ type: 'FAVORITES_DATA', entries: ctx.favorites.getAll() });
}, true);

register('GET_FAVORITES', (msg, respond) => {
  respond({ type: 'FAVORITES_DATA', entries: getCtx().favorites.getAll() });
}, true);

register('GET_ACTIVITY', (msg, respond) => {
  respond({ type: 'ACTIVITY_LOG', entries: getActivityLog() });
}, true);

register('GET_SCRIPT_HISTORY', (msg, respond) => {
  respond({ type: 'SCRIPT_HISTORY_DATA', entries: getCtx().scriptHistory.getAll() });
}, true);
