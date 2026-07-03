/**
 * Per-site access management. The extension ships with NO host permissions: nothing is injected
 * anywhere until the user grants a site through Chrome's standard permission prompt
 * (`chrome.permissions.request`, fired from the side panel — a request must come from a user
 * gesture in an extension page). This replaces the old `<all_urls>` static content scripts, which
 * ran the observer + MAIN-world interceptor on EVERY site and visibly hurt DOM-heavy apps
 * (Google Maps was the reported casualty).
 *
 * For each granted origin the two content scripts are REGISTERED dynamically
 * (`chrome.scripting.registerContentScripts`, persistent across restarts) so future loads of that
 * site behave exactly like the old static injection: content.js at document_idle (ISOLATED) and
 * interceptor.js at document_start (MAIN world). Grants and revocations (chrome://extensions →
 * site settings) are observed via `permissions.onAdded/onRemoved` and re-synced.
 *
 * The panel requests the prompt itself; the SW's job (this module) is registry sync + the
 * first-time injection into the already-open tab that was just granted.
 */
import { log } from './logger';

const CONTENT_ID = 'crev-content';
const INTERCEPTOR_ID = 'crev-interceptor';

/** `https://host/*` match pattern for a page URL — null for non-http(s) schemes. */
export function originPatternFor(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.origin}/*`;
  } catch { return null; }
}

/** All granted host patterns (the optional_host_permissions the user has approved). */
export async function grantedOrigins(): Promise<string[]> {
  try {
    const all = await chrome.permissions.getAll();
    return all.origins ?? [];
  } catch { return []; }
}

/** Re-derive the dynamic content-script registrations from the granted origins. Idempotent —
 *  called at SW boot and on every permission grant/revoke. Unregister-then-register keeps the
 *  logic trivially correct (the set is tiny; churn is a no-op for the running pages). */
export async function syncRegisteredScripts(): Promise<void> {
  const origins = await grantedOrigins();
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [CONTENT_ID, INTERCEPTOR_ID] });
    if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: existing.map(s => s.id) });
  } catch (e) { log.swallow('siteAccess:unregister', e); }
  if (!origins.length) return;
  try {
    await chrome.scripting.registerContentScripts([
      { id: CONTENT_ID, js: ['content.js'], matches: origins, runAt: 'document_idle', persistAcrossSessions: true },
      { id: INTERCEPTOR_ID, js: ['interceptor.js'], matches: origins, runAt: 'document_start', world: 'MAIN', persistAcrossSessions: true },
    ]);
  } catch (e) { log.swallow('siteAccess:register', e); }
}

/** First-time injection into an already-open tab right after its origin was granted — the
 *  registered scripts only cover FUTURE page loads. Mirrors the static pair. */
export async function injectIntoTab(tabId: number): Promise<void> {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['interceptor.js'], world: 'MAIN' });
  } catch (e) { log.swallow('siteAccess:injectInterceptor', e); }
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch (e) { log.swallow('siteAccess:injectContent', e); }
}

/** Wire the permission listeners + reconcile at boot. Called once from the service worker. */
export function initSiteAccess(): void {
  try {
    chrome.permissions.onAdded.addListener(() => { void syncRegisteredScripts(); });
    chrome.permissions.onRemoved.addListener(() => { void syncRegisteredScripts(); });
  } catch (e) { log.swallow('siteAccess:listeners', e); }
  void syncRegisteredScripts();
}
