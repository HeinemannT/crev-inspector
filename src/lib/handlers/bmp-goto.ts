/**
 * BMP_GOTO — in-place BMP navigation. Forwards to the content script on the
 * target tab, which clicks the matching tab button (no page reload) and then
 * scroll-and-highlights the target widget.
 *
 * Used by the Extended Code editor's "navigate the BMP tab to this object"
 * action. (It was also used by the now-removed graph view.) Routes to a
 * specific `bmpTabId` when provided, otherwise the active/last-focused tab.
 */
import { register } from '../handler-registry';

register('BMP_GOTO', async (msg) => {
  const tabId = msg.bmpTabId ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id;
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, msg).catch(() => { /* content script not injected */ });
});
