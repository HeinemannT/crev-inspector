/**
 * Connect tab — server profiles, connection status, settings.
 */

import type { InspectorMessage, ServerProfile, AuthMode } from '../../lib/types';
import { resolveAuthMode } from '../../lib/bmp-auth';
import { h, render, svg } from '../../lib/dom';
import { delegate } from '../delegate';
import { ICON_EYE_OPEN, ICON_EYE_CLOSED } from '../utils';
import { ICON_WARNING, ICON_REFRESH, ICON_SPARKLE } from '../../lib/icons';
import { S as shared, getTabPanel } from '../state';
import { FLASH_INVALID_DURATION } from '../../lib/constants';
import { confirmModal } from '../../lib/modal';
import { getUpdateStatus, refresh as refreshUpdate, type UpdateStatus } from '../../lib/version-check';
import { originPatternFor } from '../../lib/site-access';
import { requestOriginsInGesture } from '../site-access-strip';
import { PROVIDERS, AI_PROVIDER_IDS } from '../../lib/ai/providers';
import type { AiProviderId } from '../../lib/ai/types';
import type { Tab, SendFn } from './tab-types';

type EditingProfile = { id: string | null; label: string; bmpUrl: string; bmpUser: string; bmpPass: string; authMode?: AuthMode };

export class ConnectTab implements Tab {
  private editing: EditingProfile | null = null;
  private send: SendFn;
  private updateStatus: UpdateStatus | null = null;
  private updatePanel: HTMLElement | null = null;
  /** Authoritative shortcut bindings from chrome.commands.getAll(). Empty
   *  string in the map means "user cleared it"; missing key means "not yet
   *  loaded" (we don't have the API result back). */
  private commandShortcuts = new Map<string, string>();
  private shortcutsLoaded = false;
  /** Approximate persisted-cache byte size — requested on activate, updated
   *  via CACHE_BYTES response. Surfaces a "~X MB" hint next to the cache count
   *  so the user can see when they're approaching the 10 MB quota. */
  private cacheBytes: number | null = null;
  /** Set true when the SW reports a CACHE_QUOTA_WARNING; renders a banner. */
  private cacheQuotaWarning = false;

  /** Shortcuts/reference block is reference material — collapsed by default so
   * the actual controls (servers, settings) lead. */
  private referenceOpen = false;
  /** Per-profile host-permission state (origin pattern → granted). Refreshed on activate/save;
   *  drives the "no site access" chip on profile cards. Unknown origins simply render no chip. */
  private accessByOrigin = new Map<string, boolean>();

  // ── AI assistant settings state ────────────────────────────────
  /** True once a provider key is stored (derived from SETTINGS_DATA + updated
   *  by AI_CONFIG_SAVED). Drives "Key saved" vs the key input. */
  private aiConfigured = false;
  /** Draft provider/model while the user is choosing, before Save. Null ⇒
   *  derive from the stored config (or the provider default). */
  private aiProviderDraft: AiProviderId | null = null;
  private aiModelDraft: string | null = null;
  /** Draft of the unsaved API key, carried across re-renders so an async
   *  repaint (provider change, a status/model-list tick) can't wipe a key the
   *  user typed but hasn't Saved yet. Cleared once the key is saved/removed. */
  private aiKeyDraft = '';
  /** True when replacing an already-saved key (shows the key input again). */
  private aiReplacingKey = false;
  private aiTestStatus: { ok: boolean; text: string } | null = null;
  private aiTesting = false;
  private aiModelOptions: string[] = [];
  /** Collapsed server-row card vs the expanded config form. */
  private aiExpanded = false;

  constructor(send: SendFn) {
    this.send = send;
  }

  activate() {
    this.aiConfigured = !!shared.settings.ai?.apiKeyEnc;
    this.send({ type: 'GET_SETTINGS' });
    this.send({ type: 'GET_CACHE_BYTES' });
    void this.refreshAccess();
    // Update check is fire-and-forget; the banner shows whatever we have
    // cached immediately, then re-renders when the response lands. Read once
    // here on activate so opening the panel always gets fresh-ish data.
    void this.loadUpdateStatus();
    void this.loadCommandShortcuts();
  }

  /** Pull the user's actual key bindings from Chrome (which is authoritative —
   *  manifest values are only DEFAULTS, the user can clear or remap at
   *  chrome://extensions/shortcuts). Re-renders Quick reference on response so
   *  the displayed keys match reality. */
  private async loadCommandShortcuts(): Promise<void> {
    try {
      const commands = await chrome.commands.getAll();
      for (const c of commands) {
        if (c.name) this.commandShortcuts.set(c.name, c.shortcut ?? '');
      }
      this.shortcutsLoaded = true;
      // Cheap re-render of just the reference card would require holding a
      // ref to it; instead, signal a full rerender from the tab if we're the
      // active tab. SKIP re-render when the user is mid-edit of a server
      // profile — wiping their half-typed password to repaint a shortcut
      // chip is worse than waiting for the next render.
      if (shared.activeTab === 'connect' && !this.editing) {
        const panel = getTabPanel('connect');
        if (panel) this.render(panel);
      }
    } catch (e) {
      // chrome.commands unavailable (rare) — fall back to manifest defaults.
      this.shortcutsLoaded = true;
    }
  }

  /** Re-check host-permission state for every configured profile origin. Follows the same
   *  re-render etiquette as loadCommandShortcuts: repaint only when active and not mid-edit. */
  private async refreshAccess(): Promise<void> {
    const next = new Map<string, boolean>();
    for (const p of shared.settings.profiles) {
      const origin = originPatternFor(p.bmpUrl);
      if (!origin) continue;
      try { next.set(origin, await chrome.permissions.contains({ origins: [origin] })); }
      catch { /* permissions API unavailable — no chips */ }
    }
    const changed = next.size !== this.accessByOrigin.size
      || [...next].some(([k, v]) => this.accessByOrigin.get(k) !== v);
    this.accessByOrigin = next;
    if (changed && shared.activeTab === 'connect' && !this.editing) {
      const panel = getTabPanel('connect');
      if (panel) this.render(panel);
    }
  }

