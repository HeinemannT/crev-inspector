/**
 * BMP command authentication.
 *
 * Portal mode borrows the browser session only long enough to mint CREV's own
 * JWT/refresh chain, then exchanges it for a LoginTicket. Stored mode calls
 * BMP's legacy direct-login endpoint with `credentials: 'omit'` and consumes
 * the serialized LoginTicket. It never writes to the browser cookie jar.
 */

import { log } from './logger';
import { AUTH_TIMEOUT } from './constants';
import { assertHostAccess, HostAccessError } from './site-access';
import { JavaEnum, JavaReader } from './java-serial';
import { registerBmpTypes } from './bmp-types';
import type { CommandAuthMode } from './identity-map';

export type { CommandAuthMode, CommandAuthSource } from './identity-map';

export type AuthErrorCode =
  | 'needs-login'
  | 'no-config-access'
  | 'auth-failed'
  | 'exchange-failed';

export class AuthError extends Error {
  constructor(message: string, readonly code: AuthErrorCode) {
    super(message);
    this.name = 'AuthError';
  }
}

export function commandAuthSessionKey(profileId: string): string {
  return `crev_command_auth_v2_${profileId}`;
}

/** Previous releases stored portal JWT chains under this key. */
export function legacySessionTokenKey(profileId: string): string {
  return `crev_jwt_${profileId}`;
}

interface AuthStamp {
  profileId: string;
  workspaceUrl: string;
  mode: CommandAuthMode;
  username: string;
  revision: string;
}

interface PortalAuthState {
  version: 2;
  kind: 'portal-token';
  stamp: AuthStamp;
  jwt: string | null;
  refreshToken: string | null;
  commandUser: string | null;
}

interface StoredAuthState {
  version: 2;
  kind: 'direct-ticket';
  stamp: AuthStamp;
  ticket: string;
  commandUser: string;
}

type PersistedAuthState = PortalAuthState | StoredAuthState;

const LOGIN_TICKET_CLASS = 'com.corporater.bmp.base.system.auth.LoginTicket';
const MAX_LOGIN_RESPONSE_BYTES = 1024 * 1024;

function portalTicketPrincipal(ticket: string): string | null {
  const parts = ticket.split(';');
  if (parts.length !== 3) return null;
  const [principal, agent, key] = parts;
  if (!principal.trim() || agent !== 'STUDIO' || !/^-?\d+$/.test(key)) return null;
  return principal.trim();
}

export class BmpAuth {
  private _jwt: string | null = null;
  private _refreshToken: string | null = null;
  private _loginTicket: string | null = null;
  private _commandUser: string | null = null;
  private _loginPromise: Promise<string> | null = null;
  private _refreshPromise: Promise<string | null> | null = null;
  private _recoveryPromise: Promise<string> | null = null;
  private _ticketPromise: Promise<string> | null = null;
  private _ticketRecoveryPromise: Promise<string> | null = null;
  private _restorePromise: Promise<boolean> | null = null;
  private _sessionLoaded = false;

  constructor(
    private bmpUrl: string,
    private bmpUser: string,
    private bmpPass: string,
    private readonly profileId = 'default',
    private commandMode: CommandAuthMode = 'portal',
    private readonly credentialRevision = '',
  ) {}

  private get sessionKey(): string { return commandAuthSessionKey(this.profileId); }

  private get stamp(): AuthStamp {
    return {
      profileId: this.profileId,
      workspaceUrl: this.normalizedWorkspaceUrl(),
      mode: this.commandMode,
      username: this.commandMode === 'stored' ? this.bmpUser : '',
      revision: this.credentialRevision,
    };
  }

  get jwt(): string | null { return this._jwt; }
  get username(): string { return this.bmpUser; }
  get password(): string { return this.bmpPass; }
  get authMode(): CommandAuthMode { return this.commandMode; }
  get commandUser(): string | null { return this._commandUser; }

