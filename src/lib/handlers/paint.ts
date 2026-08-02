/**
 * Paint format operation handlers.
 */

import { register } from '../handler-registry';
import { getCtx } from '../sw-context';
import { handlePaintPick, handlePaintApply } from '../paint';

register('PAINT_PICK', (msg) => {
  getCtx().logActivity('info', 'Paint: copying styles\u2026');
  handlePaintPick(msg.rid, msg.environment, true);
});

register('PAINT_APPLY', (msg) => {
  void handlePaintApply(msg.rid, msg.environment, true);
});
