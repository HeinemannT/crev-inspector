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

/** Resolve the BMP tab to act on: an explicit bmpTabId, else the active tab in
 *  the last-focused window (where the docked side panel lives). */
async function resolveBmpTab(bmpTabId?: number): Promise<number | undefined> {
  return bmpTabId ?? (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id;
}

register('BMP_GOTO', async (msg) => {
  const tabId = await resolveBmpTab(msg.bmpTabId);
  if (tabId == null) return;
  chrome.tabs.sendMessage(tabId, msg).catch(() => { /* content script not injected */ });
});

// BMP_OPEN_OBJECT — load a top-level object's own page in the BMP portal by
// rewriting the tab URL's ?rid= param. A card/scorecard/page isn't a widget on
// the current page, so BMP_GOTO's highlight does nothing for it; this navigates.
register('BMP_OPEN_OBJECT', async (msg) => {
  const tabId = await resolveBmpTab(msg.bmpTabId);
  if (tabId == null) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url) return;
    const url = new URL(tab.url);
    url.searchParams.set('rid', msg.rid);
    url.searchParams.delete('tabrid'); // land on the object's default tab
    await chrome.tabs.update(tabId, { url: url.toString() });
  } catch { /* tab gone / not a navigable URL */ }
});

// RELOAD_BMP_TAB — hard-reload the BMP tab so a committed (but DOM-invisible)
// property/colour/style edit becomes visible. Same tab resolution as BMP_GOTO.
register('RELOAD_BMP_TAB', async (msg) => {
  const tabId = await resolveBmpTab(msg.bmpTabId);
  if (tabId == null) return;
  chrome.tabs.reload(tabId).catch(() => { /* tab gone */ });
});
