/**
 * Connect tab — server profiles, connection status, settings.
 */

import type { InspectorMessage, ServerProfile, CommandAuthMode } from '../../lib/types';
import { h, render, svg } from '../../lib/dom';
import { delegate } from '../delegate';
import { ICON_EYE_OPEN, ICON_EYE_CLOSED } from '../utils';
import { ICON_WARNING, ICON_CHEVRON, ICON_INFO, ICON_PENCIL, ICON_X } from '../../lib/icons';
import { S as shared, getTabPanel } from '../state';
import { FLASH_INVALID_DURATION } from '../../lib/constants';
import { confirmModal } from '../../lib/modal';
import { getUpdateStatus, type UpdateStatus } from '../../lib/version-check';
import { originPatternFor } from '../../lib/site-access';
import { requestOriginsInGesture } from '../site-access-strip';
import { PROVIDERS, AI_PROVIDER_IDS, parseCustomProviderJson, resolveProvider } from '../../lib/ai/providers';
import type { AiApiType, AiCustomProvider, AiProviderId } from '../../lib/ai/types';
import type { Tab, SendFn } from './tab-types';
import { unknownIdentityMap } from '../../lib/identity-map';

type EditingProfile = {
  id: string | null;
  label: string;
  bmpUrl: string;
  bmpUser: string;
  bmpPass: string;
  commandAuthMode: CommandAuthMode;
  commandAuthRevision?: string;
};

const CUSTOM_PROVIDER_TEMPLATE = `{
  "name": "OpenRouter",
  "vendor": "openrouter",
  "apiKey": "",
  "apiType": "openai",
  "models": [
    {
      "id": "anthropic/claude-sonnet-4",
      "name": "Claude Sonnet 4",
      "url": "https://openrouter.ai/api/v1",
      "toolCalling": true,
      "vision": true,
      "maxInputTokens": 200000,
      "maxOutputTokens": 64000,
      "maxTokensParam": "max_completion_tokens"
    }
  ]
}`;

function customProviderJson(provider?: AiCustomProvider): string {
  if (!provider) return CUSTOM_PROVIDER_TEMPLATE;
  return JSON.stringify({
    name: provider.name,
    vendor: provider.vendor,
    apiKey: '',
    apiType: provider.apiType,
    models: provider.models,
  }, null, 2);
}

interface AiCustomDraft {
  name: string;
  apiType: AiApiType;
  baseUrl: string;
  modelId: string;
}

function customDraftFromProvider(provider?: AiCustomProvider): AiCustomDraft {
  const source = provider ?? parseCustomProviderJson(CUSTOM_PROVIDER_TEMPLATE).provider;
  const model = source.models.find(item => item.toolCalling) ?? source.models[0];
  return {
    name: source.name,
    apiType: source.apiType,
    baseUrl: model.url,
    modelId: model.id,
  };
}

/** Apply the approachable single-endpoint fields to the advanced JSON without
 *  discarding extra model metadata a technical user may have added there. */
function mergeCustomProviderDraft(json: string, draft: AiCustomDraft, apiKey: string): string {
  const parsed = parseCustomProviderJson(json);
  const models = parsed.provider.models.map(model => ({ ...model }));
  const primaryIndex = Math.max(0, models.findIndex(model => model.toolCalling));
  const primary = models[primaryIndex];
  models[primaryIndex] = {
    ...primary,
    id: draft.modelId.trim(),
    name: primary.name === primary.id ? draft.modelId.trim() : primary.name,
    url: draft.baseUrl.trim(),
    toolCalling: true,
  };
  return JSON.stringify({
    name: draft.name.trim(),
    vendor: parsed.provider.vendor,
    apiKey: apiKey.trim(),
    apiType: draft.apiType,
    models,
  }, null, 2);
}

export class ConnectTab implements Tab {
  private editing: EditingProfile | null = null;
  private lastConnectionRenderKey: string | null = null;
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

  /** Close hook for the Connect-tab information dialog, if open. */
  private closeInformation: (() => void) | null = null;
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
  /** Unsaved custom-provider JSON. Plaintext keys live here only until Save. */
  private aiJsonDraft: string | null = null;
  /** Human-facing fields for the primary custom endpoint. The advanced JSON
   *  remains the lossless source for extra models/capabilities. */
  private aiCustomDraft: AiCustomDraft | null = null;
  private aiJsonOpen = false;
  private aiJsonHelpOpen = false;
  private aiJsonError: string | null = null;
  private aiJsonSaving = false;
  /** Draft of the unsaved API key, carried across re-renders so an async
   *  repaint (provider change, a status/model-list tick) can't wipe a key the
   *  user typed but hasn't Saved yet. Cleared once the key is saved/removed. */
  private aiKeyDraft = '';
  /** True when replacing an already-saved key (shows the key input again). */
  private aiReplacingKey = false;
  private aiTestStatus: { ok: boolean; text: string } | null = null;
  private aiTesting = false;
  private aiModelOptions: string[] = [];
  private aiModelsLoading = false;   // "Load list" is in flight — button shows a spinner label
  private aiModelMenuOpen = false;   // the unfiltered "browse all models" menu is open
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

  private async loadUpdateStatus(): Promise<void> {
    const status = await getUpdateStatus();
    this.updateStatus = status;
    if (this.updatePanel && document.body.contains(this.updatePanel)) {
      // Swap the banner in place without forcing a whole-tab re-render —
      // avoids losing scroll position / form focus when the check returns
      // while the user is editing a server profile.
      const mounted = this.updatePanel;
      const fresh = this.renderUpdateBanner();
      mounted.replaceWith(fresh);
      this.updatePanel = fresh;
    }
  }

  deactivate() {
    this.closeInformation?.();
  }

