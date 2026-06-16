/**
 * BMP authentication — 3-step web auth flow: session cookie → auth code → JWT.
 * Extracted from BmpClient for clarity.
 */

import { log } from './logger';
import { AUTH_TIMEOUT } from './constants';

/** How a profile obtains its BMP session.
 *  - `session`  — borrow the browser's existing JSESSIONID only (no creds).
 *  - `password` — POST stored username/password (the legacy Path B).
 *  - `auto`     — try session piggyback first, fall back to password. */
export type AuthMode = 'session' | 'password' | 'auto';

/** Auth failure with a machine-readable cause, so the connection layer can map
 *  it to a precise UI state instead of a generic "failed". */
export type AuthErrorCode =
  | 'needs-login'      // no session and no usable password — user must log into BMP
  | 'no-config-access' // session exists but the user lacks Configuration Access
  | 'auth-failed'      // wrong creds / server rejected
  | 'exchange-failed'; // session bootstrapped but token exchange didn't complete

export class AuthError extends Error {
  constructor(message: string, readonly code: AuthErrorCode) {
    super(message);
    this.name = 'AuthError';
  }
}

/** The one place the "how does this profile authenticate" rule lives: an
 *  explicit authMode wins; otherwise a stored password means session-first
 *  with password fallback ('auto'), and no password means session-only. Used
 *  by the client pool, the auth test, the settings migration, and the profile
 *  form so the rule can't drift between them. */
export function resolveAuthMode(p: { authMode?: AuthMode; bmpPass?: string }): AuthMode {
  return p.authMode ?? (p.bmpPass && p.bmpPass.trim() ? 'auto' : 'session');
}

export class BmpAuth {
  private _jwt: string | null = null;
  private _refreshToken: string | null = null;
  private _loginTicket: string | null = null;
  private _loginPromise: Promise<string> | null = null;
  private _refreshPromise: Promise<string | null> | null = null;
  private _profileId: string;
  private _authMode: AuthMode;

  constructor(
    private bmpUrl: string,
    private bmpUser: string,
    private bmpPass: string,
    profileId?: string,
    authMode: AuthMode = 'auto',
  ) {
    this._profileId = profileId ?? 'default';
    this._authMode = authMode;
  }

  private get _sessionKey(): string { return `crev_jwt_${this._profileId}`; }

  get jwt(): string | null { return this._jwt; }

  /** Login to BMP via web auth flow: session cookie → auth code → JWT.
   *  Concurrent calls are deduplicated — only one login flies at a time. */
  async login(): Promise<string> {
    if (this._loginPromise) return this._loginPromise;
    this._loginPromise = this._doLogin();
    try { return await this._loginPromise; }
    finally { this._loginPromise = null; }
  }

  /** Strategy chain. The token tail (GraphQL→cstoken) only ever needs a session
   *  cookie, never a password — so for an in-browser tool the primary path is to
   *  BORROW the user's existing browser session and only fall back to a password
   *  bootstrap when there's no session (or the profile is password-only). */
  private async _doLogin(): Promise<string> {
    const tryHarvest = this._authMode !== 'password';
    const tryPassword = this._authMode !== 'session' && !!this.bmpUser && !!this.bmpPass;

    // Strategy 1: piggyback on the live browser session.
    if (tryHarvest) {
      const jwt = await this._harvestSession();   // null = no usable session; throws on no-config-access
      if (jwt) return jwt;
    }

    // Strategy 2: bootstrap a session with stored credentials, then exchange.
    if (tryPassword) {
      await this._passwordLogin();
      const jwt = await this._completeTokenExchange();
      if (jwt) return jwt;
      throw new AuthError('Logged in but could not obtain a Configuration Studio token.', 'exchange-failed');
    }

    // Nothing available.
    if (tryHarvest) throw new AuthError('No active BMP session. Open BMP in a tab and log in, then retry.', 'needs-login');
    throw new AuthError('No credentials configured for this profile.', 'auth-failed');
  }

  /** Borrow the browser's JSESSIONID for this workspace and mint OUR OWN token
   *  chain from it. Returns null when there's no (usable) session so the chain
   *  can fall through to a password bootstrap. */
  private async _harvestSession(): Promise<string | null> {
    let hasCookie = false;
    try {
      const c = await chrome.cookies.get({ url: this.bmpUrl, name: 'JSESSIONID' });
      hasCookie = c != null;
    } catch (e) {
      log.warn('auth:cookieGet', e, 'chrome.cookies.get failed — falling through');
    }
    if (!hasCookie) return null;
    return this._completeTokenExchange();
  }

