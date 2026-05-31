/**
 * Diff overlay launcher — mounts diff/diff.html as an in-page frame
 * on the active tab via the shared frame-overlay primitive.
 */

import { launchFrame } from './frame-launcher';
import { log } from './logger';

export async function openDiffWindow(leftRid: string, rightRid?: string, mode?: 'template', target?: { tabId?: number; windowId?: number }) {
  try {
    await chrome.storage.local.set({
      crev_diff_ctx: { leftRid, rightRid, mode },
    });
  } catch (e) {
    log.swallow('diff:ctxStore', e);
  }
  const hash = rightRid ? `${leftRid},${rightRid}` : leftRid;
  await launchFrame({
    kind: 'diff',
    path: `diff/diff.html#${hash}`,
    label: rightRid ? 'Compare objects' : 'Compare with template',
    defaultWidth: 900,
    defaultHeight: 640,
    tabId: target?.tabId,
    windowId: target?.windowId,
  });
}
