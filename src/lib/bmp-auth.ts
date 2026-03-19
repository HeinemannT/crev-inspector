/**
 * BMP authentication — 3-step web auth flow: session cookie → auth code → JWT.
 * Extracted from BmpClient for clarity.
 */

import { log } from './logger';
import { AUTH_TIMEOUT } from './constants';

export class BmpAuth {
  private _jwt: string | null = null;
  private _refreshToken: string | null = null;
  private _jsessionid: string | null = null;
  private _loginTicket: string | null = null;
  private _loginPromise: Promise<string> | null = null;
  private _refreshPromise: Promise<string | null> | null = null;
  private _profileId: string;

  constructor(
    private bmpUrl: string,
    private bmpUser: string,
    private bmpPass: string,
    profileId?: string,
  ) {
    this._profileId = profileId ?? 'default';
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

  private async _doLogin(): Promise<string> {
    // Step 1: POST /cs/authentication → session cookie
    const authResp = await fetch(`${this.bmpUrl}cs/authentication`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `username=${encodeURIComponent(this.bmpUser)}&password=${encodeURIComponent(this.bmpPass)}`,
      credentials: 'include',
      redirect: 'manual',
      signal: AbortSignal.timeout(AUTH_TIMEOUT),
    });

    const isRedirect = authResp.type === 'opaqueredirect' || (authResp.status >= 300 && authResp.status < 400);

    // Extract JSESSIONID from Set-Cookie header
    this._jsessionid = null;
    if (!isRedirect) {
      const cookies = authResp.headers.getSetCookie?.() ?? [];
      for (const c of cookies) {
        const m = c.match(/JSESSIONID=([^;]+)/);
        if (m) { this._jsessionid = m[1]; break; }
      }
      if (!this._jsessionid) {
        const raw = authResp.headers.get('set-cookie') ?? '';
        const m = raw.match(/JSESSIONID=([^;,\s]+)/);
        if (m) this._jsessionid = m[1];
      }
    }

    // Cloud servers: opaqueredirect hides Set-Cookie — retry without redirect:'manual'
    if (isRedirect && !this._jsessionid) {
      await fetch(`${this.bmpUrl}cs/authentication`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `username=${encodeURIComponent(this.bmpUser)}&password=${encodeURIComponent(this.bmpPass)}`,
        credentials: 'include',
        signal: AbortSignal.timeout(AUTH_TIMEOUT),
      }).then(r => r.text().catch(() => ''));
    }

    if (!isRedirect) {
      const authText = await authResp.text().catch(() => '');
      let authBody: Record<string, unknown> | null;
      try { authBody = JSON.parse(authText); } catch (e) { log.swallow('auth:parseResp', e); authBody = null; }

      if (authBody?.error === 'loginError.wrong_username_or_pwd') throw new Error('Wrong username or password');
      if (authBody?.error) throw new Error(authBody.error as string);

      if (!authResp.ok && !authBody?.userId) {
        throw new Error(`Authentication failed (HTTP ${authResp.status}). Check URL, username, and password.`);
      }

      if (!authBody?.userId) {
        throw new Error('Authentication failed. Server did not return a user session.');
      }
    }

    // Step 2: GraphQL → authorization code
    const gqlHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this._jsessionid) {
      gqlHeaders['Cookie'] = `JSESSIONID=${this._jsessionid}`;
    }

    const gqlResp = await fetch(`${this.bmpUrl}graphql`, {
      method: 'POST',
      headers: gqlHeaders,
      credentials: 'include',
      body: JSON.stringify({
        query: 'query AuthorizationCode { authorizationCode { code } }',
        variables: {},
        operationName: 'AuthorizationCode',
      }),
      signal: AbortSignal.timeout(AUTH_TIMEOUT),
    });

    if (!gqlResp.ok) {
      throw new Error(`Authorization code request failed (HTTP ${gqlResp.status}). Check BMP URL.`);
    }
    const gqlBody = await gqlResp.json();
    const authCode = gqlBody?.data?.authorizationCode?.code;
    if (!authCode) throw new Error('Failed to get authorization code');

    // Step 3: Exchange auth code → JWT
    const tokenResp = await fetch(`${this.bmpUrl}cstoken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grantType=authorizationCode&authorizationCode=${encodeURIComponent(authCode)}`,
      signal: AbortSignal.timeout(AUTH_TIMEOUT),
    });

    if (!tokenResp.ok) throw new Error(`Token exchange failed: ${tokenResp.status}`);
    const tokenBody = await tokenResp.json();
    if (!tokenBody?.accessToken) throw new Error('No access token in response');

    this._jwt = tokenBody.accessToken;
    this._refreshToken = tokenBody.refreshToken ?? null;
    this._persistTokens();
    return this._jwt;
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
      log.swallow('auth:refresh', e);
      return null;
    }
  }

  /** Ensure valid JWT — restore from session, refresh, or full login */
  async ensureAuth(): Promise<string> {
    if (this._jwt) return this._jwt;
    try {
      const result = await chrome.storage.session.get(this._sessionKey);
      const saved = result[this._sessionKey] as { jwt: string; refreshToken: string } | undefined;
      if (saved?.jwt) {
        this._jwt = saved.jwt;
        this._refreshToken = saved.refreshToken ?? null;
        return this._jwt;
      }
    } catch (e) { log.swallow('auth:restoreSession', e); }
    return this.login();
  }

  /** Copy auth state from another instance */
  absorbAuth(other: BmpAuth) {
    this._jwt = other._jwt;
    this._refreshToken = other._refreshToken;
    this._jsessionid = other._jsessionid;
    this._loginTicket = null; // Ticket is derived from JWT — re-derive on demand
    this._persistTokens();
  }

  /** Clear cached JWT and ticket */
  logout() {
    this._jwt = null;
    this._refreshToken = null;
    this._jsessionid = null;
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