  private async loadUpdateStatus(forceRefresh = false): Promise<void> {
    const status = forceRefresh ? await refreshUpdate() : await getUpdateStatus();
    this.updateStatus = status;
    if (this.updatePanel && document.body.contains(this.updatePanel)) {
      // Swap the banner in place without forcing a whole-tab re-render —
      // avoids losing scroll position / form focus when the check returns
      // while the user is editing a server profile.
      const fresh = this.renderUpdateBanner();
      if (fresh) this.updatePanel.replaceWith(fresh);
      this.updatePanel = fresh;
    }
  }

  deactivate() {}

  handleMessage(msg: InspectorMessage): boolean {
    switch (msg.type) {
      case 'SETTINGS_DATA':
        this.aiConfigured = !!shared.settings.ai?.apiKeyEnc;
        return !this.editing;
      case 'CONNECTION_STATE':
      case 'PROFILE_SWITCHED':
        return !this.editing; // re-render unless user is editing a form
      case 'AI_CONFIG_SAVED':
        this.aiConfigured = msg.configured;
        if (msg.ok) {
          this.aiReplacingKey = false;
          this.aiTestStatus = null;
          this.aiKeyDraft = '';   // key is stored now — drop the unsaved draft
          if (msg.provider) shared.settings = { ...shared.settings, ai: { provider: msg.provider, model: msg.model ?? '', apiKeyEnc: msg.configured ? 'set' : '' } };
          if (!msg.configured) shared.settings = { ...shared.settings, ai: undefined };
        } else {
          this.aiTestStatus = { ok: false, text: msg.error ?? 'Could not save' };
        }
        return !this.editing;
      case 'AI_TEST_RESULT':
        this.aiTesting = false;
        this.aiTestStatus = msg.ok ? { ok: true, text: 'Connected' } : { ok: false, text: msg.error ?? 'Failed' };
        // Mirror the persisted last-test into shared settings so the collapsed
        // card renders READY + latency immediately (the SW also persisted it).
        if (shared.settings.ai) {
          shared.settings = {
            ...shared.settings,
            ai: { ...shared.settings.ai, lastTest: { ok: msg.ok, ms: msg.ms ?? 0, at: Date.now() } },
          };
        }
        return !this.editing;
      case 'AI_MODELS_RESULT':
        if (msg.ok && msg.models) this.aiModelOptions = msg.models;
        else this.aiTestStatus = { ok: false, text: msg.error ?? 'Could not load models' };
        return !this.editing;
      case 'CACHE_BYTES':
        // Update the "~X MB" hint next to the cache count. If we're editing
        // a profile form we skip the re-render so the user's keystrokes
        // aren't disrupted; the next activate() will refresh it.
        if ('bytes' in msg) this.cacheBytes = msg.bytes;
        return !this.editing;
      case 'CACHE_QUOTA_WARNING':
        this.cacheQuotaWarning = true;
        return !this.editing;
      default:
        return false;
    }
  }

