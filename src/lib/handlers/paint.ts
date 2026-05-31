/**
 * Paint format operation handlers.
 */

import { register } from '../handler-registry';
import { getCtx } from '../sw-context';
import { handlePaintPick, handlePaintApply, handlePaintConfirm } from '../paint';

register('PAINT_PICK', (msg) => {
  getCtx().logActivity('info', 'Paint: copying styles\u2026');
  handlePaintPick(msg.rid);
});

register('PAINT_APPLY', (msg) => {
  handlePaintApply(msg.rid);
});

register('PAINT_CONFIRM', (msg) => {
  handlePaintConfirm(msg.rid);
});
