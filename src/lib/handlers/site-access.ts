/**
 * Per-site access handler. The PANEL fires chrome.permissions.request itself (the standard Chrome
 * prompt needs a user gesture in an extension page) and then tells the SW the world changed; this
 * handler re-syncs the dynamic content-script registrations and boots the freshly-granted tab so
 * the user doesn't have to reload it (registered scripts only apply to future page loads).
 */
import { register } from '../handler-registry';
import { getCtx } from '../sw-context';
import { syncRegisteredScripts, injectIntoTab } from '../site-access';
import { sendPageInfoToPanel } from '../content-script-injection';

register('SITE_ACCESS_CHANGED', async (msg) => {
  await syncRegisteredScripts();
  if (msg.tabId != null) {
    await injectIntoTab(msg.tabId);
    getCtx().logActivity('success', 'Site access granted — CREV enabled on this tab');
    // Detection + Page tab refresh now that the content script is live.
    setTimeout(() => sendPageInfoToPanel(msg.tabId), 300);
  }
});
