/**
 * Code Search overlay launcher — mounts codesearch/codesearch.html as an
 * in-page frame on the active tab.
 */

import { launchFrame } from './frame-launcher';

export async function openCodeSearchWindow(target?: { tabId?: number; windowId?: number }) {
  await launchFrame({
    kind: 'codesearch',
    path: 'codesearch/codesearch.html',
    label: 'Code Search',
    defaultWidth: 820,
    defaultHeight: 620,
    tabId: target?.tabId,
    windowId: target?.windowId,
  });
}