  render(container: HTMLElement) {
    const rerender = () => this.render(container);

    const children: (HTMLElement | false | null)[] = [];

    if (shared.settings.profiles.length === 0 && !this.editing) {
      children.push(h('div', { class: 'empty-state empty-state--padded' },
        'CREV Inspector examines BMP pages. Add a server to get started.'));
    }

    for (const profile of shared.settings.profiles) {
      if (this.editing?.id === profile.id) {
        children.push(this.renderProfileForm(rerender));
      } else {
        children.push(this.renderProfileRow(profile));
      }
    }

    if (this.editing?.id === null) {
      children.push(this.renderProfileForm(rerender));
    } else {
      // Full-width add row closes the server list.
      children.push(h('button', { class: 'addbtn', 'data-action': 'add-profile' }, '+ Add server'));
    }

    children.push(
      // ── Settings ───────────────────────────────────────
      h('div', { class: 'section-header' },
        h('span', { class: 'section-title section-title--flush' }, 'Settings'),
      ),
      this.settingRow('auto-detect', 'Auto-detect server from page URL',
        null, shared.settings.autoDetect),
      this.settingRow('enrich-all', 'Include non-widget objects',
        'Also labels inline elements (tables, others)',
        shared.settings.enrichMode === 'all'),

      // ── AI assistant ───────────────────────────────────────
      this.renderAiSection(),

      // ── Footer: the low-weight informational + utility bits (keyboard
      //    reference, version, cache, reset). None of these is a group of
      //    controls, so none gets a section header — they read as a quiet
      //    footer under one hairline. ──
      this.renderFooter(rerender),
    );

    render(container, ...children);

    container.querySelector('#auto-detect')?.addEventListener('change', (e) => {
      const autoDetect = (e.target as HTMLInputElement).checked;
      shared.settings = { ...shared.settings, autoDetect };
      this.send({ type: 'SAVE_SETTINGS', settings: { autoDetect } });
    });

    container.querySelector('#enrich-all')?.addEventListener('change', (e) => {
      const enrichMode = (e.target as HTMLInputElement).checked ? 'all' as const : 'widgets' as const;
      shared.settings = { ...shared.settings, enrichMode };
      this.send({ type: 'SAVE_SETTINGS', settings: { enrichMode } });
    });

    // AI provider select — switching provider resets the model draft to that
    // provider's default and clears any loaded model list / test status.
    container.querySelector('#ai-provider')?.addEventListener('change', (e) => {
      const provider = (e.target as HTMLSelectElement).value as AiProviderId;
      this.aiProviderDraft = provider;
      this.aiModelDraft = PROVIDERS[provider].defaultModel;
      this.aiModelOptions = [];
      this.aiTestStatus = null;
      rerender();
    });
    // Model input — keep the typed value across re-renders (test/model-list
    // responses re-render the tab) without churning on every keystroke.
    container.querySelector('#ai-model')?.addEventListener('input', (e) => {
      this.aiModelDraft = (e.target as HTMLInputElement).value;
    });
    // API key input — same race protection as the model: keep the typed value
    // in a draft so an async re-render (provider switch, test/model-list tick)
    // can't recreate the input empty before the user hits Save.
    container.querySelector('#ai-key')?.addEventListener('input', (e) => {
      this.aiKeyDraft = (e.target as HTMLInputElement).value;
    });

    // Live update for the HTTP-downgrade warning while editing the URL. We
    // don't re-render the whole tab on every keystroke (that would blur the
    // input + lose focus); just update the warning span in place.
    const urlInput = container.querySelector('#pf-url') as HTMLInputElement | null;
    const urlWarn = container.querySelector('#pf-url-warn');
    if (urlInput && urlWarn) {
      urlInput.addEventListener('input', () => {
        urlWarn.textContent = '';
        if (isInsecureUrl(urlInput.value)) {
          urlWarn.append(svg(ICON_WARNING), ' Password will be sent in clear over HTTP. Use https:// when available.');
        }
      });
    }

    delegate(container, {
      'add-profile': () => {
        this.editing = { id: null, label: '', bmpUrl: '', bmpUser: '', bmpPass: '' };
        rerender();
      },
      'select-profile': (el, e) => {
        if ((e.target as HTMLElement).closest('[data-action="edit-profile"]')) return;
        const id = el.dataset.profileId;
        if (!id || id === shared.settings.activeProfileId) return;
        this.send({ type: 'SET_ACTIVE_PROFILE', profileId: id });
        shared.settings = { ...shared.settings, activeProfileId: id };
        rerender();
      },
      'edit-profile': (el, e) => {
        e.stopPropagation();
        const id = el.dataset.editProfile;
        if (!id) return;
        const profile = shared.settings.profiles.find(p => p.id === id);
        if (profile) { this.editing = { ...profile }; rerender(); }
      },
      'grant-access': (el, e) => {
        // Re-request a profile origin whose grant was declined/revoked. Runs INSIDE this click —
        // the standard browser prompt requires the user gesture.
        e.stopPropagation();
        const origin = el.dataset.grantOrigin;
        if (!origin) return;
        void requestOriginsInGesture([origin]).then(() => this.refreshAccess());
      },
      'pf-save': () => {
        if (!this.editing) return;
        const urlInput = container.querySelector('#pf-url') as HTMLInputElement | null;
        const userInput = container.querySelector('#pf-user') as HTMLInputElement | null;
        if (!urlInput || !userInput) return;
        const label = (container.querySelector('#pf-label') as HTMLInputElement)?.value || 'Unnamed';
        const bmpUrl = urlInput.value || '';
        const bmpUser = userInput.value || '';
        const bmpPass = (container.querySelector('#pf-pass') as HTMLInputElement)?.value || '';

        if (!bmpUrl.trim()) { flashInvalid(urlInput); return; }

        // Credentials are optional. resolveAuthMode encodes the rule: a password
        // means session-first with password fallback ('auto'), none means
        // session-only. There's no UI for a "password-only" mode because
        // session-first is strictly better (faster, no creds, works under
        // SSO/VPN/mTLS).
        const profile: ServerProfile = {
          id: this.editing.id ?? crypto.randomUUID(),
          label, bmpUrl, bmpUser, bmpPass, authMode: resolveAuthMode({ bmpPass }),
        };
        // Ask for the server origin's host permission INSIDE this click — saving a server IS the
        // moment the extension needs its site, and the standard browser prompt requires the user
        // gesture. An already-granted origin resolves silently (no prompt), so re-saves are free.
        const origin = originPatternFor(bmpUrl);
        if (origin) void requestOriginsInGesture([origin]).then(() => this.refreshAccess());
        const profiles = [...shared.settings.profiles];
        const idx = profiles.findIndex(p => p.id === profile.id);
        if (idx >= 0) profiles[idx] = profile; else profiles.push(profile);
        shared.settings = { ...shared.settings, profiles, activeProfileId: shared.settings.activeProfileId || profile.id };
        this.send({ type: 'SAVE_PROFILE', profile });
        this.editing = null;
        rerender();
      },
      'pf-cancel': () => { this.editing = null; rerender(); },
      'pf-delete': () => {
        if (!this.editing?.id) return;
        const deletedId = this.editing.id;
        const profiles = shared.settings.profiles.filter(p => p.id !== deletedId);
        const activeId = shared.settings.activeProfileId === deletedId ? (profiles[0]?.id ?? '') : shared.settings.activeProfileId;
        shared.settings = { ...shared.settings, profiles, activeProfileId: activeId };
        this.send({ type: 'DELETE_PROFILE', profileId: deletedId });
        this.editing = null;
        rerender();
        // The SW revokes the orphaned origin asynchronously — refresh the chips after it lands.
        setTimeout(() => { void this.refreshAccess(); }, 500);
      },
      'clear-cache': () => {
        this.send({ type: 'CLEAR_CACHE' });
        shared.cacheCount = 0;
        rerender();
      },
      'update-refresh': () => {
        // Manual refresh — bypass the 24 h cache and re-fetch immediately.
        // Spinner the refresh button + flip the banner status into a
        // checking state so the user sees something is happening; the
        // fetch can take a few seconds on a cold cache.
        this.updateStatus = null;
        if (this.updatePanel && document.body.contains(this.updatePanel)) {
          const fresh = this.renderUpdateBanner();
          this.updatePanel.replaceWith(fresh);
          this.updatePanel = fresh;
        }
        void this.loadUpdateStatus(true);
      },
      'ai-save': () => {
        const provider = (container.querySelector('#ai-provider') as HTMLSelectElement | null)?.value as AiProviderId | undefined;
        const model = (container.querySelector('#ai-model') as HTMLInputElement | null)?.value.trim();
        const keyInput = container.querySelector('#ai-key') as HTMLInputElement | null;
        const apiKey = keyInput?.value ?? '';
        if (!provider || !model) return;
        // A first-time save needs a key; a provider/model-only re-save keeps the
        // stored key (apiKey omitted).
        if (!this.aiConfigured && !apiKey.trim()) { flashInvalid(keyInput!); return; }
        this.aiTestStatus = null;
        // Request the provider API origin's host permission INSIDE this click —
        // the SW's cross-origin fetch needs it, and the browser prompt requires
        // a user gesture. Already-granted origins resolve silently; a denial
        // surfaces as an inline status so the user knows why calls will fail.
        void requestOriginsInGesture([PROVIDERS[provider].origin]).then((granted) => {
          if (!granted) {
            this.aiTestStatus = { ok: false, text: 'Site access to the provider was declined' };
            const panel = getTabPanel('connect');
            if (panel && !this.editing) this.render(panel);
          }
        });
        this.send({ type: 'AI_SAVE_CONFIG', provider, model, ...(apiKey.trim() ? { apiKey } : {}) });
        this.aiModelDraft = model;
        this.aiProviderDraft = provider;
      },
      'ai-expand': () => { this.aiExpanded = !this.aiExpanded; this.aiTestStatus = null; rerender(); },
      'ai-replace': () => { this.aiReplacingKey = true; this.aiTestStatus = null; this.aiKeyDraft = ''; rerender(); },
      'ai-replace-cancel': () => { this.aiReplacingKey = false; this.aiKeyDraft = ''; rerender(); },
      'ai-remove': () => {
        void (async () => {
          const ok = await confirmModal({
            title: 'Remove AI key?',
            body: 'Clears the stored provider and API key. The AI assistant will disappear from the editor and studio.',
            confirmLabel: 'Remove',
            confirmVariant: 'danger',
          });
          if (!ok) return;
          this.aiProviderDraft = null;
          this.aiModelDraft = null;
          this.aiKeyDraft = '';
          this.aiModelOptions = [];
          this.aiTestStatus = null;
          this.aiExpanded = false;
          this.send({ type: 'AI_REMOVE_CONFIG' });
        })();
      },
      'ai-test': () => {
        this.aiTesting = true;
        this.aiTestStatus = null;
        this.send({ type: 'AI_TEST' });
        rerender();
      },
      'ai-load-models': () => {
        const provider = (this.aiProviderDraft ?? shared.settings.ai?.provider ?? 'anthropic');
        this.send({ type: 'AI_LIST_MODELS', provider });
      },
      'reset-all': () => {
        void (async () => {
          const ok = await confirmModal({
            title: 'Reset all CREV state?',
            body: 'Clears object cache, enrichment state, activity log, history, and per-tab context.\n\nFavorites + server profiles are kept. Use this when the extension is in a bad state.',
            confirmLabel: 'Reset',
            confirmVariant: 'danger',
          });
          if (!ok) return;
          // Optimistically clear local UI state so the user sees the reset
          // land immediately, before the SW round trip + downstream broadcasts.
          shared.cacheCount = 0;
          shared.context = null;
          shared.lastEcMs = null;
          this.send({ type: 'RESET_ALL' });
          rerender();
        })();
      },
    });
  }

