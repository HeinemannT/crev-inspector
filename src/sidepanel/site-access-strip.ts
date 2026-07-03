/**
 * Per-site access strip — the panel's gateway to Chrome's STANDARD permission prompt.
 *
 * The extension ships with no host permissions (optional_host_permissions only), so nothing runs
 * on any site until granted. This strip appears under the tab bar whenever access is missing for
 * (a) the active tab's origin — the page CREV would inspect — and/or (b) the active profile's BMP
 * server origin — which the service worker fetches (/cs/command, GraphQL) and needs even when it
 * differs from the page. One click fires `chrome.permissions.request` for exactly the missing
 * origins (the request MUST happen here, in the panel, inside the user gesture — a message hop to
 * the SW would drop the gesture and the prompt would be rejected), then tells the SW to sync the
 * dynamic content-script registrations and boot the already-open tab.
 */
import { h, render, svg } from '../lib/dom';
import { ICON_WARNING } from '../lib/icons';
import { showToast } from '../lib/toast';
import { log } from '../lib/logger';
import { originPatternFor } from '../lib/site-access';
import { S, sendMessage } from './state';

const hostOf = (pattern: string): string => pattern.replace(/^[a-z]+:\/\//, '').replace(/\/\*$/, '');

/** The active tab of THIS panel's window (side panels are per-window, so currentWindow is right). */
async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  try { return (await chrome.tabs.query({ active: true, currentWindow: true }))[0]; } catch { return undefined; }
}

/** Origin patterns currently missing: the active tab's, and the active profile's server. */
async function missingOrigins(): Promise<{ missing: string[]; tabId?: number; tabMissing: boolean }> {
  const tab = await activeTab();
  const tabPattern = originPatternFor(tab?.url);
  const profile = S.settings.profiles.find(p => p.id === S.settings.activeProfileId);
  const serverPattern = originPatternFor(profile?.bmpUrl);
  const candidates = [...new Set([tabPattern, serverPattern].filter((p): p is string => !!p))];
  const missing: string[] = [];
  for (const origin of candidates) {
    try {
      if (!(await chrome.permissions.contains({ origins: [origin] }))) missing.push(origin);
    } catch (e) { log.swallow('siteStrip:contains', e); }
  }
  return { missing, tabId: tab?.id, tabMissing: !!tabPattern && missing.includes(tabPattern) };
}

/** The (initially hidden) strip element — mounted once by buildApp, updated by refresh. */
export function renderSiteAccessStrip(): HTMLElement {
  return h('div', { class: 'site-strip hidden', id: 'site-access-strip' });
}

/** Re-evaluate and repaint the strip. Cheap; called on boot and on the panel messages that track
 *  tab switches (DETECTION_STATE / PAGE_INFO) + settings/profile changes. */
export async function refreshSiteAccessStrip(): Promise<void> {
  const strip = document.getElementById('site-access-strip');
  if (!strip) return;
  const { missing, tabId, tabMissing } = await missingOrigins();
  if (!missing.length) { strip.classList.add('hidden'); strip.textContent = ''; return; }
  const label = tabMissing
    ? `CREV is off on ${hostOf(missing[0])}`
    : `Server access needed: ${hostOf(missing[0])}`;
  const btn = h('button', { class: 'site-strip-btn', title: 'Opens Chrome’s standard permission prompt for this site' }, 'Enable');
  // The request must run directly in this click handler — the standard prompt requires the gesture.
  btn.addEventListener('click', () => {
    chrome.permissions.request({ origins: missing }).then((granted) => {
      if (granted) {
        sendMessage({ type: 'SITE_ACCESS_CHANGED', tabId });
        showToast('Access granted — CREV is now active here', 'success');
      }
      void refreshSiteAccessStrip();
    }).catch((e) => { log.swallow('siteStrip:request', e); showToast('Permission request failed', 'error'); });
  });
  render(strip,
    h('span', { class: 'site-strip-ic', 'aria-hidden': 'true' }, svg(ICON_WARNING)),
    h('span', { class: 'site-strip-text', title: missing.map(hostOf).join(', ') }, label),
    btn,
  );
  strip.classList.remove('hidden');
}
