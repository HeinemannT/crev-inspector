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

/** How a connection was actually established (the winning strategy), as opposed
 *  to how the profile is configured (`AuthMode`). Surfaced so the user can see
 *  whether they're connected as their browser self or via stored credentials. */
export type AuthVia = 'session' | 'password';

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

/** Outcome of one auth strategy in the chain.
 *  - `ok`   — got a JWT; `via` records how.
 *  - `skip` — strategy not applicable (no session to borrow / no creds set);
 *             the chain moves on with no error recorded.
 *  - `fail` — strategy was tried and failed; the chain remembers the error but
 *             KEEPS GOING so a later strategy can still succeed. */
type AuthAttempt =
  | { status: 'ok'; jwt: string; via: AuthVia }
  | { status: 'skip' }
  | { status: 'fail'; error: AuthError; via: AuthVia };

export class BmpAuth {
  private _jwt: string | null = null;
  private _refreshToken: string | null = null;
  private _loginTicket: string | null = null;
  private _loginPromise: Promise<string> | null = null;
  private _refreshPromise: Promise<string | null> | null = null;
  private _profileId: string;
  private _authMode: AuthMode;
  private _via: AuthVia | null = null;

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
  /** Run the auth strategies in order and return the first JWT. A strategy that
   *  `fail`s does NOT stop the chain — its error is remembered and the next
   *  strategy still runs. That's what lets `auto` fall back to the password
   *  when the borrowed session exists but lacks Configuration Access. Only when
   *  every strategy has skipped/failed do we surface a failure (the deepest
   *  one tried, which is the user's configured path when they set a password).
   *  The winning strategy's `via` is recorded for the UI. */
  private async _doLogin(): Promise<string> {
    const strategies: Array<() => Promise<AuthAttempt>> = [];
    if (this._authMode !== 'password') strategies.push(() => this._attemptSession());
    if (this._authMode !== 'session') strategies.push(() => this._attemptPassword());

    let deepestFailure: AuthError | null = null;
    for (const run of strategies) {
      const attempt = await run();
      if (attempt.status === 'ok') {
        this._via = attempt.via;
        return attempt.jwt;
      }
      if (attempt.status === 'fail') deepestFailure = attempt.error;
      // 'skip' → strategy not applicable; try the next one.
    }

    if (deepestFailure) throw deepestFailure;
    throw new AuthError('No active BMP session. Open BMP in a tab and log in, then retry.', 'needs-login');
  }

  /** Strategy: borrow the browser's live BMP session for this workspace.
   *  `skip` when there's no session to borrow (no cookie, or a stale one that
   *  the exchange rejects with 401) so the chain falls through to credentials;
   *  `fail` when the session is real but unusable (e.g. no Configuration
   *  Access) — recorded, but the chain still tries the password. */
  private async _attemptSession(): Promise<AuthAttempt> {
    let hasCookie = false;
    try {
      hasCookie = (await chrome.cookies.get({ url: this.bmpUrl, name: 'JSESSIONID' })) != null;
    } catch (e) {
      log.warn('auth:cookieGet', e, 'chrome.cookies.get failed; treating as no session');
    }
    if (!hasCookie) return { status: 'skip' };
    try {
      const jwt = await this._completeTokenExchange();
      if (jwt == null) return { status: 'skip' };  // stale session (401) — fall through
      return { status: 'ok', jwt, via: 'session' };
    } catch (e) {
      if (e instanceof AuthError) return { status: 'fail', error: e, via: 'session' };
      throw e;
    }
  }

  /** Strategy: bootstrap a session from stored credentials, then exchange.
   *  `skip` when the profile carries no credentials. */
  private async _attemptPassword(): Promise<AuthAttempt> {
    if (!this.bmpUser || !this.bmpPass) return { status: 'skip' };
    try {
      await this._passwordLogin();
      const jwt = await this._completeTokenExchange();
      if (jwt == null) {
        return { status: 'fail', error: new AuthError('Logged in but could not obtain a Configuration Studio token.', 'exchange-failed'), via: 'password' };
      }
      return { status: 'ok', jwt, via: 'password' };
    } catch (e) {
      if (e instanceof AuthError) return { status: 'fail', error: e, via: 'password' };
      throw e;
    }
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
      const saved = result[this._sessionKey] as { jwt: string; refreshToken: string; via?: AuthVia } | undefined;
      if (saved?.jwt) {
        this._jwt = saved.jwt;
        this._refreshToken = saved.refreshToken ?? null;
        this._via = saved.via ?? null;
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

  /** How the current session was actually established (null until a successful
   *  login). Survives refresh and SW restart because it's persisted with the
   *  token. Drives the "Connected via …" hint. */
  get via(): AuthVia | null { return this._via; }

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
    this._via = other._via;
    this._loginTicket = null; // Ticket is derived from JWT — re-derive on demand
    this._persistTokens();
  }

  /** Clear cached JWT and ticket */
  logout() {
    this._jwt = null;
    this._refreshToken = null;
    this._via = null;
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
    chrome.storage.session.set({ [this._sessionKey]: { jwt: this._jwt, refreshToken: this._refreshToken, via: this._via } }).catch(e => log.swallow('auth:persistTokens', e));
  }

  private _clearPersistedTokens() {
    chrome.storage.session.remove(this._sessionKey).catch(e => log.swallow('auth:clearTokens', e));
  }
}