  /** Two-letter monogram for the avatar tile. */
  private initials(label: string): string {
    const words = label.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return '?';
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
  }

  /** Live connection status for the active profile's row. */
  private profileStatus(): { text: string; cls: string; title: string } {
    const s = shared.connState;
    switch (s.display) {
      case 'connected': {
        const bits: string[] = [];
        if (s.version) bits.push(`BMP ${s.version}`);
        if (s.authVia) bits.push(s.authVia === 'session' ? 'via browser session' : 'via stored login');
        return { text: 'Connected', cls: 'ok', title: bits.join(' · ') };
      }
      case 'checking': return { text: 'Checking…', cls: 'checking', title: '' };
      case 'online': return { text: 'Online', cls: 'checking', title: 'Reachable, not authenticated' };
      case 'needs-login': return { text: 'Sign-in needed', cls: 'err', title: 'Open BMP in a tab, log in, then retry' };
      case 'no-config-access': return { text: 'No config role', cls: 'err', title: 'Logged in, but no Configuration Access role' };
      case 'auth-failed': return { text: 'Auth failed', cls: 'err', title: 'Check the profile username and password' };
      case 'server-down': return { text: 'Server down', cls: 'err', title: '' };
      case 'unreachable': return { text: s.networkOffline ? 'No network' : 'Unreachable', cls: 'err', title: '' };
      case 'needs-access': return { text: 'Grant access', cls: 'err', title: 'The extension needs site access to this BMP server. Grant it in the browser to connect.' };
      default: return { text: 'Idle', cls: 'idle', title: '' };
    }
  }

