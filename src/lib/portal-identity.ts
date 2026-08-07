/**
 * Read-only probe for the identity signed into the BMP web portal.
 * Only `userName` is consumed; SPA access and refresh tokens are ignored.
 */

import type { EffectiveActor } from './identity-map';
import { AUTH_TIMEOUT } from './constants';
import { assertHostAccess } from './site-access';

export async function probePortalIdentity(bmpUrl: string): Promise<EffectiveActor> {
  try {
    await assertHostAccess(bmpUrl);
    const response = await fetch(`${bmpUrl}cs/authentication`, {
      method: 'GET',
      credentials: 'include',
      cache: 'no-store',
      signal: AbortSignal.timeout(AUTH_TIMEOUT),
    });
    if (response.status === 401 || response.status === 403 || response.redirected
      || (response.url && new URL(response.url).origin !== new URL(bmpUrl).origin)) {
      return { status: 'unavailable', user: null, source: 'portal-session', error: 'No active BMP portal login.' };
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
        status: 'unavailable',
        user: null,
        source: 'portal-session',
        error: 'BMP returned no signed-in portal user.',
      };
    }
    return { status: 'connected', user, source: 'portal-session' };
  } catch {
    return { status: 'failed', user: null, source: 'portal-session', error: 'Portal identity could not be checked.' };
  }
}