  /** The shared token tail: GraphQL authorizationCode → /cstoken exchange.
   *  The session cookie is carried by `credentials:'include'` (a manual Cookie
   *  header is a forbidden header and silently stripped by fetch — verified).
   *  Mints an INDEPENDENT refresh chain; never touches the SPA's token.
   *  Returns null when the session is missing/stale (GraphQL 401) so callers
   *  can fall back; throws AuthError('no-config-access') when the user is
   *  logged in but lacks the Configuration Access role. */
  private async _completeTokenExchange(): Promise<string | null> {
    const gqlResp = await fetch(`${this.bmpUrl}graphql`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: 'query AuthorizationCode { authorizationCode { code } }',
        variables: {},
        operationName: 'AuthorizationCode',
      }),
      signal: AbortSignal.timeout(AUTH_TIMEOUT),
    });

    if (gqlResp.status === 401) return null; // no / stale session
    if (!gqlResp.ok) throw new AuthError(`Authorization code request failed (HTTP ${gqlResp.status}). Check BMP URL.`, 'auth-failed');

    const gqlBody = await gqlResp.json().catch(() => null);
    const authCode = gqlBody?.data?.authorizationCode?.code;
    // Session is valid (200) but the provider returned no code → the user lacks
    // Configuration Access (AuthorizationCodeProvider.provide() → Optional.empty).
    if (!authCode) throw new AuthError('Logged into BMP, but this user lacks Configuration Access.', 'no-config-access');

    const tokenResp = await fetch(`${this.bmpUrl}cstoken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grantType=authorizationCode&authorizationCode=${encodeURIComponent(authCode)}`,
      signal: AbortSignal.timeout(AUTH_TIMEOUT),
    });

    if (!tokenResp.ok) throw new AuthError(`Token exchange failed: ${tokenResp.status}`, 'auth-failed');
    const tokenBody = await tokenResp.json();
    if (!tokenBody?.accessToken) throw new AuthError('No access token in response', 'auth-failed');

    this._jwt = tokenBody.accessToken;
    this._refreshToken = tokenBody.refreshToken ?? null;
    this._persistTokens();
    return this._jwt;
  }

  /** Bootstrap a web session from stored credentials (legacy Path B step 1).
   *  We no longer extract JSESSIONID manually — the cookie lands in the SW's
   *  cookie jar and `credentials:'include'` on the exchange carries it. */
  private async _passwordLogin(): Promise<void> {
    const body = `username=${encodeURIComponent(this.bmpUser)}&password=${encodeURIComponent(this.bmpPass)}`;
    const authResp = await fetch(`${this.bmpUrl}cs/authentication`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      credentials: 'include',
      redirect: 'manual',
      signal: AbortSignal.timeout(AUTH_TIMEOUT),
    });

    const isRedirect = authResp.type === 'opaqueredirect' || (authResp.status >= 300 && authResp.status < 400);

    // Cloud auth gateway answers with an opaqueredirect that hides the body but
    // still applies Set-Cookie to the jar; a plain follow-redirect POST ensures
    // the session cookie is committed before the exchange.
    if (isRedirect) {
      await fetch(`${this.bmpUrl}cs/authentication`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
        credentials: 'include',
        signal: AbortSignal.timeout(AUTH_TIMEOUT),
      }).then(r => r.text().catch(() => ''));
      return;
    }

    const authText = await authResp.text().catch(() => '');
    let authBody: Record<string, unknown> | null;
    try { authBody = JSON.parse(authText); } catch (e) { log.warn('auth:parseResp', e, 'response body was not JSON'); authBody = null; }

    if (authBody?.error === 'loginError.wrong_username_or_pwd') throw new AuthError('Wrong username or password', 'auth-failed');
    if (authBody?.error) throw new AuthError(authBody.error as string, 'auth-failed');
    if (!authResp.ok && !authBody?.userId) throw new AuthError(`Authentication failed (HTTP ${authResp.status}). Check URL, username, and password.`, 'auth-failed');
    if (!authBody?.userId) throw new AuthError('Authentication failed. Server did not return a user session.', 'auth-failed');
  }

  /** Try to refresh JWT using refresh token (1 request vs 3 for full login).
   *  Concurrent calls are deduplicated — only one refresh flies at a time. */
  async refreshAuth(): Promise<string | null> {
    if (!this._refreshToken) return null;
    if (this._refreshPromise) return this._refreshPromise;
    this._refreshPromise = this._doRefresh();
    try { return await this._refreshPromise; }
    finally { this._refreshPromise = null; }
  }

  private async _doRefresh(): Promise<string | null> {
    try {
      const resp = await fetch(`${this.bmpUrl}cstoken`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grantType=refreshToken&refreshToken=${encodeURIComponent(this._refreshToken!)}`,
        signal: AbortSignal.timeout(AUTH_TIMEOUT),
      });
      if (resp.status === 401 || resp.status === 403) { this._refreshToken = null; return null; }
      if (!resp.ok) return null;
      const body = await resp.json();
      if (!body?.accessToken) return null;
      this._jwt = body.accessToken;
      if (body.refreshToken) this._refreshToken = body.refreshToken;
      this._persistTokens();
      return this._jwt;
    } catch (e) {
      log.warn('auth:refresh', e, 'token refresh failed — will retry via full login');
      return null;
    }
  }

  /** Ensure valid JWT — restore from session, refresh, or full login */
  async ensureAuth(): Promise<string> {
    if (this._jwt) return this._jwt;
    if (await this.restoreFromSession()) return this._jwt!;
    return this.login();
  }

  /** Attempt to restore JWT from chrome.storage.session WITHOUT falling
   *  back to a fresh login. Returns true if restore succeeded.
   *  Used by the auth-test fast path so a freshly-pooled BmpClient (no
   *  in-memory JWT) can pick up its previously-persisted token before
   *  deciding whether to refresh or full-login. */
  async restoreFromSession(): Promise<boolean> {
    if (this._jwt) return true;
    try {
      const result = await chrome.storage.session.get(this._sessionKey);
      const saved = result[this._sessionKey] as { jwt: string; refreshToken: string } | undefined;
      if (saved?.jwt) {
        this._jwt = saved.jwt;
        this._refreshToken = saved.refreshToken ?? null;
        return true;
      }
    } catch (e) {
      log.warn('auth:restoreSession', e, 'session restore failed');
    }
    return false;
  }

  /** Username for this auth instance — exposed so the client pool can
   *  detect when a profile's username changed under the same profileId
   *  (and evict the stale pooled client). */
  get username(): string { return this.bmpUser; }

  /** Auth mode for this instance — exposed so the client pool can detect a
   *  mode change (session ↔ password ↔ auto) under the same profileId. */
  get authMode(): AuthMode { return this._authMode; }

  /** Update the credentials in-place. Used when the user edits a
   *  pooled profile's password — we keep the JWT (refresh-token flow
   *  handles password rotation cleanly) but record the new password
   *  so the next forced re-login picks it up. */
  updateCredentials(user: string, pass: string, authMode?: AuthMode): void {
    this.bmpUser = user;
    this.bmpPass = pass;
    if (authMode) this._authMode = authMode;
  }

  /** Copy auth state from another instance */
  absorbAuth(other: BmpAuth) {
    this._jwt = other._jwt;
    this._refreshToken = other._refreshToken;
    this._loginTicket = null; // Ticket is derived from JWT — re-derive on demand
    this._persistTokens();
  }

  /** Clear cached JWT and ticket */
  logout() {
    this._jwt = null;
    this._refreshToken = null;
    this._loginTicket = null;
    this._loginPromise = null;
    this._refreshPromise = null;
    this._clearPersistedTokens();
  }

  /** Invalidate current JWT and cached ticket (triggers re-auth on next request) */
  invalidateJwt() {
    this._jwt = null;
    this._loginTicket = null;
  }

  /** Exchange JWT for a LoginTicket string (cached — reused until JWT is invalidated).
   *  Needed for binary commands on BMP < 5.6.3 where JWT auth for /cs/command is broken. */
  async getLoginTicket(): Promise<string> {
    if (this._loginTicket) return this._loginTicket;
    const jwt = await this.ensureAuth();
    const res = await fetch(`${this.bmpUrl}ticket`, {
      headers: { 'Authorization': `Bearer ${jwt}` },
      signal: AbortSignal.timeout(AUTH_TIMEOUT),
    });
    if (!res.ok) throw new Error(`Failed to get login ticket: HTTP ${res.status}`);
    const ticket = await res.text();
    if (!ticket) throw new Error('Empty login ticket');
    this._loginTicket = ticket;
    return ticket;
  }

  private _persistTokens() {
    chrome.storage.session.set({ [this._sessionKey]: { jwt: this._jwt, refreshToken: this._refreshToken } }).catch(e => log.swallow('auth:persistTokens', e));
  }

  private _clearPersistedTokens() {
    chrome.storage.session.remove(this._sessionKey).catch(e => log.swallow('auth:clearTokens', e));
  }
}
