/**
 * Connect tab — server profiles, connection status, settings.
 */

import type { InspectorMessage, ServerProfile } from '../../lib/types';
import { h, render, svg } from '../../lib/dom';
import { delegate } from '../delegate';
import { ICON_REFRESH, ICON_EYE_OPEN, ICON_EYE_CLOSED } from '../utils';
import { S as shared } from '../state';
import type { Tab, SendFn } from './tab-types';

type EditingProfile = { id: string | null; label: string; bmpUrl: string; bmpUser: string; bmpPass: string };

export class ConnectTab implements Tab {
  private editing: EditingProfile | null = null;
  private send: SendFn;

  constructor(send: SendFn) {
    this.send = send;
  }

  activate() {
    this.send({ type: 'GET_SETTINGS' });
  }

  deactivate() {}

  handleMessage(msg: InspectorMessage): boolean {
    switch (msg.type) {
      case 'SETTINGS_DATA':
      case 'CONNECTION_STATE':
      case 'PROFILE_SWITCHED':
        return !this.editing; // re-render unless user is editing a form
      default:
        return false;
    }
  }

  render(container: HTMLElement) {
    const rerender = () => this.render(container);
    const status = this.connectStatus();

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
        h('span', { class: 'field-hint' }, 'Labels all findable RID objects, including table row links and other non-widget elements.'),
      ),
      h('div', { class: 'connect-footer' },
        h('span', { class: 'connect-meta' }, `${shared.cacheCount} objects cached`),
        h('button', { class: 'btn btn-danger btn-small', 'data-action': 'clear-cache' }, 'Clear'),
      ),
      h('div', { class: 'connect-footer connect-footer--flat' },
        h('span', { class: 'connect-meta' }, `v${chrome.runtime.getManifest().version}`),
      ),
      h('div', { class: 'shortcut-list' },
        h('kbd', { class: 'kbd' }, 'Ctrl+Shift+X'), 'Inspect',
        h('kbd', { class: 'kbd' }, 'Ctrl+Shift+E'), 'Extended Code',
        h('span', { class: 'shortcut-hint', title: 'If a shortcut is not recognized, reassign it at chrome://extensions/shortcuts' }, '(?)'),
      ),
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
    });
  }

  private connectStatus(): { cls: string; title: string; detail: string } {
    const s = shared.connState;
    const parts: string[] = [];
    if (s.version) parts.push(`BMP ${s.version}`);
    switch (s.display) {
      case 'not-configured':
        return { cls: '', title: 'Not configured', detail: shared.settings.profiles.length ? 'Select a server' : 'Add a server to connect' };
      case 'checking':
        return { cls: '', title: 'Checking\u2026', detail: s.profileLabel ?? '' };
      case 'connected': {
        if (s.workspace) parts.push(s.workspace);
        if (s.user && s.profileLabel) parts.push(`${s.user} @ ${s.profileLabel}`);
        if (s.responseMs != null) parts.push(`${s.responseMs}ms`);
        return { cls: 'ok', title: 'Connected', detail: parts.join(' \u00b7 ') };
      }
      case 'online': {
        if (s.authError) parts.push('auth failed');
        if (s.responseMs != null) parts.push(`${s.responseMs}ms`);
        return { cls: 'online', title: 'Online', detail: parts.join(' \u00b7 ') };
      }
      case 'auth-failed':
        return { cls: 'fail', title: 'Auth failed', detail: s.authError ?? 'Authentication failed' };
      case 'server-down':
        return { cls: 'fail', title: 'Server down', detail: 'BMP responded: down' };
      case 'unreachable':
        return { cls: 'fail', title: 'Unreachable', detail: 'Cannot reach server' };
    }
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
  setTimeout(() => { input.classList.remove('field-input--invalid'); }, 1500);
  input.focus();
}