  /** A server profile as a Carbon-style row: monogram tile, name + a Current
   *  pill, url, and inline connection status. The active/connected profile gets
   *  a green keyline; others read as Idle. Row-click selects; Edit shows on hover. */
  private renderProfileRow(profile: ServerProfile): HTMLElement {
    const isActive = profile.id === shared.settings.activeProfileId;
    const urlDisplay = profile.bmpUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const whoDisplay = profile.bmpUser || 'browser session';
    const origin = originPatternFor(profile.bmpUrl);
    const noAccess = !!origin && this.accessByOrigin.get(origin) === false;

    // Status only when it says something: connection problems / checking.
    // "Connected" is already told by the green keyline on the current row,
    // and "Idle" told nothing — both gone so name + url get the full width.
    let status: HTMLElement | null;
    if (noAccess && origin) {
      status = h('button', {
        class: 'prof-noaccess',
        'data-action': 'grant-access',
        'data-grant-origin': origin,
        title: 'CREV has no permission for this server’s site. Click to grant it (standard browser prompt).',
      }, 'No access');
    } else if (isActive) {
      const s = this.profileStatus();
      status = s.cls === 'ok' ? null : h('span', { class: 'prof-status', ...(s.title ? { title: s.title } : {}) },
        h('span', { class: `prof-dot ${s.cls}` }),
        s.text,
      );
    } else {
      status = null;
    }

    return h('div', {
      class: `prof${isActive ? ' cur' : ''}`,
      'data-action': 'select-profile',
      'data-profile-id': profile.id,
    },
      h('div', { class: 'prof-av' }, this.initials(profile.label)),
      h('div', { class: 'prof-body' },
        h('div', { class: 'prof-nm' },
          h('span', { class: 'prof-nm-text' }, profile.label),
          isActive ? h('span', { class: 'prof-curtag' }, 'Current') : null,
        ),
        h('div', { class: 'prof-url' }, `${urlDisplay} · ${whoDisplay}`),
      ),
      status,
      h('button', {
        class: 'prof-edit',
        'data-action': 'edit-profile',
        'data-edit-profile': profile.id,
        title: 'Edit server',
      }, 'Edit'),
    );
  }

  /** A boolean setting as a label-left / toggle-right row — our control style,
   *  replacing the raw browser checkbox. The input keeps its id so the existing
   *  change listeners bind unchanged. */
  private settingRow(
    id: string,
    name: string,
    hint: string | null,
    checked: boolean,
    hintTitle?: string,
  ): HTMLElement {
    return h('label', { class: 'setting-row' },
      h('span', { class: 'setting-text' },
        h('span', { class: 'setting-name' }, name),
        hint
          ? h('span', { class: 'setting-hint', ...(hintTitle ? { title: hintTitle } : {}) }, hint)
          : null,
      ),
      h('span', { class: 'toggle' },
        h('input', { type: 'checkbox', class: 'toggle-input', id, checked }),
        h('span', { class: 'toggle-track', 'aria-hidden': 'true' }),
      ),
    );
  }

  /** AI assistant — a server-row-twin card (collapsed) that expands the config
   *  form. The assistant only appears in the editor / studio once a key is
   *  stored. Card shows READY / UNTESTED + last-test latency; the row / Edit /
   *  Set up expands the existing provider / model / key / test form. */
  private renderAiSection(): HTMLElement {
    const wrap = h('div', { class: 'ai-settings' }, this.renderAiCard());
    if (this.aiExpanded) wrap.appendChild(this.renderAiForm());
    return wrap;
  }

  /** The collapsed card: sparkle (20px, purple, no tile), name + status pill,
   *  a mono provider/model line, and right-side latency + Edit / Set up. */
  private renderAiCard(): HTMLElement {
    const stored = shared.settings.ai;
    const configured = this.aiConfigured;
    const lastTest = stored?.lastTest;
    const verified = configured && !!lastTest?.ok;
    const providerLabel = stored ? PROVIDERS[stored.provider].label : '';
    const model = stored?.model ?? '';

    const spark = h('span', { class: 'ai-card-spark', 'aria-hidden': 'true' }, svg(ICON_SPARKLE));

    // No READY/UNTESTED pill — the green keyline + connection dot + latency already say "ready"; an
    // untested-but-configured card simply shows neither (a plain card), so absence carries the state.
    const name = h('div', { class: 'ai-card-nm' }, 'AI Assistant');

    const ln2 = configured
      ? `${providerLabel} · ${model} · key saved`
      : 'Bring your own API key · Anthropic, OpenAI, DeepSeek, Grok';

    const right = h('div', { class: 'ai-card-right' });
    if (configured) {
      if (verified) {
        right.appendChild(h('span', { class: 'ai-card-dot' }));
        right.appendChild(h('span', { class: 'ai-card-latency' }, lastTest ? `${lastTest.ms} ms` : ''));
      }
      right.appendChild(h('button', {
        class: 'ai-card-edit', 'data-action': 'ai-expand',
        title: this.aiExpanded ? 'Close' : 'Edit AI settings',
      }, this.aiExpanded ? 'Close' : 'Edit'));
    } else {
      right.appendChild(h('button', { class: 'btn btn-small', 'data-action': 'ai-expand' }, 'Set up'));
    }

    return h('div', {
      class: `ai-card${verified ? ' ready' : ''}${this.aiExpanded ? ' expanded' : ''}`,
      'data-action': 'ai-expand',
      role: 'button',
      title: configured ? 'AI assistant settings' : 'Set up the AI assistant',
    },
      spark,
      h('div', { class: 'ai-card-meta' }, name, h('div', { class: 'ai-card-ln2' }, ln2)),
      right,
    );
  }

