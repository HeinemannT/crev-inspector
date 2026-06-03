/**
 * Access trace (admin permission test) handlers.
 *
 * FETCH_ACCESS_SUBJECTS — list users + roles for the subject picker, plus a
 * best-effort capability flag. REQUEST_ACCESS_TRACE — run AccessTraceCommand
 * for a subject + action on an object, returning the PBAC decision tree.
 */
import { register } from '../handler-registry';
import { getCtx } from '../sw-context';
import { errorMessage } from '../logger';

register('FETCH_ACCESS_SUBJECTS', async (_msg, respond) => {
  const ctx = getCtx();
  if (!ctx.client) {
    respond({ type: 'ACCESS_SUBJECTS_DATA', subjects: [], canTrace: false, error: 'Not connected' });
    return;
  }
  try {
    const subjects = await ctx.client.listAccessSubjects();
    // Reading root.user / root.role needs config-level access — a reasonable
    // proxy for trace permission. A genuine rejection still surfaces on the
    // first trace (caught + shown there).
    respond({ type: 'ACCESS_SUBJECTS_DATA', subjects, canTrace: subjects.length > 0 });
  } catch (e) {
    respond({ type: 'ACCESS_SUBJECTS_DATA', subjects: [], canTrace: false, error: errorMessage(e) });
  }
});

register('REQUEST_ACCESS_TRACE', async (msg, respond) => {
  const ctx = getCtx();
  if (!ctx.client) {
    respond({ type: 'ACCESS_TRACE_RESULT', rid: msg.rid, node: null, error: 'Not connected' });
    return;
  }
  try {
    const node = await ctx.client.fetchAccessTrace(msg.rid, msg.subjectRid, msg.action);
    respond({ type: 'ACCESS_TRACE_RESULT', rid: msg.rid, node });
  } catch (e) {
    respond({ type: 'ACCESS_TRACE_RESULT', rid: msg.rid, node: null, error: errorMessage(e) });
  }
});
