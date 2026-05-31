/**
 * Quick Profile Switcher — floating overlay for instant profile switching.
 * Triggered by clicking the header status area.
 * Number keys 1-9 for instant selection, Escape to dismiss.
 */

import { h } from '../lib/dom';
import { S, sendMessage } from './state';

let overlayEl: HTMLElement | null = null;
let dismissTimer: ReturnType<typeof setTimeout> | null = null;
let keyHandler: ((e: KeyboardEvent) => void) | null = null;
let hideTime = 0; // prevent open-after-close on same click (capture vs bubble race)

export function showProfileSwitcher(): void {
  // Already visible → dismiss
  if (overlayEl) { hideProfileSwitcher(); return; }
  // Guard: don't reopen if just closed on the same event cycle
  if (Date.now() - hideTime < 50) return;

  const profiles = S.settings.profiles;
  if (profiles.length === 0) {
    showEmpty();
    return;
  }

  const rows = profiles.map((p, i) => {
    const isActive = p.id === S.settings.activeProfileId;
    const num = i + 1;
    return h('div', {
      class: `ps-row${isActive ? ' ps-row--active' : ''}`,
      'data-profile-id': p.id,
      'data-index': String(num),
    },
      h('span', { class: 'ps-num' }, String(num)),
      h('span', { class: 'ps-label' }, p.label || p.bmpUrl),
      isActive && h('span', { class: 'ps-check' }, '\u2713'),
    );
  });

  overlayEl = h('div', { class: 'profile-switcher' },
    h('div', { class: 'ps-title' }, 'Switch Profile'),
    ...rows,
    h('div', { class: 'ps-hint' }, 'Press 1\u20139 or click \u00b7 Esc to close'),
  );

  document.body.appendChild(overlayEl);

  // Click handler
  overlayEl.addEventListener('click', (e) => {
    const row = (e.target as HTMLElement).closest<HTMLElement>('[data-profile-id]');
    if (row) {
      selectProfile(row.dataset.profileId!);
    }
  });

  // Reset dismiss timer on interaction
  overlayEl.addEventListener('mouseenter', resetDismissTimer);

  // Keyboard handler
  keyHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      hideProfileSwitcher();
      return;
    }
    const num = parseInt(e.key, 10);
    if (num >= 1 && num <= profiles.length) {
      e.preventDefault();
      selectProfile(profiles[num - 1].id);
    }
  };
  document.addEventListener('keydown', keyHandler, true);

  // Click outside to dismiss
  requestAnimationFrame(() => {
    document.addEventListener('click', outsideClickHandler, true);
  });

  // Auto-dismiss after 5 seconds
  resetDismissTimer();
}

export function hideProfileSwitcher(): void {
  if (overlayEl) {
    overlayEl.remove();
    overlayEl = null;
    hideTime = Date.now();
  }
  if (keyHandler) {
    document.removeEventListener('keydown', keyHandler, true);
    keyHandler = null;
  }
  document.removeEventListener('click', outsideClickHandler, true);
  if (dismissTimer) {
    clearTimeout(dismissTimer);
    dismissTimer = null;
  }
}

function selectProfile(profileId: string) {
  if (profileId !== S.settings.activeProfileId) {
    sendMessage({ type: 'SET_ACTIVE_PROFILE', profileId });
    S.settings = { ...S.settings, activeProfileId: profileId };
  }
  hideProfileSwitcher();
}

function showEmpty() {
  overlayEl = h('div', { class: 'profile-switcher' },
    h('div', { class: 'ps-title' }, 'No Profiles'),
    h('div', { class: 'ps-hint' }, 'Add a server in the Connect tab'),
  );
  document.body.appendChild(overlayEl);

  keyHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); hideProfileSwitcher(); }
  };
  document.addEventListener('keydown', keyHandler, true);
  requestAnimationFrame(() => {
    document.addEventListener('click', outsideClickHandler, true);
  });
  resetDismissTimer();
}

function outsideClickHandler(e: MouseEvent) {
  if (overlayEl && !overlayEl.contains(e.target as Node)) {
    hideProfileSwitcher();
  }
}

function resetDismissTimer() {
  if (dismissTimer) clearTimeout(dismissTimer);
  dismissTimer = setTimeout(() => hideProfileSwitcher(), 10_000);
}
