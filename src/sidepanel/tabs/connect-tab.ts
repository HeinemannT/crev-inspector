/**
 * Connect tab — server profiles, connection status, settings.
 */

import type { InspectorMessage, ServerProfile } from '../../lib/types';
import { h, render, svg } from '../../lib/dom';
import { delegate } from '../delegate';
import { ICON_EYE_OPEN, ICON_EYE_CLOSED } from '../utils';
import { S as shared, getTabPanel } from '../state';
import { FLASH_INVALID_DURATION } from '../../lib/constants';
import { confirmModal } from '../../lib/modal';
import { getUpdateStatus, refresh as refreshUpdate, type UpdateStatus } from '../../lib/version-check';
import type { Tab, SendFn } from './tab-types';

type EditingProfile = { id: string | null; label: string; bmpUrl: string; bmpUser: string; bmpPass: string };

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

  constructor(send: SendFn) {
    this.send = send;
  }

  activate() {
    this.send({ type: 'GET_SETTINGS' });
    this.send({ type: 'GET_CACHE_BYTES' });
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
      case 'CONNECTION_STATE':
      case 'PROFILE_SWITCHED':
        return !this.editing; // re-render unless user is editing a form
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

    const children: (HTMLElement | false | null)[] = [
      h('div', { class: 'section-header' },
        h('span', { class: 'section-title section-title--flush' }, 'Servers'),
        h('button', { class: 'btn btn-small', 'data-action': 'add-profile' }, '+ Add'),
      ),
    ];

    if (shared.settings.profiles.length === 0 && !this.editing) {
      children.push(h('div', { class: 'empty-state empty-state--padded' },
        'CREV Inspector examines BMP pages. Add a server below to get started.'));
    }

    for (const profile of shared.settings.profiles) {
      const isActive = profile.id === shared.settings.activeProfileId;
      if (this.editing?.id === profile.id) {
        children.push(this.renderProfileForm(rerender));
      } else {
        const urlDisplay = profile.bmpUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');
        children.push(
          h('div', {
            class: `profile-card${isActive ? ' active' : ''}`,
            'data-action': 'select-profile',
            'data-profile-id': profile.id,
          },
            h('div', { class: 'profile-radio' },
              h('input', { type: 'radio', name: 'profile', checked: isActive }),
            ),
            h('div', { class: 'profile-info' },
              h('div', { class: 'profile-label' }, profile.label),
              h('div', { class: 'profile-detail' }, `${urlDisplay} \u00b7 ${profile.bmpUser || '(no user)'}`),
            ),
            h('button', { class: 'btn btn-small profile-edit-btn', 'data-action': 'edit-profile', 'data-edit-profile': profile.id }, 'Edit'),
          ),
        );
      }
    }

    if (this.editing?.id === null) {
      children.push(this.renderProfileForm(rerender));
    }

    children.push(
      h('div', { class: 'field-group field-group--spaced' },
        h('label', { class: 'field-label field-label--inline' },
          h('input', { type: 'checkbox', class: 'checkbox-accent', id: 'auto-detect', checked: shared.settings.autoDetect }),
          'Auto-detect server from page URL',
        ),
      ),
      h('div', { class: 'field-group' },
        h('label', { class: 'field-label field-label--inline' },
          h('input', { type: 'checkbox', class: 'checkbox-accent', id: 'enrich-all', checked: shared.settings.enrichMode === 'all' }),
          'Include non-widget objects',
        ),
        h('span', { class: 'field-hint' }, 'Also labels inline RID elements that the widget size filter normally hides. Table rows aren’t covered. They navigate via anchor links and are filtered separately.'),
      ),
      this.cacheQuotaWarning
        ? h('div', { class: 'cache-quota-banner' },
            'Storage quota reached. Older cache entries are being evicted. ',
            h('button', { class: 'btn btn-small btn-ghost', 'data-action': 'reset-all', title: 'Wipe cache + enrichment to recover headroom' }, 'Reset'),
          )
        : null,
      h('div', { class: 'connect-footer' },
        h('span', { class: 'connect-meta' },
          `${shared.cacheCount} cached`,
          this.cacheBytes != null && this.cacheBytes > 0
            ? h('span', { class: 'connect-meta-bytes', title: `${this.cacheBytes.toLocaleString()} bytes of ~10 MB quota` }, ` · ${formatBytes(this.cacheBytes)}`)
            : null,
        ),
        // Disable when the cache is already empty — the red "danger" outline
        // was alarming for a routine action that had nothing to do.
        h('button', {
          class: 'btn btn-ghost btn-small',
          'data-action': 'clear-cache',
          disabled: shared.cacheCount === 0,
          title: shared.cacheCount === 0 ? 'Nothing to clear' : `Clear ${shared.cacheCount} cached objects (keeps activity log, favorites, settings)`,
        }, 'Clear cache'),
        // Bigger hammer — for when the extension is in a bad state and the
        // user wants a clean slate without losing server profiles/favorites.
        // Confirms inline (handler-level) because the action is one-tap-away
        // from "Clear" and the labels look similar; the title is the warning.
        h('button', {
          class: 'btn btn-ghost btn-small btn-danger-ghost',
          'data-action': 'reset-all',
          title: 'Reset all internal state: cache, enrichment, activity log, context RIDs, history. Favorites + server profiles are kept.',
        }, 'Reset all'),
      ),
      this.renderUpdateBanner(),
      this.renderReference(),
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

    // Live update for the HTTP-downgrade warning while editing the URL. We
    // don't re-render the whole tab on every keystroke (that would blur the
    // input + lose focus); just update the warning span in place.
    const urlInput = container.querySelector('#pf-url') as HTMLInputElement | null;
    const urlWarn = container.querySelector('#pf-url-warn');
    if (urlInput && urlWarn) {
      urlInput.addEventListener('input', () => {
        urlWarn.textContent = isInsecureUrl(urlInput.value)
          ? '⚠ Password will be sent in clear over HTTP. Use https:// when available.'
          : '';
      });
    }

    delegate(container, {
      test: () => {
        const btn = container.querySelector('[data-action="test"]');
        if (btn) btn.classList.add('spinning');
        this.send({ type: 'CONNECTION_TEST' });
      },
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
        if (!bmpUser.trim()) { flashInvalid(userInput); return; }

        const profile: ServerProfile = {
          id: this.editing.id ?? crypto.randomUUID(),
          label, bmpUrl, bmpUser, bmpPass,
        };
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
      'reset-all': async () => {
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
      },
    });
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
      }, '↻'),
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
          { kind: 'note', action: 'Cascade pill (↓)', key: 'jump to chain target' },
        ],
      },
      {
        title: 'Page tab',
        rows: [
          { kind: 'note', action: 'Right-click an element', key: 'set context' },
          { kind: 'note', action: 'Crosshair icon', key: 'pick context from any pill' },
        ],
      },
    ];
    return h('div', { class: 'reference-card' },
      h('div', { class: 'reference-title' }, 'Quick reference'),
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
          h('input', { class: 'field-input', id: 'pf-url', value: ep.bmpUrl, placeholder: 'e.g. cortex.theinemann.de/Steadfast' }),
          // HTTP downgrade hint — inline, unobtrusive. Visible only when the
          // URL is non-empty and resolves to http:// (or starts with it bare).
          // We don't block save: BMP intranet instances sometimes only listen
          // on http and forcing TLS would lock users out. The hint nudges
          // toward HTTPS without nagging.
          h('span', { class: 'field-hint field-hint--security', id: 'pf-url-warn' },
            isInsecureUrl(ep.bmpUrl)
              ? '⚠ Password will be sent in clear over HTTP. Use https:// when available.'
              : '',
          ),
        ),
        h('div', { class: 'field-row' },
          h('div', { class: 'field-group' },
            h('label', { class: 'field-label' }, 'Username'),
            h('input', { class: 'field-input', id: 'pf-user', value: ep.bmpUser, placeholder: 'admin' }),
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