  /** Portal-mode JWT login. Stored mode never needs or creates a JWT. */
  async login(): Promise<string> {
    if (this.commandMode !== 'portal') {
      throw new AuthError('Stored configuration login uses an independent command ticket.', 'auth-failed');
    }
    if (this._loginPromise) return this._loginPromise;
    this._loginPromise = this.completePortalTokenExchange();
    try { return await this._loginPromise; }
    finally { this._loginPromise = null; }
  }

  private async completePortalTokenExchange(): Promise<string> {
    await assertHostAccess(this.bmpUrl);
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

    if (gqlResp.status === 401 || gqlResp.redirected === true
      || (gqlResp.url && !this.isBmpOrigin(gqlResp.url))) {
      throw new AuthError('No active BMP portal session. Open BMP and sign in, then retry.', 'needs-login');
    }
    if (!gqlResp.ok) {
      throw new AuthError(`Authorization code request failed (HTTP ${gqlResp.status}). Check BMP URL.`, 'auth-failed');
    }

    const gqlBody = await gqlResp.json().catch(() => null);
    if (!gqlBody || typeof gqlBody !== 'object' || !('data' in gqlBody)) {
      throw new AuthError('No usable BMP portal session. Open BMP and sign in, then retry.', 'needs-login');
    }
    const authCode = (gqlBody as { data?: { authorizationCode?: { code?: string } } }).data?.authorizationCode?.code;
    if (!authCode) {
      throw new AuthError('The portal user lacks Configuration Access.', 'no-config-access');
    }

    const tokenResp = await fetch(`${this.bmpUrl}cstoken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grantType=authorizationCode&authorizationCode=${encodeURIComponent(authCode)}`,
      signal: AbortSignal.timeout(AUTH_TIMEOUT),
    });
    if (!tokenResp.ok) throw new AuthError(`Token exchange failed (HTTP ${tokenResp.status}).`, 'exchange-failed');
    const tokenBody = await tokenResp.json().catch(() => null);
    if (!tokenBody?.accessToken) throw new AuthError('BMP returned no Configuration Studio access token.', 'exchange-failed');