  /** The expanded configuration form (provider / model / key / test). Reused
   *  verbatim from the previous inline section; the card above toggles it. */
  private renderAiForm(): HTMLElement {
    const stored = shared.settings.ai;
    const provider: AiProviderId = this.aiProviderDraft ?? stored?.provider ?? 'anthropic';
    const meta = PROVIDERS[provider];
    const model = this.aiModelDraft ?? stored?.model ?? meta.defaultModel;
    const showKeyInput = !this.aiConfigured || this.aiReplacingKey;

    const providerSelect = h('select', { class: 'field-input ai-select', id: 'ai-provider' },
      ...AI_PROVIDER_IDS.map(id => h('option', {
        value: id,
        ...(id === provider ? { selected: 'selected' } : {}),
      }, PROVIDERS[id].label)),
    );

    // Model datalist — provider suggestions plus any live-loaded ids.
    const modelOptions = [...new Set([...meta.suggestedModels, ...this.aiModelOptions])];
    const dataList = h('datalist', { id: 'ai-models' },
      ...modelOptions.map(m => h('option', { value: m })),
    );

    const statusEl = this.aiTestStatus
      ? h('span', { class: `ai-conn-status ${this.aiTestStatus.ok ? 'ok' : 'err'}` }, this.aiTestStatus.text)
      : this.aiTesting
        ? h('span', { class: 'ai-conn-status' }, 'Testing…')
        : null;

    const keyRow = showKeyInput
      ? h('div', { class: 'field-group' },
          h('label', { class: 'field-label' }, this.aiConfigured ? 'New API key' : 'API key'),
          h('div', { class: 'field-row ai-key-row' },
            h('input', { class: 'field-input', id: 'ai-key', type: 'password', placeholder: 'paste key', autocomplete: 'off', value: this.aiKeyDraft }),
            h('button', { class: 'btn btn-accent btn-small', 'data-action': 'ai-save' }, 'Save'),
            this.aiReplacingKey ? h('button', { class: 'btn btn-small', 'data-action': 'ai-replace-cancel' }, 'Cancel') : null,
          ),
          h('span', { class: 'field-hint' }, 'Stored encrypted on this device. Sent only to the provider you choose.'),
        )
      : h('div', { class: 'field-group' },
          h('label', { class: 'field-label' }, 'API key'),
          h('div', { class: 'field-row ai-key-row' },
            h('span', { class: 'ai-key-saved' }, '•••••••••••• saved'),
            h('button', { class: 'btn btn-small', 'data-action': 'ai-replace' }, 'Replace'),
            h('button', { class: 'btn btn-danger btn-small', 'data-action': 'ai-remove' }, 'Remove'),
          ),
        );

    return h('div', { class: 'ai-form' },
      h('div', { class: 'field-group' },
        h('label', { class: 'field-label' }, 'Provider'),
        providerSelect,
      ),
      h('div', { class: 'field-group' },
        h('label', { class: 'field-label' }, 'Model'),
        h('div', { class: 'field-row ai-key-row' },
          h('input', { class: 'field-input', id: 'ai-model', value: model, list: 'ai-models', autocomplete: 'off', placeholder: meta.defaultModel }),
          meta.openAiCompat ? h('button', { class: 'footer-action', 'data-action': 'ai-load-models', title: 'Load the provider model list' }, 'Load list') : null,
        ),
        dataList,
      ),
      keyRow,
      // Save provider/model without re-entering the key (only when configured
      // and not currently replacing the key).
      this.aiConfigured && !this.aiReplacingKey
        ? h('div', { class: 'field-row ai-conn-row' },
            h('button', { class: 'btn btn-accent btn-small', 'data-action': 'ai-save' }, 'Save changes'),
            h('button', { class: 'footer-action', 'data-action': 'ai-test' }, 'Test connection'),
            statusEl,
          )
        : (statusEl ? h('div', { class: 'field-row ai-conn-row' }, statusEl) : null),
    );
  }

  /** The quiet footer strip. Consolidates the mostly-informational, low-weight
   *  bits that don't each deserve a section: keyboard reference (expandable),
   *  the cache/reset utility actions, and the version line. One hairline sets
   *  it apart from the real controls above. */
  private renderFooter(rerender: () => void): HTMLElement {
    const cacheInfo: (HTMLElement | string)[] = [`${shared.cacheCount} cached`];
    if (this.cacheBytes != null && this.cacheBytes > 0) {
      cacheInfo.push(h('span', {
        class: 'connect-meta-bytes',
        title: `${this.cacheBytes.toLocaleString()} bytes of ~10 MB quota`,
      }, ` · ${formatBytes(this.cacheBytes)}`));
    }

    return h('div', { class: 'connect-footer' },
      // Keyboard reference — a quiet expandable link, not a titled section.
      this.renderReferenceDisclosure(rerender),

      this.cacheQuotaWarning
        ? h('div', { class: 'cache-quota-banner' },
            'Storage quota reached. Older cache entries are being evicted. ',
            h('button', { class: 'btn btn-small btn-ghost', 'data-action': 'reset-all', title: 'Wipe cache + enrichment to recover headroom' }, 'Reset'),
          )
        : null,

      // Utility actions — cache count + Clear + Reset as quiet links. Reset
      // is guarded by a confirm modal, so it doesn't need the red box any more.
      h('div', { class: 'footer-actions' },
        h('span', { class: 'footer-cache' }, ...cacheInfo),
        h('span', { class: 'footer-spacer' }),
        h('button', {
          class: 'footer-action',
          'data-action': 'clear-cache',
          disabled: shared.cacheCount === 0,
          title: shared.cacheCount === 0 ? 'Nothing to clear' : `Clear ${shared.cacheCount} cached objects (keeps activity log, favorites, settings)`,
        }, 'Clear cache'),
        h('button', {
          class: 'footer-action footer-action--danger',
          'data-action': 'reset-all',
          title: 'Reset all internal state: cache, enrichment, activity log, context RIDs, history. Favorites + server profiles are kept.',
        }, 'Reset all'),
      ),

      // Version / update — the quietest line, at the very bottom.
      h('div', { class: 'footer-version' }, this.renderUpdateBanner()),
    );
  }

