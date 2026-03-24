/**
 * History, favorites, and activity handlers.
 */

import { register } from '../handler-registry';
import { getCtx } from '../sw-context';
import { getActivityLog } from '../activity';

register('GET_HISTORY', (msg, respond) => {
  const ctx = getCtx();
  ctx.settingsReady.then(() => {
    respond({ type: 'HISTORY_DATA', entries: ctx.history.getAll() });
  });
}, true);

register('CLEAR_HISTORY', (msg, respond) => {
  const ctx = getCtx();
  ctx.settingsReady.then(() => {
    ctx.history.clear();
    respond({ type: 'HISTORY_DATA', entries: [] });
  });
}, true);

register('TOGGLE_FAVORITE', (msg, respond) => {
  const ctx = getCtx();
  ctx.settingsReady.then(() => {
    ctx.favorites.toggle(msg.rid, { name: msg.name, type: msg.objectType, businessId: msg.businessId });
    respond({ type: 'FAVORITES_DATA', entries: ctx.favorites.getAll() });
  });
}, true);

register('GET_FAVORITES', (msg, respond) => {
  const ctx = getCtx();
  ctx.settingsReady.then(() => {
    respond({ type: 'FAVORITES_DATA', entries: ctx.favorites.getAll() });
  });
}, true);

register('GET_ACTIVITY', (msg, respond) => {
  getCtx().settingsReady.then(() => {
    respond({ type: 'ACTIVITY_LOG', entries: getActivityLog() });
  });
}, true);

register('GET_SCRIPT_HISTORY', (msg, respond) => {
  const ctx = getCtx();
  ctx.settingsReady.then(() => {
    respond({ type: 'SCRIPT_HISTORY_DATA', entries: ctx.scriptHistory.getAll() });
  });
}, true);