    this._jwt = tokenBody.accessToken;
    this._refreshToken = tokenBody.refreshToken ?? null;
    this.persistPortalState();
    return tokenBody.accessToken as string;
  }

  async refreshAuth(): Promise<string | null> {
    if (this.commandMode !== 'portal' || !this._refreshToken) return null;
    if (this._refreshPromise) return this._refreshPromise;
    this._refreshPromise = this.doRefresh();
    try { return await this._refreshPromise; }
    finally { this._refreshPromise = null; }
  }

  private async doRefresh(): Promise<string | null> {
    try {
      await assertHostAccess(this.bmpUrl);
      const resp = await fetch(`${this.bmpUrl}cstoken`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: `grantType=refreshToken&refreshToken=${encodeURIComponent(this._refreshToken!)}`,
        signal: AbortSignal.timeout(AUTH_TIMEOUT),
      });
      if (resp.status === 401 || resp.status === 403) {
        this._jwt = null;
        this._refreshToken = null;
        this._commandUser = null;
        this.clearPersistedState();
        return null;
      }
      if (!resp.ok) return null;
      const body = await resp.json().catch(() => null);
      if (!body?.accessToken) return null;
      this._jwt = body.accessToken;
      if (body.refreshToken) this._refreshToken = body.refreshToken;
      this.persistPortalState();
      return this._jwt;
    } catch (error) {
      if (error instanceof HostAccessError) throw error;
      log.warn('auth:refresh', error, 'portal token refresh failed');
      return null;
    }
  }

  async ensureAuth(): Promise<string> {
    if (this.commandMode !== 'portal') {
      throw new AuthError('Stored configuration login does not use a portal JWT.', 'auth-failed');
    }
    if (this._jwt) return this._jwt;
    await this.restoreFromSession();
    if (this._jwt) return this._jwt;
    return this.recoverAuth();
  }

  async recoverAuth(): Promise<string> {
    if (this._recoveryPromise) return this._recoveryPromise;
    this._recoveryPromise = this.doRecoverAuth();
    try { return await this._recoveryPromise; }
    finally { this._recoveryPromise = null; }
  }

  private async doRecoverAuth(): Promise<string> {
    await this.restoreFromSession();
    if (this._refreshToken) {
      const refreshed = await this.refreshAuth();
      if (refreshed) return refreshed;
    }
    return this.login();
  }

  async restoreFromSession(): Promise<boolean> {
    if (this._loginTicket || this._jwt) return true;
    if (this._sessionLoaded) return false;
    if (this._restorePromise) return this._restorePromise;
    this._restorePromise = this.doRestoreFromSession();
    try { return await this._restorePromise; }
    finally { this._restorePromise = null; }
  }

  private async doRestoreFromSession(): Promise<boolean> {
    try {
      const result = await chrome.storage.session.get([this.sessionKey, legacySessionTokenKey(this.profileId)]);
      const saved = result[this.sessionKey] as PersistedAuthState | undefined;
      if (saved && this.stampsEqual(saved.stamp, this.stamp)) {
        if (saved.kind === 'portal-token' && this.commandMode === 'portal') {
          this._jwt = saved.jwt;
          this._refreshToken = saved.refreshToken;
          this._commandUser = saved.commandUser;
        } else if (saved.kind === 'direct-ticket' && this.commandMode === 'stored') {
          this._loginTicket = saved.ticket;
          this._commandUser = saved.commandUser;
        }
      } else if (saved) {
        this.clearPersistedState();
      } else if (this.commandMode === 'portal') {
        // One-release compatibility with the previous portal JWT envelope.
        const legacy = result[legacySessionTokenKey(this.profileId)] as {
          jwt?: string | null;
          refreshToken?: string | null;
        } | undefined;
        if (legacy?.jwt || legacy?.refreshToken) {
          this._jwt = legacy.jwt ?? null;
          this._refreshToken = legacy.refreshToken ?? null;
          this.persistPortalState();
        }
      }
    } catch (error) {
      log.warn('auth:restoreSession', error, 'command auth restore failed');
    } finally {
      this._sessionLoaded = true;
    }
    return this._loginTicket != null || this._jwt != null;
  }

  passwordMatches(pass: string): boolean {
    return this.bmpPass === pass;
  }

  /** Copy auth state only between clients with the same explicit strategy. */
  absorbAuth(other: BmpAuth): void {
    if (this.commandMode !== other.commandMode) return;
    this._jwt = other._jwt;
    this._refreshToken = other._refreshToken;
    this._loginTicket = other._loginTicket;
    this._commandUser = other._commandUser;
    this._sessionLoaded = true;
    this.persistCurrentState();
  }

  /** Unconditional local teardown. Stored login deliberately has no browser
   * cookie, so its server-side HTTP session expires under BMP's own policy. */
  logout(): void {
    this._jwt = null;
    this._refreshToken = null;
    this._loginTicket = null;
    this._commandUser = null;
    this._loginPromise = null;
    this._refreshPromise = null;
    this._recoveryPromise = null;
    this._ticketPromise = null;
    this._ticketRecoveryPromise = null;
    this._restorePromise = null;
    this._sessionLoaded = true;
    this.clearPersistedState();
  }

  invalidateLoginTicket(): void {
    this._loginTicket = null;
    if (this.commandMode === 'stored') this.clearPersistedState();
  }

  expireAccessToken(): void {
    if (this.commandMode !== 'portal') return;
    this._jwt = null;
    this._loginTicket = null;
    this._commandUser = null;
    this._sessionLoaded = true;
    this.persistPortalState();
  }

  async getLoginTicket(): Promise<string> {
    if (this._loginTicket) return this._loginTicket;
    await this.restoreFromSession();
    if (this._loginTicket) return this._loginTicket;
    if (this._ticketPromise) return this._ticketPromise;
    this._ticketPromise = this.commandMode === 'stored'
      ? this.directLogin()
      : this.fetchPortalLoginTicketWithRecovery();
    try { return await this._ticketPromise; }
    finally { this._ticketPromise = null; }
  }

  async refreshLoginTicket(): Promise<string> {
    if (this._ticketRecoveryPromise) return this._ticketRecoveryPromise;
    this._loginTicket = null;
    if (this.commandMode === 'stored') this.clearPersistedState();
    this._ticketRecoveryPromise = this.getLoginTicket();
    try { return await this._ticketRecoveryPromise; }
    finally { this._ticketRecoveryPromise = null; }
  }

  private async fetchPortalLoginTicketWithRecovery(): Promise<string> {
    let jwt = await this.ensureAuth();
    let res = await this.fetchPortalLoginTicket(jwt);
    if (res.status === 401 || res.status === 403) {
      this.expireAccessToken();
      jwt = await this.recoverAuth();
      res = await this.fetchPortalLoginTicket(jwt);
    }
    if (res.type === 'opaqueredirect' || res.redirected
      || (res.url && !this.isBmpOrigin(res.url))) {
      throw new AuthError('The BMP command ticket request was redirected outside the workspace.', 'exchange-failed');
    }
    if (!res.ok) throw new AuthError(`Failed to obtain a command ticket (HTTP ${res.status}).`, 'exchange-failed');
    const ticket = (await res.text()).trim();
    if (!ticket) throw new AuthError('BMP returned an empty command ticket.', 'exchange-failed');
    const principal = portalTicketPrincipal(ticket);
    if (!principal) throw new AuthError('BMP returned an invalid command ticket.', 'exchange-failed');
    this._loginTicket = ticket;
    this._commandUser = principal;
    this.persistPortalState();
    return ticket;
  }

  private async fetchPortalLoginTicket(jwt: string): Promise<Response> {
    await assertHostAccess(this.bmpUrl);
    return fetch(`${this.bmpUrl}ticket`, {
      headers: { Authorization: `Bearer ${jwt}` },
      credentials: 'omit',
      redirect: 'manual',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(AUTH_TIMEOUT),
    });
  }

  private async directLogin(): Promise<string> {
    if (!this.bmpUser.trim() || !this.bmpPass) {
      throw new AuthError('Enter a username and password for the stored configuration login.', 'auth-failed');
    }
    await assertHostAccess(this.bmpUrl);
    const url = new URL('cs/login', this.bmpUrl);
    url.searchParams.set('type', 'login');
    url.searchParams.set('username', this.bmpUser);
    url.searchParams.set('password', this.bmpPass);
    url.searchParams.set('userAgent', 'STUDIO');
    url.searchParams.set('customerId', 'default');
    url.searchParams.set('_noctx', 'true');

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'GET',
        credentials: 'omit',
        redirect: 'manual',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
        signal: AbortSignal.timeout(AUTH_TIMEOUT),
      });
    } catch (error) {
      if (error instanceof HostAccessError) throw error;
      throw new AuthError('Stored configuration login could not reach BMP.', 'auth-failed');
    }
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) {
      throw new AuthError('Stored configuration login is not supported by this BMP gateway.', 'auth-failed');
    }
    if (response.status === 401 || response.status === 403) {
      throw new AuthError('Stored configuration username or password was rejected.', 'auth-failed');
    }
    if (!response.ok) {
      throw new AuthError(`Stored configuration login failed (HTTP ${response.status}).`, 'auth-failed');
    }

    const buffer = await response.arrayBuffer();
    if (buffer.byteLength < 5 || buffer.byteLength > MAX_LOGIN_RESPONSE_BYTES) {
      throw new AuthError('BMP returned an invalid stored-login response.', 'auth-failed');
    }
    const magic = new Uint8Array(buffer, 0, 2);
    if (magic[0] !== 0xac || magic[1] !== 0xed) {
      throw new AuthError('Stored configuration login is unsupported or returned an HTML sign-in page.', 'auth-failed');
    }

    let raw: Record<string, unknown>;
    try {
      registerBmpTypes();
      const reader = new JavaReader(buffer);
      reader.readStreamHeader();
      raw = reader.readObject() as Record<string, unknown>;
      if (reader.remaining !== 0) throw new Error('trailing serialized data');
    } catch {
      throw new AuthError('BMP returned an unreadable stored-login ticket.', 'auth-failed');
    }
    if (raw?.$class !== LOGIN_TICKET_CLASS) {
      throw new AuthError('BMP returned an unexpected stored-login response.', 'auth-failed');
    }
    const principalId = typeof raw.principalId === 'string' ? raw.principalId.trim() : '';
    const onBehalfOfId = typeof raw.onBehalfOfId === 'string' ? raw.onBehalfOfId.trim() : '';
    const agent = raw.clientUserAgent instanceof JavaEnum ? raw.clientUserAgent.name : '';
    const key = raw.key;
    if (!principalId || !onBehalfOfId || agent !== 'STUDIO' || typeof key !== 'bigint') {
      throw new AuthError('BMP returned an incomplete stored-login ticket.', 'auth-failed');
    }

    const ticket = `${onBehalfOfId};${agent};${key.toString()}`;
    this._loginTicket = ticket;
    this._commandUser = principalId;
    this.persistStoredState(ticket, principalId);
    return ticket;
  }

  private persistCurrentState(): void {
    if (this.commandMode === 'stored' && this._loginTicket && this._commandUser) {
      this.persistStoredState(this._loginTicket, this._commandUser);
    } else if (this.commandMode === 'portal') {
      this.persistPortalState();
    }
  }

  private persistPortalState(): void {
    const value: PortalAuthState = {
      version: 2,
      kind: 'portal-token',
      stamp: this.stamp,
      jwt: this._jwt,
      refreshToken: this._refreshToken,
      commandUser: this._commandUser,
    };
    chrome.storage.session.set({ [this.sessionKey]: value })
      .then(() => chrome.storage.session.remove(legacySessionTokenKey(this.profileId)))
      .catch(error => log.swallow('auth:persistPortal', error));
  }

  private persistStoredState(ticket: string, commandUser: string): void {
    const value: StoredAuthState = {
      version: 2,
      kind: 'direct-ticket',
      stamp: this.stamp,
      ticket,
      commandUser,
    };
    chrome.storage.session.set({ [this.sessionKey]: value })
      .then(() => chrome.storage.session.remove(legacySessionTokenKey(this.profileId)))
      .catch(error => log.swallow('auth:persistStored', error));
  }

  private clearPersistedState(): void {
    chrome.storage.session.remove([this.sessionKey, legacySessionTokenKey(this.profileId)])
      .catch(error => log.swallow('auth:clearSession', error));
  }

  private normalizedWorkspaceUrl(): string {
    try {
      const url = new URL(this.bmpUrl);
      url.hash = '';
      url.search = '';
      if (!url.pathname.endsWith('/')) url.pathname += '/';
      return url.toString();
    } catch {
      return this.bmpUrl;
    }
  }

  private stampsEqual(a: AuthStamp | undefined, b: AuthStamp): boolean {
    return Boolean(a
      && a.profileId === b.profileId
      && a.workspaceUrl === b.workspaceUrl
      && a.mode === b.mode
      && a.username === b.username
      && a.revision === b.revision);
  }

  private isBmpOrigin(url: string): boolean {
    try {
      return new URL(url).origin === new URL(this.bmpUrl).origin;
    } catch {
      return false;
    }
  }
}