  /** Collapsible wrapper around the shortcuts/reference tables. Closed by
   *  default; presented as a quiet footer link, not a section header. */
  private renderReferenceDisclosure(rerender: () => void): HTMLElement {
    const wrap = h('div', { class: 'ref-disclosure' });
    const toggle = h('button', {
      class: 'ref-toggle',
      'aria-expanded': String(this.referenceOpen),
    },
      h('span', { class: `disclosure-caret${this.referenceOpen ? ' open' : ''}`, 'aria-hidden': 'true' }),
      h('span', { class: 'ref-toggle-label' }, 'Keyboard shortcuts'),
    );
    toggle.addEventListener('click', () => {
      this.referenceOpen = !this.referenceOpen;
      rerender();
    });
    wrap.appendChild(toggle);
    if (this.referenceOpen) wrap.appendChild(this.renderReference());
    return wrap;
  }

  /** Update banner — placed above the Quick reference card. Always renders
   *  something so the user knows we're tracking releases. */
  private renderUpdateBanner(): HTMLElement {
    const s = this.updateStatus;
    const current = chrome.runtime.getManifest().version;

    let body: (HTMLElement | string | null)[];
    let cls = 'update-banner';
    if (!s) {
      body = [
        h('span', { class: 'update-version' }, `v${current}`),
        h('span', { class: 'update-status' }, 'Checking for updates…'),
      ];
    } else if (s.error) {
      cls += ' update-banner--warn';
      body = [
        h('span', { class: 'update-version' }, `v${current}`),
        h('span', { class: 'update-status', title: s.error }, "Couldn't check for updates"),
      ];
    } else if (s.isUpdate && s.latest) {
      cls += ' update-banner--available';
      body = [
        h('span', { class: 'update-version' }, `v${current}`),
        h('span', { class: 'update-arrow' }, '→'),
        h('span', { class: 'update-latest' }, `v${s.latest}`),
        h('span', { class: 'update-status' }, 'available'),
      ];
    } else {
      body = [
        h('span', { class: 'update-version' }, `v${current}`),
        h('span', { class: 'update-status update-status--ok' }, 'Up to date'),
      ];
    }

    const panel = h('div', { class: cls },
      h('a', {
        class: 'update-link',
        href: s?.releasesUrl ?? 'https://github.com/HeinemannT/crev-inspector/releases',
        target: '_blank',
        rel: 'noopener',
        title: s?.checkedAt ? `Last checked ${new Date(s.checkedAt).toLocaleString()}` : 'View releases',
      }, ...body.filter(Boolean) as (HTMLElement | string)[]),
      h('button', {
        class: 'update-refresh',
        'data-action': 'update-refresh',
        title: 'Check now',
        'aria-label': 'Check for updates now',
      }, svg(ICON_REFRESH)),
    );
    this.updatePanel = panel;
    return panel;
  }

  /** Quick reference card — concise list of the keyboard shortcuts +
   *  pill interactions the user is likely to forget. Replaces the cramped
   *  shortcut row that ended with a mysterious "(?)". Each row is one
   *  action + one key chip; no prose. */
  private renderReference(): HTMLElement {
    // Suggested defaults from manifest.json. We show whichever the user
    // ACTUALLY has bound via chrome.commands.getAll — see loadCommandShortcuts.
    // If the user cleared a binding, we render "(not bound)" greyed so they
    // know it's available to assign; if their binding differs from the
    // default, we show the default greyed underneath as a reminder.
    type Row =
      | { kind: 'cmd'; action: string; command: string; defaultKey: string }
      | { kind: 'note'; action: string; key: string; kbd?: boolean };
    const groups: Array<{ title: string; rows: Row[] }> = [
      {
        title: 'Keyboard',
        rows: [
          { kind: 'cmd', action: 'Toggle side panel', command: 'open-sidebar', defaultKey: 'Ctrl+Shift+Y' },
          { kind: 'cmd', action: 'Toggle inspect on page', command: 'toggle-inspect', defaultKey: 'Ctrl+Shift+X' },
          { kind: 'cmd', action: 'Toggle blueprint mode', command: 'toggle-blueprint', defaultKey: 'Ctrl+Shift+B' },
          { kind: 'cmd', action: 'Open Extended Code', command: 'open-extended', defaultKey: 'Ctrl+Shift+E' },
        ],
      },
      {
        title: 'Pill (page badge)',
        rows: [
          { kind: 'note', action: 'Click', key: 'open in sidebar' },
          { kind: 'note', action: 'Double-click', key: 'quick inspector' },
          { kind: 'note', action: 'Alt-click', key: 'copy RID' },
          { kind: 'note', action: 'Shift-click', key: 'copy template ID' },
          { kind: 'note', action: 'Ctrl-click', key: 'copy namespace reference' },
        ],
      },
      {
        title: 'Inspect',
        rows: [
          { kind: 'note', action: 'Right-click an element', key: 'set context' },
          { kind: 'note', action: 'Crosshair icon', key: 'pick context from any pill' },
        ],
      },
    ];
    return h('div', { class: 'reference-card reference-card--muted' },
      ...groups.map(g => h('div', { class: 'reference-group' },
        h('div', { class: 'reference-group-title' }, g.title),
        h('dl', { class: 'reference-list' },
          ...g.rows.flatMap(r => [
            h('dt', { class: 'reference-action' }, r.action),
            h('dd', { class: 'reference-key' },
              r.kind === 'cmd'
                ? this.renderLiveShortcut(r.command, r.defaultKey)
                : r.kbd
                  ? h('kbd', { class: 'kbd' }, r.key)
                  : h('span', null, r.key)),
          ]),
        ),
      )),
      h('div', { class: 'reference-footnote' },
        'Shortcut not working? Reassign at ',
        h('a', { href: 'chrome://extensions/shortcuts', target: '_blank', rel: 'noopener' }, 'chrome://extensions/shortcuts'),
      ),
    );
  }

