/**
 * Read-only probe for the identity signed into the BMP web portal.
 * Only `userName` is consumed; SPA access and refresh tokens are ignored.
 */

import type { EffectiveActor } from './identity-map';
import { AUTH_TIMEOUT } from './constants';
import { assertHostAccess } from './site-access';

function isConfirmedBmpLoginRedirect(responseUrl: string, bmpUrl: string): boolean {
  try {
    const finalUrl = new URL(responseUrl);
    const base = new URL(bmpUrl);
    if (finalUrl.origin !== base.origin) return false;
    const path = finalUrl.pathname.toLowerCase().replace(/\/+$/, '');
    return path.endsWith('/login')
      || path.endsWith('/signin')
      || path.endsWith('/cs/login');
  } catch {
    return false;
  }
}

export async function probePortalIdentity(bmpUrl: string): Promise<EffectiveActor> {
  try {
    await assertHostAccess(bmpUrl);
    const response = await fetch(`${bmpUrl}cs/authentication`, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      signal: AbortSignal.timeout(AUTH_TIMEOUT),
    });
    // 401 and a tested BMP login landing page are authoritative. A 403 can
    // mean authorization rather than absence, while proxy/canonical and
    // cross-origin redirects are ambiguous, so those remain transient.
    if (response.status === 401
      || (response.redirected && isConfirmedBmpLoginRedirect(response.url, bmpUrl))) {
      return { status: 'unavailable', user: null, source: 'portal-session', error: 'No active BMP portal login.' };
    }
    if (response.status === 403) {
      return { status: 'failed', user: null, source: 'portal-session', error: 'Portal identity check was forbidden (HTTP 403).' };
    }
    if (response.redirected) {
      try {
        if (new URL(response.url).origin !== new URL(bmpUrl).origin) {
          return { status: 'failed', user: null, source: 'portal-session', error: 'Portal identity check was redirected outside BMP.' };
        }
      } catch {
        return { status: 'failed', user: null, source: 'portal-session', error: 'Portal identity redirect could not be verified.' };
      }
    }
    if (!response.ok) {
      return {
        status: 'failed',
        user: null,
        source: 'portal-session',
        error: `Portal identity check failed (HTTP ${response.status}).`,
      };
    }
    const body = await response.json().catch(() => null) as { userName?: unknown } | null;
    const user = typeof body?.userName === 'string' ? body.userName.trim() : '';
    if (!user) {
      return {
        status: 'failed',
        user: null,
        source: 'portal-session',
        error: 'BMP returned no usable portal identity.',
      };
    }
    return { status: 'connected', user, source: 'portal-session' };
  } catch {
    return { status: 'failed', user: null, source: 'portal-session', error: 'Portal identity could not be checked.' };
  }
}
