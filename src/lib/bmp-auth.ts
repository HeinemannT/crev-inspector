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

/** chrome.storage.session key holding a profile's minted token chain. Exported
 *  so the cookie-teardown can clear it for a profile that has no pooled client. */
export function sessionTokenKey(profileId: string): string {
  return `crev_jwt_${profileId}`;
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

/** When several strategies fail, surface the most diagnostic cause rather than
 *  whichever failed last. `no-config-access` (an authenticated identity reached
 *  BMP but lacks the role) and `auth-failed` (bad credentials) both pinpoint a
 *  fixable cause; `exchange-failed`/`needs-login` are vaguer. */
const ERROR_RANK: Record<AuthErrorCode, number> = {
  'no-config-access': 3,
  'auth-failed': 2,
  'exchange-failed': 1,
  'needs-login': 0,
};
function mostDiagnostic(prev: AuthError | null, next: AuthError): AuthError {
  if (!prev) return next;
  return ERROR_RANK[next.code] > ERROR_RANK[prev.code] ? next : prev;
}

export class BmpAuth {
  private _jwt: string | null = null;
  private _refreshToken: string | null = null;
  private _loginTicket: string | null = null;
  private _loginPromise: Promise<string> | null = null;
  private _refreshPromise: Promise<string | null> | null = null;
  private _recoveryPromise: Promise<string> | null = null;
  private _ticketPromise: Promise<string> | null = null;
  private _ticketRecoveryPromise: Promise<string> | null = null;
  private _restorePromise: Promise<boolean> | null = null;
  private _sessionLoaded = false;
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

  private get _sessionKey(): string { return sessionTokenKey(this._profileId); }

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

    let failure: AuthError | null = null;
    for (const run of strategies) {
      const attempt = await run();
      if (attempt.status === 'ok') {
        this._via = attempt.via;
        return attempt.jwt;
      }
      if (attempt.status === 'fail') failure = mostDiagnostic(failure, attempt.error);
      // 'skip' → strategy not applicable; try the next one.
    }

    if (failure) throw failure;
    throw new AuthError('No active BMP session. Open BMP in a tab and log in, then retry.', 'needs-login');
  }

  /** Strategy: borrow the browser's live BMP session for this workspace by trying the
   *  token exchange directly — no cookie precheck. The exchange itself classifies the
   *  session: `skip` when there's none or it's stale (graphql 401, or an SSO redirect
   *  to the IdP → `_completeTokenExchange` returns null) so the chain falls through to
   *  credentials; `fail` when the session is real but unusable (e.g. no Configuration
   *  Access) — recorded, but the chain still tries the password. A cookie precheck
   *  here was both redundant with that classification and wrong for SSO (the session
   *  cookie isn't necessarily "JSESSIONID"); the only cost of dropping it is one
   *  graphql round-trip when there's no session, which simply 401s. */
  private async _attemptSession(): Promise<AuthAttempt> {
    try {
      const jwt = await this._completeTokenExchange('session');
      if (jwt == null) return { status: 'skip' };  // no / stale session — fall through
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
      const jwt = await this._completeTokenExchange('password');
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
   *  logged in but lacks the Configuration Access role. `via` records how the
   *  session was obtained and is set BEFORE the token is persisted, so the
   *  stored blob carries the correct `via` from the very first login. */
  private async _completeTokenExchange(via: AuthVia): Promise<string | null> {
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

    // SSO/login-redirect guard. An SSO-fronted BMP can answer /graphql with a 302 to
    // its identity provider instead of a 401; fetch (redirect:'follow') chases it to
    // an HTML login page that returns 200, so the only trace is the response being
    // `redirected` or ending on another origin. Treat that as "no usable Config
    // Studio session" and fall through — never as an auth code. Without this the HTML
    // body yields no code and we'd wrongly report "no Configuration Access". Guarded
    // so a normal same-origin, in-place response is untouched.
    if (gqlResp.redirected === true) return null;
    if (gqlResp.url && !this._isBmpOrigin(gqlResp.url)) return null;

    if (!gqlResp.ok) throw new AuthError(`Authorization code request failed (HTTP ${gqlResp.status}). Check BMP URL.`, 'auth-failed');

    const gqlBody = await gqlResp.json().catch(() => null);
    // Only a genuine graphql envelope (has a `data` key) may signal "no Configuration
    // Access" (data.authorizationCode empty — the provider returned Optional.empty).
    // A body that isn't graphql JSON, e.g. an in-place SSO interstitial served with
    // 200, means no usable session → fall through rather than mislabel a permissions
    // problem.
    if (!gqlBody || typeof gqlBody !== 'object' || !('data' in gqlBody)) return null;
    const authCode = (gqlBody as { data?: { authorizationCode?: { code?: string } } }).data?.authorizationCode?.code;
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
    this._via = via;            // set before persist so the stored blob is correct
    this._persistTokens();
    return this._jwt;
  }

  /** True when `url` shares the configured BMP origin. Detects an SSO/login redirect
   *  that carried the graphql request off to an identity provider — fetch follows the
   *  302, so the final URL's origin is the only trace left. A malformed/empty URL
   *  counts as off-origin (we'd rather skip the session than trust an unparseable
   *  redirect target). */
  private _isBmpOrigin(url: string): boolean {
    try {
      return new URL(url).origin === new URL(this.bmpUrl).origin;
    } catch {
      return false;
    }
  }

  /** Bootstrap a web session from stored credentials (legacy Path B step 1).
   *  We no longer extract JSESSIONID manually — the cookie lands in the SW's
   *  cookie jar and `credentials:'include'` on the exchange carries it.
   *
   *  SIDE EFFECT: that jar is the browser's shared cookie store, so a password
   *  login REPLACES the user's current BMP session cookie with the stored
   *  account's. On a deployment where the profile credentials differ from the
   *  human's browser login, their BMP tabs become the stored account. MV3 can't
   *  isolate the jar per-fetch, so this is inherent to password auth. It only
   *  bites the fallback when `auto` couldn't borrow a usable session — which is
   *  exactly when there's no live session worth preserving. Documented so it's
   *  a known trade-off, not a surprise. */
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
      if (resp.status === 401 || resp.status === 403) {
        // Refresh hard-rejected: the whole chain is dead. Clear everything
        // (not just the refresh token) so we don't leave a stale jwt/via in
        // memory or in the persisted blob for restoreFromSession to pick up.
        this._jwt = null;
        this._refreshToken = null;
        this._via = null;
        this._clearPersistedTokens();
        return null;
      }
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
    await this.restoreFromSession();
    if (this._jwt) return this._jwt;
    return this.recoverAuth();
  }

  /** Recover a rejected/expired access token. Concurrent command failures share
   *  one refresh-or-login chain rather than starting parallel browser-session
   *  exchanges. A retained refresh token wins; full login is the fallback. */
  async recoverAuth(): Promise<string> {
    if (this._recoveryPromise) return this._recoveryPromise;
    this._recoveryPromise = this._doRecoverAuth();
    try { return await this._recoveryPromise; }
    finally { this._recoveryPromise = null; }
  }

  private async _doRecoverAuth(): Promise<string> {
    await this.restoreFromSession();
    if (this._refreshToken) {
      const refreshed = await this.refreshAuth();
      if (refreshed) return refreshed;
    }
    return this.login();
  }

  /** Attempt to restore JWT from chrome.storage.session WITHOUT falling
   *  back to a fresh login. Returns true if restore succeeded.
   *  Used by the auth-test fast path so a freshly-pooled BmpClient (no
   *  in-memory JWT) can pick up its previously-persisted token before
   *  deciding whether to refresh or full-login. */
  async restoreFromSession(): Promise<boolean> {
    if (this._jwt) return true;
    if (this._sessionLoaded) return false;
    if (this._restorePromise) return this._restorePromise;
    this._restorePromise = this._doRestoreFromSession();
    try { return await this._restorePromise; }
    finally { this._restorePromise = null; }
  }

  private async _doRestoreFromSession(): Promise<boolean> {
    try {
      const result = await chrome.storage.session.get(this._sessionKey);
      const saved = result[this._sessionKey] as { jwt?: string | null; refreshToken?: string | null; via?: AuthVia | null } | undefined;
      if (saved) {
        this._jwt = saved.jwt ?? null;
        this._refreshToken = saved.refreshToken ?? null;
        this._via = saved.via ?? null;
      }
    } catch (e) {
      log.warn('auth:restoreSession', e, 'session restore failed');
    } finally {
      // Once loaded, in-memory state is authoritative. In particular,
      // expireAccessToken() must not race its async storage write and restore
      // the just-rejected JWT from an older session blob.
      this._sessionLoaded = true;
    }
    return this._jwt != null;
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
    this._sessionLoaded = true;
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
    this._recoveryPromise = null;
    this._ticketPromise = null;
    this._ticketRecoveryPromise = null;
    this._restorePromise = null;
    this._sessionLoaded = true;
    this._clearPersistedTokens();
  }

  /** Drop only the command LoginTicket. The JWT may still be valid and can
   *  exchange for a fresh ticket without a full credential recovery. */
  invalidateLoginTicket(): void {
    this._loginTicket = null;
  }

  /** Mark the access token as rejected while retaining its refresh token.
   *  Persisting jwt:null prevents a future SW/client from restoring it. */
  expireAccessToken(): void {
    this._jwt = null;
    this._loginTicket = null;
    this._sessionLoaded = true;
    this._persistTokens();
  }

  /** Exchange JWT for a LoginTicket string (cached — reused until JWT is invalidated).
   *  Needed for binary commands on BMP < 5.6.3 where JWT auth for /cs/command is broken. */
  async getLoginTicket(): Promise<string> {
    if (this._loginTicket) return this._loginTicket;
    if (this._ticketPromise) return this._ticketPromise;
    this._ticketPromise = this._fetchLoginTicketWithAuthRecovery();
    try { return await this._ticketPromise; }
    finally { this._ticketPromise = null; }
  }

  /** Force a new command ticket after /cs/command rejects the cached one.
   *  Concurrent rejected commands share the same ticket exchange. */
  async refreshLoginTicket(): Promise<string> {
    if (this._ticketRecoveryPromise) return this._ticketRecoveryPromise;
    this._loginTicket = null;
    this._ticketRecoveryPromise = this.getLoginTicket();
    try { return await this._ticketRecoveryPromise; }
    finally { this._ticketRecoveryPromise = null; }
  }

  private async _fetchLoginTicketWithAuthRecovery(): Promise<string> {
    let jwt = await this.ensureAuth();
    let res = await this._fetchLoginTicket(jwt);
    if (res.status === 401 || res.status === 403) {
      this.expireAccessToken();
      jwt = await this.recoverAuth();
      res = await this._fetchLoginTicket(jwt);
    }
    if (!res.ok) throw new Error(`Failed to get login ticket: HTTP ${res.status}`);
    const ticket = await res.text();
    if (!ticket) throw new Error('Empty login ticket');
    this._loginTicket = ticket;
    return ticket;
  }

  private _fetchLoginTicket(jwt: string): Promise<Response> {
    return fetch(`${this.bmpUrl}ticket`, {
      headers: { 'Authorization': `Bearer ${jwt}` },
      signal: AbortSignal.timeout(AUTH_TIMEOUT),
    });
  }

  private _persistTokens() {
    chrome.storage.session.set({ [this._sessionKey]: { jwt: this._jwt, refreshToken: this._refreshToken, via: this._via } }).catch(e => log.swallow('auth:persistTokens', e));
  }

  private _clearPersistedTokens() {
    chrome.storage.session.remove(this._sessionKey).catch(e => log.swallow('auth:clearTokens', e));
  }
}