  handleMessage(msg: InspectorMessage): boolean {
    switch (msg.type) {
      case 'SETTINGS_DATA':
        this.aiConfigured = !!shared.settings.ai?.apiKeyEnc;
        return !this.editing;
      case 'CONNECTION_STATE': {
        const nextKey = this.connectionRenderKey();
        if (nextKey === this.lastConnectionRenderKey) {
          this.refreshConnectionMetadata();
          return false;
        }
        return !this.editing;
      }
      case 'PROFILE_SWITCHED':
        return !this.editing; // re-render unless user is editing a form
      case 'AI_CONFIG_SAVED':
        this.aiConfigured = msg.configured;
        if (msg.ok) {
          if (this.aiJsonSaving) this.aiJsonError = null;
          this.aiReplacingKey = false;
          this.aiTestStatus = null;
          this.aiKeyDraft = '';   // key is stored now — drop the unsaved draft
          this.aiProviderDraft = msg.provider ?? null;
          this.aiModelDraft = msg.model ?? null;
          if (msg.provider) shared.settings = {
            ...shared.settings,
            ai: {
              provider: msg.provider,
              model: msg.model ?? '',
              apiKeyEnc: msg.configured ? 'set' : '',
              ...(msg.customProvider ? { customProvider: msg.customProvider } : shared.settings.ai?.customProvider ? { customProvider: shared.settings.ai.customProvider } : {}),
            },
          };
          if (msg.customProvider) {
            this.aiJsonDraft = customProviderJson(msg.customProvider);
            this.aiCustomDraft = customDraftFromProvider(msg.customProvider);
          }
          if (!msg.configured) shared.settings = { ...shared.settings, ai: undefined };
        } else {
          if (this.aiJsonSaving) {
            this.aiJsonError = msg.error ?? 'Could not save provider JSON';
            this.aiJsonOpen = true;
          } else {
            this.aiTestStatus = { ok: false, text: msg.error ?? 'Could not save' };
          }
        }
        this.aiJsonSaving = false;
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
        this.aiModelsLoading = false;
        if (msg.ok && msg.models) { this.aiModelOptions = msg.models; this.aiModelMenuOpen = true; } // reveal the list on arrival
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
    this.lastConnectionRenderKey = this.connectionRenderKey();
    const rerender = () => this.render(container);

    const children: (HTMLElement | false | null)[] = [];

    // ── Connection ── server profiles as status-rail cards under one eyebrow.
    children.push(this.eyebrow('Connection'));

    if (shared.settings.profiles.length === 0 && !this.editing) {
      children.push(h('div', { class: 'empty-state empty-state--padded' },
        'Configuration Companion examines BMP pages. Add a server to get started.'));
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
      // Quiet list action closes the server list without becoming another card.
      children.push(h('button', { class: 'addbtn', 'data-action': 'add-profile' },
        h('span', { class: 'addbtn-plus', 'aria-hidden': 'true' }, '+'),
        'Add server',
      ));
    }

    children.push(
      // ── AI assistant ── the same status-rail card grammar as a server.
      this.eyebrow('AI assistant'),
      this.renderAiSection(),

      // ── Preferences ──
      this.eyebrow('Preferences'),
      this.settingRow('auto-detect', 'Auto-detect server from page URL',
        null, shared.settings.autoDetect),
      this.settingRow('enrich-all', 'Include non-widget objects',
        'Also labels inline elements (tables, others)',
        shared.settings.enrichMode === 'all'),

      // Local extension data belongs with Preferences. The persistent status
      // bar already carries the cache count, so this row only explains and
      // manages the stored data.
      this.renderLocalData(),
      this.cacheQuotaWarning
        ? h('div', { class: 'cache-quota-banner' },
            'Storage quota reached. Older cache entries are being evicted. ',
            h('button', { class: 'btn btn-small btn-ghost', 'data-action': 'reset-all', title: 'Wipe cache + enrichment to recover headroom' }, 'Reset'),
          )
        : null,
      this.renderUpdateBanner(),
      this.eyebrow('Keyboard shortcuts'),
      this.renderKeyboardShortcuts(),
      this.renderMoreInformationStrip(),
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
      if (provider === 'custom') {
        this.aiCustomDraft = customDraftFromProvider(shared.settings.ai?.customProvider);
        this.aiJsonDraft ??= customProviderJson(shared.settings.ai?.customProvider);
        this.aiModelDraft = this.aiCustomDraft.modelId;
      } else {
        this.aiModelDraft = PROVIDERS[provider].defaultModel;
      }
      this.aiModelOptions = [];
      this.aiModelsLoading = false;
      this.aiModelMenuOpen = false;
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
    const updateCustomDraft = () => {
      const name = (container.querySelector('#ai-custom-name') as HTMLInputElement | null)?.value ?? '';
      const apiType = (container.querySelector('#ai-custom-api-type') as HTMLSelectElement | null)?.value as AiApiType | undefined;
      const baseUrl = (container.querySelector('#ai-custom-url') as HTMLInputElement | null)?.value ?? '';
      const modelId = (container.querySelector('#ai-custom-model') as HTMLInputElement | null)?.value ?? '';
      if (apiType) this.aiCustomDraft = { name, apiType, baseUrl, modelId };
    };
    for (const id of ['#ai-custom-name', '#ai-custom-api-type', '#ai-custom-url', '#ai-custom-model']) {
      container.querySelector(id)?.addEventListener('input', updateCustomDraft);
      container.querySelector(id)?.addEventListener('change', updateCustomDraft);
    }
    container.querySelector('#ai-provider-json')?.addEventListener('input', (e) => {
      this.aiJsonDraft = (e.target as HTMLTextAreaElement).value;
      this.aiJsonError = null;
    });
    container.querySelector('.ai-json')?.addEventListener('toggle', (e) => {
      this.aiJsonOpen = (e.currentTarget as HTMLDetailsElement).open;
    });

    // Live update for the HTTP-downgrade warning while editing the URL. We
    // don't re-render the whole tab on every keystroke (that would blur the
    // input + lose focus); just update the warning span in place.
    const urlInput = container.querySelector('#pf-url') as HTMLInputElement | null;
    const urlWarn = container.querySelector('#pf-url-warn');
    if (urlInput && urlWarn) {
      urlInput.addEventListener('input', () => {
        urlWarn.textContent = '';
        const storedSelected = (container.querySelector('input[name="pf-command-auth"]:checked') as HTMLInputElement | null)?.value === 'stored';
        if (storedSelected && isInsecureUrl(urlInput.value)) {
          urlWarn.append(svg(ICON_WARNING), ' Password will be sent in clear over HTTP. Use https:// when available.');
        }
      });
    }

    delegate(container, {
      'add-profile': () => {
        this.editing = { id: null, label: '', bmpUrl: '', bmpUser: '', bmpPass: '', commandAuthMode: 'portal' };
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
        if (profile) {
          this.editing = { ...profile, commandAuthMode: profile.commandAuthMode ?? 'portal' };
          rerender();
        }
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
        const commandAuthMode = ((container.querySelector('input[name="pf-command-auth"]:checked') as HTMLInputElement | null)?.value
          ?? 'portal') as CommandAuthMode;

        if (!bmpUrl.trim()) { flashInvalid(urlInput); return; }
        if (commandAuthMode === 'stored' && (!bmpUser.trim() || !bmpPass)) {
          const invalid = !bmpUser.trim()
            ? userInput
            : container.querySelector('#pf-pass') as HTMLInputElement;
          flashInvalid(invalid);
          return;
        }
        const previous = this.editing.id
          ? shared.settings.profiles.find(p => p.id === this.editing?.id)
          : undefined;
        const profile: ServerProfile = {
          id: this.editing.id ?? crypto.randomUUID(),
          label,
          bmpUrl,
          bmpUser,
          bmpPass,
          commandAuthMode,
          commandAuthRevision: previous?.commandAuthRevision,
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
      'dismiss-auth-migration': (el) => {
        const profileId = el.dataset.profileId;
        if (!profileId) return;
        const notices = (shared.settings.commandAuthMigrationNotices ?? [])
          .filter(notice => notice.profileId !== profileId);
        shared.settings = { ...shared.settings, commandAuthMigrationNotices: notices };
        this.send({ type: 'SAVE_SETTINGS', settings: { commandAuthMigrationNotices: notices } });
        rerender();
      },
      'more-information': (el) => this.showMoreInformation(el),
      'ai-save': () => {
        const provider = (container.querySelector('#ai-provider') as HTMLSelectElement | null)?.value as AiProviderId | undefined;
        const keyInput = container.querySelector('#ai-key') as HTMLInputElement | null;
        const apiKey = keyInput?.value ?? '';
        if (!provider) return;
        // Keys are provider-specific. Keep the encrypted key only while editing
        // the current provider; switching provider requires an explicit key.
        const needsProviderKey = !this.aiConfigured || provider !== shared.settings.ai?.provider;
        if (needsProviderKey && !apiKey.trim()) {
          if (keyInput) flashInvalid(keyInput);
          return;
        }
        this.aiTestStatus = null;
        if (provider === 'custom') {
          const textarea = container.querySelector('#ai-provider-json') as HTMLTextAreaElement | null;
          const draft: AiCustomDraft = {
            name: (container.querySelector('#ai-custom-name') as HTMLInputElement | null)?.value ?? '',
            apiType: (container.querySelector('#ai-custom-api-type') as HTMLSelectElement | null)?.value as AiApiType,
            baseUrl: (container.querySelector('#ai-custom-url') as HTMLInputElement | null)?.value ?? '',
            modelId: (container.querySelector('#ai-custom-model') as HTMLInputElement | null)?.value ?? '',
          };
          try {
            const json = mergeCustomProviderDraft(
              textarea?.value ?? this.aiJsonDraft ?? CUSTOM_PROVIDER_TEMPLATE,
              draft,
              apiKey,
            );
            const parsed = parseCustomProviderJson(json);
            if (!parsed.apiKey && shared.settings.ai?.provider !== 'custom') {
              throw new Error('Add an API key the first time you save this endpoint');
            }
            const model = parsed.provider.models.find(item => item.toolCalling)?.id
              ?? parsed.provider.models[0].id;
            const origin = resolveProvider({
              provider: 'custom',
              model,
              customProvider: parsed.provider,
            }).origin;
            // Do not repaint plaintext credentials back into the form while
            // the service worker encrypts them.
            this.aiJsonDraft = customProviderJson(parsed.provider);
            this.aiCustomDraft = draft;
            this.aiModelDraft = model;
            this.aiJsonError = null;
            this.aiJsonSaving = true;
            void requestOriginsInGesture([origin]).then((granted) => {
              if (!granted) {
                this.aiJsonError = 'Site access to the custom endpoint was declined';
                rerender();
              }
            });
            this.send({ type: 'AI_SAVE_CUSTOM_PROVIDER', json });
            rerender();
          } catch (e) {
            this.aiJsonError = e instanceof Error ? e.message : String(e);
            this.aiJsonOpen = true;
            this.aiJsonSaving = false;
            rerender();
          }
          return;
        }
        const model = (container.querySelector('#ai-model') as HTMLInputElement | null)?.value.trim();
        if (!model) return;
        // Request the provider API origin's host permission INSIDE this click —
        // the SW's cross-origin fetch needs it, and the browser prompt requires
        // a user gesture. Already-granted origins resolve silently; a denial
        // surfaces as an inline status so the user knows why calls will fail.
        const origin = PROVIDERS[provider].origin;
        void requestOriginsInGesture([origin]).then((granted) => {
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
          this.aiCustomDraft = null;
          this.aiKeyDraft = '';
          this.aiModelOptions = [];
          this.aiModelsLoading = false;
          this.aiModelMenuOpen = false;
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
        if (this.aiModelsLoading) return;
        const provider = (this.aiProviderDraft ?? shared.settings.ai?.provider ?? 'anthropic');
        this.aiModelsLoading = true;
        this.send({ type: 'AI_LIST_MODELS', provider });
        rerender(); // show the "Loading…" state immediately (cleared on AI_MODELS_RESULT)
      },
      'ai-model-browse': () => { this.aiModelMenuOpen = !this.aiModelMenuOpen; rerender(); },
      'ai-model-pick': (el) => {
        const m = el.dataset.model;
        if (m) this.aiModelDraft = m;
        this.aiModelMenuOpen = false;
        rerender();
      },
      'reset-all': () => {
        void (async () => {
          const ok = await confirmModal({
            title: 'Reset all Companion state?',
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

  /** A quiet uppercase section label — gives the tab a spine without the weight
   *  of a titled header. Used above Connection / AI assistant / Preferences. */
  private eyebrow(text: string): HTMLElement {
    return h('div', { class: 'connect-eyebrow' }, text);
  }

  /** Live connection status for the active profile's row. */
  private connectionRenderKey(): string {
    const s = shared.connState;
    return JSON.stringify({
      display: s.display,
      identities: s.identities,
      version: s.version,
      blueprintSupported: s.blueprintSupported,
      profileLabel: s.profileLabel,
      workspace: s.workspace,
      authError: s.authError,
      networkOffline: s.networkOffline,
      environment: s.environment,
    });
  }

  /** Validation/freshness/latency updates do not alter the profile card's
   * structure. Patch its metadata in place so a quiet reconnect check cannot
   * clear focus, selection, scroll position, or an unrelated draft. */
  private refreshConnectionMetadata(): void {
    const row = getTabPanel('connect')?.querySelector<HTMLElement>('.prof.cur');
    if (!row) return;
    const status = this.profileStatus();
    const health = row.querySelector<HTMLElement>('.prof-health');
    if (health) {
      health.className = `prof-health ${status.cls}`;
      health.title = status.title || status.text;
      health.setAttribute('aria-label', status.text);
    }
    const state = row.querySelector<HTMLElement>('.prof-state');
    if (state && status.cls === 'ok') {
      const ms = shared.connState.responseMs;
      state.replaceChildren(...(ms != null
        ? [h('span', { class: 'prof-lat', title: status.title || 'Health-check latency' }, `${ms} ms`)]
        : []));
    }
  }

  private profileStatus(): { text: string; cls: string; title: string } {
    const s = shared.connState;
    switch (s.display) {
      case 'connected': {
        const bits: string[] = [];
        if (s.version) bits.push(`BMP ${s.version}`);
        const actor = (s.identities ?? unknownIdentityMap()).command;
        if (actor.status === 'connected' && actor.user) bits.push(`commands as ${actor.user}`);
        if (s.verifiedAt) bits.push(`last verified ${new Date(s.verifiedAt).toLocaleTimeString()}`);
        if (s.validation === 'validating') bits.push('checking now');
        return { text: 'Connected', cls: 'ok', title: bits.join(' · ') };
      }
      case 'checking': return { text: 'Checking…', cls: 'checking', title: '' };
      case 'reconnecting': return { text: 'Reconnecting…', cls: 'checking', title: 'Testing the BMP command channel' };
      case 'online': return { text: 'Online', cls: 'checking', title: 'Reachable, not authenticated' };
      case 'identity-mismatch': return { text: 'User mismatch', cls: 'err', title: 'Portal and command users differ. Reconnect after choosing the intended portal user.' };
      case 'command-failed': return { text: 'Commands unavailable', cls: 'err', title: s.authError ?? 'The server is reachable, but BMP commands are not responding' };
      case 'needs-login': return { text: 'Sign-in needed', cls: 'err', title: 'Open BMP in a tab, log in, then retry' };
      case 'no-config-access': return { text: 'No config role', cls: 'err', title: 'Logged in, but no Configuration Access role' };
      case 'auth-failed': return { text: 'Auth failed', cls: 'err', title: 'Check the profile username and password' };
      case 'server-down': return { text: 'Server down', cls: 'err', title: '' };
      case 'unreachable': return { text: s.networkOffline ? 'No network' : 'Unreachable', cls: 'err', title: '' };
      case 'needs-access': return { text: 'Grant access', cls: 'err', title: 'The extension needs site access to this BMP server. Grant it in the browser to connect.' };
      default: return { text: 'Idle', cls: 'idle', title: '' };
    }
  }

  /** A server profile as a quiet selected row. Purple marks the selected
   *  profile; the explicit dot independently reports connection health. */
  private renderProfileRow(profile: ServerProfile): HTMLElement {
    const isActive = profile.id === shared.settings.activeProfileId;
    const urlDisplay = profile.bmpUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const whoDisplay = profile.commandAuthMode === 'stored'
      ? 'Stored login'
      : 'Browser session';
    const origin = originPatternFor(profile.bmpUrl);
    const noAccess = !!origin && this.accessByOrigin.get(origin) === false;

    const s = isActive ? this.profileStatus() : null;
    // Rail health: the active profile's live state; every other card is idle.
    const health = noAccess ? 'err' : (s ? s.cls : 'idle');

    // Right side: a grant-access chip if blocked; else on the active card either
    // latency (connected — the rail already says "ok") or the problem status
    // (dot + text). Non-active cards show nothing but their idle rail.
    let right: HTMLElement | null = null;
    if (noAccess && origin) {
      right = h('button', {
        class: 'prof-noaccess',
        'data-action': 'grant-access',
        'data-grant-origin': origin,
        title: 'Companion has no permission for this server’s site. Click to grant it (standard browser prompt).',
      }, 'No access');
    } else if (s && s.cls === 'ok') {
      const ms = shared.connState.responseMs;
      right = ms != null
        ? h('span', { class: 'prof-lat', title: s.title || 'Health-check latency' }, `${ms} ms`)
        : null;
    } else if (s) {
      right = h('span', { class: 'prof-status', ...(s.title ? { title: s.title } : {}) },
        h('span', { class: `prof-dot ${s.cls}` }),
        s.text,
      );
    }

    return h('div', {
      class: `prof ${health}${isActive ? ' cur' : ''}`,
      'data-action': 'select-profile',
      'data-profile-id': profile.id,
    },
      h('span', {
        class: `prof-health ${health}`,
        title: noAccess ? 'Site access required' : (s?.title || (isActive ? s?.text : 'Inactive server')),
        'aria-label': noAccess ? 'Site access required' : (s?.text || 'Inactive server'),
      }),
      h('div', { class: 'prof-body' },
        h('div', { class: 'prof-nm' },
          h('span', { class: 'prof-nm-text' }, profile.label),
        ),
        h('div', { class: 'prof-url' }, `${urlDisplay} · ${whoDisplay}`),
        this.renderAuthMigrationNotice(profile),
      ),
      h('div', { class: 'prof-right connect-card-right' },
        h('div', { class: 'prof-state connect-card-state' }, right),
        h('button', {
          class: 'prof-edit connect-card-edit',
          'data-action': 'edit-profile',
          'data-edit-profile': profile.id,
          title: 'Edit server',
          'aria-label': 'Edit server',
        }, svg(ICON_PENCIL)),
      ),
    );
  }

  private renderAuthMigrationNotice(profile: ServerProfile): HTMLElement | null {
    const notice = shared.settings.commandAuthMigrationNotices?.find(item => item.profileId === profile.id);
    if (!notice) return null;
    return h('div', { class: 'prof-auth-migration', role: 'status' },
      h('span', null,
        `Configuration commands now use the stored login ${notice.user}. Your BMP page remains signed in as the browser user.`),
      h('button', {
        type: 'button',
        'data-action': 'dismiss-auth-migration',
        'data-profile-id': profile.id,
        title: 'Dismiss this migration notice',
      }, 'Dismiss'),
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

  /** AI assistant — a server-row-twin row (collapsed) that expands the config
   *  form. The assistant only appears in the editor / studio once a key is
   *  stored. Card shows READY / UNTESTED + last-test latency; the row / Edit /
   *  Set up expands the existing provider / model / key / test form. */
  private renderAiSection(): HTMLElement {
    const wrap = h('div', { class: 'ai-settings' }, this.renderAiCard());
    if (this.aiExpanded) wrap.appendChild(this.renderAiForm());
    return wrap;
  }

  /** The collapsed row: one health dot, name + provider/model metadata, and
   *  right-side latency + Edit / Set up. */
  private renderAiCard(): HTMLElement {
    const stored = shared.settings.ai;
    const configured = this.aiConfigured;
    const lastTest = stored?.lastTest;
    const verified = configured && !!lastTest?.ok;
    const providerLabel = stored
      ? (stored.provider === 'custom' ? stored.customProvider?.name ?? 'Custom' : PROVIDERS[stored.provider].label)
      : '';
    const model = stored?.model ?? '';

    const name = h('div', { class: 'ai-card-nm' }, 'AI Assistant');

    const ln2 = configured
      ? `${providerLabel} · ${model} · key saved`
      : 'Bring your own API key · Anthropic, OpenAI, DeepSeek, Grok';

    const state = h('div', { class: 'ai-card-state connect-card-state' });
    const right = h('div', { class: 'ai-card-right connect-card-right' }, state);
    if (configured) {
      if (verified) {
        state.appendChild(h('span', { class: 'ai-card-latency' }, lastTest ? `${lastTest.ms} ms` : ''));
      }
      right.appendChild(h('button', {
        class: 'ai-card-edit connect-card-edit', 'data-action': 'ai-expand',
        title: this.aiExpanded ? 'Close' : 'Edit AI settings',
        'aria-label': this.aiExpanded ? 'Close AI settings' : 'Edit AI settings',
      }, svg(this.aiExpanded ? ICON_X : ICON_PENCIL)));
    } else {
      state.remove();
      right.classList.add('ai-card-right--setup');
      right.appendChild(h('button', {
        class: 'btn btn-small',
        'data-action': 'ai-expand',
        title: this.aiExpanded ? 'Close AI settings' : 'Set up the AI assistant',
      }, this.aiExpanded ? 'Close' : 'Set up'));
    }

    const health = verified ? 'ready' : (lastTest && !lastTest.ok ? 'error' : 'idle');
    const healthLabel = verified
      ? 'AI connection verified'
      : health === 'error' ? 'Last AI connection test failed'
        : configured ? 'AI connection not tested' : 'AI assistant not configured';

    return h('div', {
      class: `ai-card ${health}${this.aiExpanded ? ' expanded' : ''}`,
      title: configured ? 'AI assistant settings' : 'Set up the AI assistant',
    },
      h('span', { class: `ai-card-health ${health}`, title: healthLabel, 'aria-label': healthLabel }),
      h('div', { class: 'ai-card-meta' }, name, h('div', { class: 'ai-card-ln2' }, ln2)),
      right,
    );
  }

  /** Expanded provider configuration. Built-ins use model + key; selecting
   *  Custom reveals approachable endpoint fields and optional advanced JSON. */
  private renderAiForm(): HTMLElement {
    const stored = shared.settings.ai;
    const provider: AiProviderId = this.aiProviderDraft ?? stored?.provider ?? 'anthropic';
    const custom = stored?.customProvider;
    const customDraft = this.aiCustomDraft ?? customDraftFromProvider(custom);
    const model = provider === 'custom'
      ? customDraft.modelId
      : this.aiModelDraft ?? stored?.model ?? PROVIDERS[provider].defaultModel;
    const meta = provider === 'custom' ? null : PROVIDERS[provider];
    const providerChanged = provider !== stored?.provider;
    const showKeyInput = !this.aiConfigured || this.aiReplacingKey || providerChanged;

    const providerSelect = h('select', { class: 'field-input ai-select', id: 'ai-provider' },
      ...([...AI_PROVIDER_IDS, 'custom' as const]).map(id => h('option', {
        value: id,
        ...(id === provider ? { selected: 'selected' } : {}),
      }, id === 'custom' ? 'Custom endpoint…' : PROVIDERS[id].label)),
    );
    (providerSelect as HTMLSelectElement).value = provider;

    // Model list — provider suggestions plus any live-loaded ids. A native <datalist> FILTERS its
    // options by the input's current value, so once a model is typed you can't see the others; this
    // custom menu (toggled by the caret) always lists them ALL, unfiltered.
    const modelOptions = meta ? [...new Set([...meta.suggestedModels, ...this.aiModelOptions])] : [];
    const modelMenu = (this.aiModelMenuOpen && modelOptions.length)
      ? h('div', { class: 'ai-model-menu' },
          ...modelOptions.map(m => {
            return h('button', {
              class: 'ai-model-opt' + (m === model ? ' sel' : ''), type: 'button',
              'data-action': 'ai-model-pick', 'data-model': m,
            },
              m,
            );
          }))
      : null;

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

    const customFields = provider === 'custom'
      ? h('div', { class: 'ai-custom-fields' },
          h('div', { class: 'ai-custom-intro' },
            h('span', { class: 'field-hint' }, 'Connect one OpenAI- or Anthropic-compatible endpoint.'),
            h('button', {
              class: 'btn-micro help-btn ai-custom-help',
              type: 'button',
              'aria-label': 'Custom endpoint help',
              'aria-expanded': this.aiJsonHelpOpen ? 'true' : 'false',
              'aria-controls': 'ai-provider-json-help',
              onClick: (event: Event) => {
                event.preventDefault();
                event.stopPropagation();
                this.aiJsonHelpOpen = !this.aiJsonHelpOpen;
                const button = event.currentTarget as HTMLButtonElement;
                button.setAttribute('aria-expanded', this.aiJsonHelpOpen ? 'true' : 'false');
                const help = button.closest('.ai-custom-fields')?.querySelector<HTMLElement>('#ai-provider-json-help');
                if (help) help.hidden = !this.aiJsonHelpOpen;
              },
            }, '?'),
          ),
          h('div', {
            class: 'ai-json-help-text',
            id: 'ai-provider-json-help',
            hidden: !this.aiJsonHelpOpen,
          },
            h('p', {}, 'Choose the request format the endpoint implements. The base URL should stop before ', h('code', {}, '/chat/completions'), ' or ', h('code', {}, '/v1/messages'), '.'),
            h('p', {}, 'Advanced JSON supports additional models, vision limits and token-parameter overrides.'),
          ),
          h('div', { class: 'ai-custom-grid' },
            h('div', { class: 'field-group' },
              h('label', { class: 'field-label', for: 'ai-custom-name' }, 'Name'),
              h('input', { class: 'field-input', id: 'ai-custom-name', value: customDraft.name, placeholder: 'Company Gateway' }),
            ),
            h('div', { class: 'field-group' },
              h('label', { class: 'field-label', for: 'ai-custom-api-type' }, 'API format'),
              h('select', { class: 'field-input', id: 'ai-custom-api-type' },
                h('option', { value: 'openai', ...(customDraft.apiType === 'openai' ? { selected: 'selected' } : {}) }, 'OpenAI compatible'),
                h('option', { value: 'anthropic', ...(customDraft.apiType === 'anthropic' ? { selected: 'selected' } : {}) }, 'Anthropic compatible'),
              ),
            ),
          ),
          h('div', { class: 'field-group' },
            h('label', { class: 'field-label', for: 'ai-custom-url' }, 'Base URL'),
            h('input', { class: 'field-input', id: 'ai-custom-url', value: customDraft.baseUrl, placeholder: 'https://api.example.com/v1' }),
          ),
          h('div', { class: 'field-group' },
            h('label', { class: 'field-label', for: 'ai-custom-model' }, 'Model ID'),
            h('input', { class: 'field-input', id: 'ai-custom-model', value: customDraft.modelId, placeholder: 'model-name' }),
          ),
          h('details', { class: 'ai-json', ...(this.aiJsonOpen ? { open: true } : {}) },
            h('summary', {}, 'Advanced provider JSON'),
            h('textarea', {
              class: 'field-input ai-json-input',
              id: 'ai-provider-json',
              spellcheck: 'false',
              value: this.aiJsonDraft ?? customProviderJson(custom),
            }),
            this.aiJsonError ? h('div', { class: 'ai-json-error', role: 'alert' }, this.aiJsonError) : null,
            h('span', { class: 'field-hint ai-json-note' }, 'Extra models and capabilities are preserved when you save the fields above.'),
          ),
        )
      : null;

    return h('div', { class: 'ai-form' },
      h('div', { class: 'field-group' },
        h('label', { class: 'field-label' }, 'Provider'),
        providerSelect,
        h('span', { class: 'field-hint' }, 'Messages and attached BMP context are sent directly to this provider.'),
      ),
      customFields,
      meta
        ? h('div', { class: 'field-group' },
            h('label', { class: 'field-label' }, 'Model'),
            h('div', { class: 'field-row ai-key-row' },
              h('div', { class: 'ai-model-combo' },
                h('input', { class: 'field-input', id: 'ai-model', value: model, autocomplete: 'off', placeholder: meta.defaultModel }),
                modelOptions.length
                  ? h('button', { class: 'ai-model-caret' + (this.aiModelMenuOpen ? ' open' : ''), type: 'button', 'data-action': 'ai-model-browse', title: 'Browse all models', 'aria-label': 'Browse all models' }, svg(ICON_CHEVRON))
                  : null,
                modelMenu,
              ),
              meta.openAiCompat
                ? h('button', { class: 'footer-action', 'data-action': 'ai-load-models', title: 'Load the provider model list', ...(this.aiModelsLoading ? { disabled: 'disabled' } : {}) }, this.aiModelsLoading ? 'Loading…' : 'Load list')
                : null,
            ),
          )
        : null,
      keyRow,
      h('div', { class: 'field-row ai-conn-row' },
        h('button', {
          class: 'btn btn-accent btn-small',
          'data-action': 'ai-save',
          ...(this.aiJsonSaving ? { disabled: true } : {}),
        }, this.aiJsonSaving ? 'Saving…' : 'Save configuration'),
        this.aiConfigured
          ? h('button', { class: 'footer-action', 'data-action': 'ai-test' }, 'Test connection')
          : null,
        statusEl,
      ),
    );
  }

  /** Local extension state is a Preferences row; the fixed status bar already
   *  owns the always-visible object count. */
  private renderLocalData(): HTMLElement {
    const storage = shared.cacheCount === 0
      ? 'No cached objects stored'
      : this.cacheBytes != null && this.cacheBytes > 0
        ? `${formatBytes(this.cacheBytes)} stored in this browser`
        : 'Stored in this browser';
    return h('div', { class: 'connect-local-data', role: 'group', 'aria-label': 'Local inspection data' },
      h('span', { class: 'setting-text' },
        h('span', { class: 'setting-name' }, 'Local inspection data'),
        h('span', {
          class: 'setting-hint',
          title: this.cacheBytes != null ? `${this.cacheBytes.toLocaleString()} bytes of ~10 MB quota` : '',
        }, storage),
      ),
      h('span', { class: 'connect-local-actions' },
        h('button', {
          class: 'footer-action',
          'data-action': 'clear-cache',
          disabled: shared.cacheCount === 0,
          title: shared.cacheCount === 0 ? 'Nothing to clear' : `Clear ${shared.cacheCount} cached objects (keeps activity log, favorites, settings)`,
        }, 'Clear cache'),
        h('button', {
          class: 'footer-action footer-action--danger',
          'data-action': 'reset-all',
          title: 'Reset cache, enrichment, activity log, context, and history. Favorites and server profiles are kept.',
        }, 'Reset…'),
      ),
    );
  }

  /** Current/up-to-date is deliberately absent. The slot becomes visible only
   *  when the background check finds something the user can act on. */
  private renderUpdateBanner(): HTMLElement {
    const s = this.updateStatus;
    const panel = h('div', { class: 'connect-update-slot' });
    if (s?.isUpdate && s.latest) {
      panel.appendChild(h('a', {
        class: 'connect-update-notice',
        href: s.releasesUrl ?? 'https://github.com/HeinemannT/configuration-companion/releases',
        target: '_blank',
        rel: 'noopener',
        title: s.checkedAt ? `Last checked ${new Date(s.checkedAt).toLocaleString()}` : 'View release',
      },
        h('span', null, `Configuration Companion v${s.latest} is available`),
        h('span', { class: 'connect-update-action' }, 'View release →'),
      ));
    }
    this.updatePanel = panel;
    return panel;
  }

  /** The four browser commands remain visible in Connect and reflect the
   *  user's actual Chrome bindings rather than merely the manifest defaults. */
  private renderKeyboardShortcuts(): HTMLElement {
    const rows = [
      { action: 'Toggle side panel', command: '_execute_action', defaultKey: 'Ctrl+Shift+Y' },
      { action: 'Toggle inspect on page', command: 'toggle-inspect', defaultKey: 'Ctrl+Shift+X' },
      { action: 'Toggle blueprint mode', command: 'toggle-blueprint', defaultKey: 'Ctrl+Shift+B' },
      { action: 'Open Extended Code', command: 'open-extended', defaultKey: 'Ctrl+Shift+E' },
    ];
    return h('div', { class: 'connect-shortcuts' },
      h('dl', { class: 'connect-shortcut-list' },
        ...rows.flatMap(row => [
          h('dt', null, row.action),
          h('dd', null, this.renderLiveShortcut(row.command, row.defaultKey)),
        ]),
      ),
      h('div', { class: 'connect-shortcut-tip' },
        h('span', null, 'Open in the address bar: '),
        h('code', null, 'chrome://extensions/shortcuts'),
      ),
    );
  }

  private renderMoreInformationStrip(): HTMLElement {
    return h('button', {
      class: 'connect-more-info',
      'data-action': 'more-information',
      'aria-haspopup': 'dialog',
      'aria-expanded': 'false',
      'aria-controls': 'connect-info-popover',
    },
      h('span', { class: 'connect-more-info-icon', 'aria-hidden': 'true' }, svg(ICON_INFO)),
      h('span', null, 'More information'),
      h('span', { class: 'connect-more-info-chevron', 'aria-hidden': 'true' }, svg(ICON_CHEVRON)),
    );
  }

  /** Popover reference kept deliberately concise: page-badge gestures and the
   *  purpose of the five main tabs. Keyboard bindings stay in Connect itself. */
  private showMoreInformation(trigger: HTMLElement): void {
    if (this.closeInformation) {
      this.closeInformation();
      return;
    }

    let dialog: HTMLElement;
    let closed = false;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
      }
    };
    const onOutsidePointer = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target || dialog.contains(target) || trigger.contains(target)) return;
      close();
    };
    const close = () => {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onOutsidePointer, true);
      dialog.remove();
      this.closeInformation = null;
      trigger.setAttribute('aria-expanded', 'false');
      trigger.focus();
    };
    const gestureRows = [
      ['Click', 'Open the object and copy its primary ID'],
      ['Double-click', 'Open Quick Inspector'],
      ['Alt + click', 'Copy the object RID'],
      ['Shift + click', 'Copy the instance ID'],
      ['Ctrl / Cmd + click', 'Copy an instance reference'],
    ];
    const tabRows = [
      ['Connect', 'Servers, AI setup, preferences, and shortcuts'],
      ['Inspect', 'Selected object and page layout'],
      ['Browse', 'Search cached objects by name or ID'],
      ['AI', 'Ask questions about the current workspace'],
      ['Log', 'Recent activity, changes, and errors'],
    ];
    const infoList = (rows: string[][]) => h('dl', { class: 'connect-info-list' },
      ...rows.flatMap(([term, description]) => [
        h('dt', null, term),
        h('dd', null, description),
      ]),
    );

    const triggerRect = trigger.getBoundingClientRect();
    dialog = h('div', {
      id: 'connect-info-popover',
      class: 'connect-info-dialog',
      role: 'dialog',
      'aria-label': 'Page badge and tab information',
      style: `bottom:${Math.max(8, window.innerHeight - triggerRect.top + 6)}px`,
    },
      h('div', { class: 'connect-info-body' },
        h('section', { class: 'connect-info-section' },
          h('h3', null, 'Page badges'),
          infoList(gestureRows),
        ),
        h('section', { class: 'connect-info-section' },
          h('h3', null, 'Tabs'),
          infoList(tabRows),
        ),
      ),
    );
    this.closeInformation = close;
    trigger.setAttribute('aria-expanded', 'true');
    document.body.appendChild(dialog);
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onOutsidePointer, true);
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
        wrap.appendChild(h('span', { class: 'kbd-default-hint' }, `default: ${defaultKey}`));
      }
    } else {
      // Binding cleared — show the default greyed so the user knows what
      // it WOULD be and can re-set it via chrome://extensions/shortcuts.
      wrap.appendChild(h('span', { class: 'kbd-unbound' }, '(not bound)'));
      wrap.appendChild(h('span', { class: 'kbd-default-hint' }, `default: ${defaultKey}`));
    }
    return wrap;
  }

  private renderProfileForm(rerender: () => void): HTMLElement {
    if (!this.editing) return h('div');
    const ep = this.editing;
    const isNew = ep.id === null;

    const passInput = h('input', {
      class: 'field-input', id: 'pf-pass', type: 'password',
      placeholder: 'password', value: ep.bmpPass, autocomplete: 'current-password',
    }) as HTMLInputElement;
    const stored = ep.commandAuthMode === 'stored';
    const commandMode = h('div', {
      class: 'command-auth-options',
      role: 'radiogroup',
      'aria-label': 'Configuration commands',
    },
      h('label', { class: `command-auth-option${stored ? '' : ' selected'}` },
        h('input', { type: 'radio', name: 'pf-command-auth', value: 'portal', checked: !stored }),
        h('span', { class: 'command-auth-copy' },
          h('strong', null, 'Use browser login'),
          h('span', null, 'Commands run as the user signed into this BMP page. Supports SSO.'),
        ),
      ),
      h('label', { class: `command-auth-option${stored ? ' selected' : ''}` },
        h('input', { type: 'radio', name: 'pf-command-auth', value: 'stored', checked: stored }),
        h('span', { class: 'command-auth-copy' },
          h('strong', null, 'Use stored configuration login'),
          h('span', null, 'Commands run as this account without changing the BMP page user.'),
        ),
      ),
    );

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
            stored && isInsecureUrl(ep.bmpUrl)
              ? [svg(ICON_WARNING), ' Password will be sent in clear over HTTP. Use https:// when available.']
              : '',
          ),
        ),
        h('div', { class: 'field-group command-auth-group' },
          h('span', { class: 'field-label' }, 'Configuration commands'),
          commandMode,
        ),
        h('div', { class: 'field-row command-auth-credentials', hidden: !stored },
          h('div', { class: 'field-group' },
            h('label', { class: 'field-label' }, 'Username'),
            h('input', { class: 'field-input', id: 'pf-user', value: ep.bmpUser, autocomplete: 'username' }),
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
        h('span', { class: 'field-hint command-auth-credentials-note', hidden: !stored },
          'The BMP page, workspace search, live CVO data, and downloads remain signed in as your browser user.'),
        h('div', { class: 'profile-form-actions' },
          h('button', { class: 'btn btn-accent btn-small', 'data-action': 'pf-save' }, 'Save'),
          h('button', { class: 'btn btn-small', 'data-action': 'pf-cancel' }, 'Cancel'),
          !isNew && h('button', { class: 'btn btn-danger btn-small', 'data-action': 'pf-delete' }, 'Delete'),
        ),
      ),
    );
    commandMode.querySelectorAll<HTMLInputElement>('input[name="pf-command-auth"]').forEach(input => {
      input.addEventListener('change', () => {
        const useStored = input.value === 'stored';
        card.querySelectorAll<HTMLElement>('.command-auth-credentials, .command-auth-credentials-note')
          .forEach(el => { el.hidden = !useStored; });
        commandMode.querySelectorAll('.command-auth-option').forEach(option => option.classList.remove('selected'));
        input.closest('.command-auth-option')?.classList.add('selected');
        const warning = card.querySelector('#pf-url-warn');
        const url = (card.querySelector('#pf-url') as HTMLInputElement | null)?.value ?? '';
        if (warning) {
          warning.textContent = '';
          if (useStored && isInsecureUrl(url)) {
            warning.append(svg(ICON_WARNING), ' Password will be sent in clear over HTTP. Use https:// when available.');
          }
        }
      });
    });
    return card;
  }
}

function flashInvalid(input: HTMLElement) {
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
