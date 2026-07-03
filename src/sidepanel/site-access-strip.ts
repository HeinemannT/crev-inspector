/**
 * Server-access repair strip — appears only when a CONFIGURED profile's origin is missing its host
 * permission (fresh install after migration, a declined prompt, or a revoke via the browser's own
 * Site access settings). One click requests ALL missing profile origins in a single standard
 * browser prompt; after that it disappears and should stay gone.
 *
 * This is deliberately the only "grant" surface outside the profile form: access is derived from
 * the profiles the user already entered (grant on save, revoke on delete — see lib/site-access),
 * so there is no per-site ceremony and nothing to manage twice. The request itself MUST run here
 * in the panel, inside the click's user gesture — a hop to the service worker would drop the
 * gesture and the browser would reject the prompt.
 */
import { h, render, svg } from '../lib/dom';
import { ICON_WARNING } from '../lib/icons';
import { showToast } from '../lib/toast';
import { log } from '../lib/logger';
import { originPatternFor } from '../lib/site-access';
import { S, sendMessage } from './state';

const hostOf = (pattern: string): string => pattern.replace(/^[a-z]+:\/\//, '').replace(/\/\*$/, '');

/** Origin patterns of configured profiles that are NOT currently granted. */
async function missingProfileOrigins(): Promise<string[]> {
  const patterns = [...new Set(S.settings.profiles.map(p => originPatternFor(p.bmpUrl)).filter((p): p is string => !!p))];
  const missing: string[] = [];
  for (const origin of patterns) {
    try {
      if (!(await chrome.permissions.contains({ origins: [origin] }))) missing.push(origin);
    } catch (e) { log.swallow('siteStrip:contains', e); }
  }
  return missing;
}

/** Request `origins` inside the CURRENT user gesture, then let the SW sync registrations and boot
 *  the active tab if it just became accessible. Shared by the strip, the profile form's save, and
 *  the per-profile chip. Returns whether the user granted. */
export async function requestOriginsInGesture(origins: string[]): Promise<boolean> {
  if (!origins.length) return true;
  try {
    const granted = await chrome.permissions.request({ origins });
    if (granted) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }).catch(() => [] as chrome.tabs.Tab[]);
      const tabPattern = originPatternFor(tab?.url);
      sendMessage({ type: 'SITE_ACCESS_CHANGED', tabId: tabPattern && origins.includes(tabPattern) ? tab?.id : undefined });
    }
    void refreshSiteAccessStrip();
    return granted;
  } catch (e) {
    log.swallow('siteStrip:request', e);
    showToast('Permission request failed', 'error');
    return false;
  }
}

/** The (initially hidden) strip element — mounted once by buildApp, updated by refresh. */
export function renderSiteAccessStrip(): HTMLElement {
  // Live-track browser-side revokes/grants (chrome://extensions → Site access) while the panel is open.
  try {
    chrome.permissions.onAdded.addListener(() => { void refreshSiteAccessStrip(); });
    chrome.permissions.onRemoved.addListener(() => { void refreshSiteAccessStrip(); });
  } catch (e) { log.swallow('siteStrip:listeners', e); }
  return h('div', { class: 'site-strip hidden', id: 'site-access-strip' });
}

/** Re-evaluate and repaint the strip. Cheap; called on boot, on SETTINGS_DATA (profiles changed),
 *  and on permission grant/revoke events. */
export async function refreshSiteAccessStrip(): Promise<void> {
  const strip = document.getElementById('site-access-strip');
  if (!strip) return;
  const missing = await missingProfileOrigins();
  if (!missing.length) { strip.classList.add('hidden'); strip.textContent = ''; return; }
  const hosts = missing.map(hostOf);
  const label = missing.length === 1
    ? `CREV needs access to ${hosts[0]}`
    : `CREV needs access to ${missing.length} configured servers`;
  const btn = h('button', { class: 'site-strip-btn', title: `Opens the browser's standard permission prompt for: ${hosts.join(', ')}` }, 'Grant access');
  // The request must run directly in this click handler — the standard prompt requires the gesture.
  btn.addEventListener('click', () => {
    void requestOriginsInGesture(missing).then((granted) => {
      if (granted) showToast('Access granted — CREV is active on your servers', 'success');
    });
  });
  render(strip,
    h('span', { class: 'site-strip-ic', 'aria-hidden': 'true' }, svg(ICON_WARNING)),
    h('span', { class: 'site-strip-text', title: hosts.join(', ') }, label),
    btn,
  );
  strip.classList.remove('hidden');
}
