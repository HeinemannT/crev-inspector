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
  ctx.favorites.toggle(msg.rid, {
    name: msg.name,
    type: msg.objectType,
    businessId: msg.businessId,
    templateBusinessId: msg.templateBusinessId,
  });
  respond({ type: 'FAVORITES_DATA', entries: ctx.favorites.getAll() });
  const label = msg.name || msg.businessId || msg.rid;
  ctx.logActivity('info', wasPinned ? `Unpinned ${label}` : `Pinned ${label}`, undefined, {
    category: 'change',
    action: wasPinned ? 'unpin' : 'pin',
    object: {
      rid: msg.rid,
      ...(msg.name ? { name: msg.name } : {}),
      ...(msg.businessId ? { businessId: msg.businessId } : {}),
      ...(msg.objectType ? { type: msg.objectType } : {}),
    },
  });
});

register('GET_FAVORITES', (msg, respond) => {
  respond({ type: 'FAVORITES_DATA', entries: getCtx().favorites.getAll() });
});

// ── Saved style presets (blueprint paintbrush library) ───────────
register('LIST_STYLE_PRESETS', (msg, respond) => {
  respond({ type: 'STYLE_PRESETS_DATA', presets: getCtx().stylePresets.getAll() });
});

register('SAVE_STYLE_PRESET', (msg, respond) => {
  const ctx = getCtx();
  const saved = ctx.stylePresets.save(msg.name, msg.style);
  respond({ type: 'STYLE_PRESETS_DATA', presets: ctx.stylePresets.getAll() });
  if (saved) ctx.logActivity('info', `Saved style "${saved.name}"`, undefined, {
    category: 'change', action: 'save-style-preset',
  });
});

register('DELETE_STYLE_PRESET', (msg, respond) => {
  const ctx = getCtx();
  ctx.stylePresets.remove(msg.id);
  respond({ type: 'STYLE_PRESETS_DATA', presets: ctx.stylePresets.getAll() });
});

register('GET_ACTIVITY', (msg, respond) => {
  respond({ type: 'ACTIVITY_LOG', entries: getActivityLog() });
});

register('GET_SCRIPT_HISTORY', (msg, respond) => {
  respond({ type: 'SCRIPT_HISTORY_DATA', entries: getCtx().scriptHistory.getAll() });
});