  /** Render a single command's live binding — actually-set key bold, default
   *  greyed underneath when different/unset. Updated asynchronously by
   *  loadCommandShortcuts() on activate(). */
  private renderLiveShortcut(command: string, defaultKey: string): HTMLElement {
    const wrap = h('div', { class: 'kbd-stack' });
    if (!this.shortcutsLoaded) {
      // Pre-load: show the default as a hint without claiming the user
      // hasn't bound it. The render() pass that follows loadCommandShortcuts
      // will swap in the authoritative value.
      wrap.appendChild(h('kbd', { class: 'kbd kbd--pending' }, defaultKey));
      return wrap;
    }
    const liveKey = this.commandShortcuts.get(command);
    if (liveKey) {
      wrap.appendChild(h('kbd', { class: 'kbd' }, liveKey));
      if (liveKey !== defaultKey) {
        wrap.appendChild(h('span', { class: 'kbd-default-hint', title: `Default: ${defaultKey}` }, `default: ${defaultKey}`));
      }
    } else {
      // Binding cleared — show the default greyed so the user knows what
      // it WOULD be and can re-set it via chrome://extensions/shortcuts.
      wrap.appendChild(h('span', { class: 'kbd-unbound' }, '(not bound)'));
      wrap.appendChild(h('span', { class: 'kbd-default-hint', title: `Default: ${defaultKey}` }, `default: ${defaultKey}`));
    }
    return wrap;
  }

  private renderProfileForm(rerender: () => void): HTMLElement {
    if (!this.editing) return h('div');
    const ep = this.editing;
    const isNew = ep.id === null;

    const passInput = h('input', {
      class: 'field-input', id: 'pf-pass', type: 'password',
      placeholder: 'password', value: ep.bmpPass,
    }) as HTMLInputElement;

    const card = h('div', { class: 'profile-card editing' },
      h('div', { class: 'profile-form' },
        h('div', { class: 'field-group' },
          h('label', { class: 'field-label' }, 'Label'),
          h('input', { class: 'field-input', id: 'pf-label', value: ep.label, placeholder: 'e.g. Production' }),
        ),
        h('div', { class: 'field-group' },
          h('label', { class: 'field-label' }, 'BMP URL'),
          h('input', { class: 'field-input', id: 'pf-url', value: ep.bmpUrl, placeholder: 'e.g. demo.corporater.dev/CorpoWebserver' }),
          // HTTP downgrade hint — inline, unobtrusive. Visible only when the
          // URL is non-empty and resolves to http:// (or starts with it bare).
          // We don't block save: BMP intranet instances sometimes only listen
          // on http and forcing TLS would lock users out. The hint nudges
          // toward HTTPS without nagging.
          h('span', { class: 'field-hint field-hint--security', id: 'pf-url-warn' },
            isInsecureUrl(ep.bmpUrl)
              ? [svg(ICON_WARNING), ' Password will be sent in clear over HTTP. Use https:// when available.']
              : '',
          ),
        ),
        h('div', { class: 'field-row' },
          h('div', { class: 'field-group' },
            h('label', { class: 'field-label' }, 'Username'),
            h('input', { class: 'field-input', id: 'pf-user', value: ep.bmpUser, placeholder: 'optional' }),
          ),
          h('div', { class: 'field-group' },
            h('label', { class: 'field-label' }, 'Password'),
            h('div', { class: 'field-with-toggle' },
              passInput,
              h('button', {
                type: 'button', class: 'pass-toggle', title: 'Show/hide password',
                onClick: () => {
                  const isHidden = passInput.type === 'password';
                  passInput.type = isHidden ? 'text' : 'password';
                  const btn = card.querySelector('.pass-toggle');
                  if (btn) {
                    btn.textContent = '';
                    btn.appendChild(svg(isHidden ? ICON_EYE_CLOSED : ICON_EYE_OPEN));
                  }
                },
              }, svg(ICON_EYE_OPEN)),
            ),
          ),
        ),
        // Discoverability: credentials are optional. Leaving them blank makes
        // the profile borrow whatever BMP session the browser already has —
        // the path that works under SSO / VPN / client-cert without storing
        // anything.
        h('span', { class: 'field-hint' },
          ep.bmpPass.trim()
            ? 'Uses your current BMP login if you have one, otherwise signs in with these credentials.'
            : 'Leave blank to use your current BMP login in this browser (works with SSO). Add a password to connect even when you are not logged in.'),
        h('div', { class: 'profile-form-actions' },
          h('button', { class: 'btn btn-accent btn-small', 'data-action': 'pf-save' }, 'Save'),
          h('button', { class: 'btn btn-small', 'data-action': 'pf-cancel' }, 'Cancel'),
          !isNew && h('button', { class: 'btn btn-danger btn-small', 'data-action': 'pf-delete' }, 'Delete'),
        ),
      ),
    );
    return card;
  }
}

function flashInvalid(input: HTMLInputElement) {
  input.classList.add('field-input--invalid');
  setTimeout(() => { input.classList.remove('field-input--invalid'); }, FLASH_INVALID_DURATION);
  input.focus();
}

/** True when the URL has an explicit `http://` scheme. Bare hostnames are
 *  treated as safe — normalizeUrl() upgrades them to https:// before any
 *  request goes out, so the warning shouldn't fire for "example.com". Only
 *  when the user explicitly downgrades. Exported for tests. */
export function isInsecureUrl(raw: string): boolean {
  return /^\s*http:\/\//i.test(raw);
}

/** Human-readable bytes formatter. Used by the connect-tab cache size hint
 *  next to "N cached". Resolves at 1 KB / 1 MB boundaries (binary-ish KiB
 *  rather than decimal — close enough for the user's mental model). */
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
