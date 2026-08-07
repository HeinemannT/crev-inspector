/**
 * Generic confirmation modal — used by both the editor and the sidepanel
 * object pane. Native confirm() is banned (badly styled, blocked by some
 * BMP themes, suppressed by SPA navigation). Styles live in components.css.
 */

import { h } from './dom';
import { readCommandActor } from './command-actor';

export interface ConfirmOpts {
  title: string;
  /** Body content — string or DOM element(s). */
  body: string | Node | Array<string | Node | null | false>;
  confirmLabel?: string;
  cancelLabel?: string;
  confirmVariant?: 'accent' | 'danger' | 'success';
  /** Verified actor for command-backed writes. */
  actor?: string;
}

export async function confirmCommandModal(opts: Omit<ConfirmOpts, 'actor'>): Promise<boolean> {
  const actor = await readCommandActor();
  return confirmModal({
    ...opts,
    actor: actor?.text ?? 'Command identity is not currently verified',
  });
}

export function confirmModal(opts: ConfirmOpts): Promise<boolean> {
  return new Promise(resolve => {
    const variant = opts.confirmVariant ?? 'accent';
    let resolved = false;
    const settle = (v: boolean) => {
      if (resolved) return;
      resolved = true;
      document.removeEventListener('keydown', onKey, true);
      backdrop.remove();
      // Restore focus to the element that had it before the modal opened
      if (previouslyFocused && previouslyFocused.focus) {
        try { previouslyFocused.focus(); } catch { /* ignore */ }
      }
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); settle(false); }
      else if (e.key === 'Enter' && document.activeElement !== cancelBtn) {
        // Don't confirm when the user is editing inside a text input/area —
        // Enter is part of the editing flow there, not a confirm signal.
        const active = document.activeElement as HTMLElement | null;
        const tag = active?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || active?.isContentEditable) return;
        e.stopPropagation(); settle(true);
      } else if (e.key === 'Tab') {
        // Focus trap — cycle between Cancel and Confirm
        const focusables: HTMLElement[] = [cancelBtn, confirmBtn];
        const active = document.activeElement as HTMLElement;
        const idx = focusables.indexOf(active);
        if (idx === -1) {
          e.preventDefault();
          confirmBtn.focus();
        } else {
          const nextIdx = e.shiftKey ? (idx + focusables.length - 1) % focusables.length
                                     : (idx + 1) % focusables.length;
          e.preventDefault();
          focusables[nextIdx].focus();
        }
      }
    };
    const cancelBtn = h('button', {
      class: 'btn',
      onClick: () => settle(false),
    }, opts.cancelLabel ?? 'Cancel') as HTMLButtonElement;
    const confirmBtn = h('button', {
      class: `btn btn-${variant}`,
      onClick: () => settle(true),
    }, opts.confirmLabel ?? 'OK') as HTMLButtonElement;

    const bodyEls: Array<string | Node | null | false> = Array.isArray(opts.body) ? opts.body : [opts.body];

    const dialog = h('div', {
      class: 'crev-modal',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'crev-modal-title',
    },
      h('h2', { class: 'crev-modal-title', id: 'crev-modal-title' }, opts.title),
      h('div', { class: 'crev-modal-body' }, ...bodyEls),
      opts.actor
        ? h('div', { class: 'crev-modal-actor', role: 'note' }, opts.actor)
        : null,
      h('div', { class: 'crev-modal-actions' }, cancelBtn, confirmBtn),
    );

    const backdrop = h('div', {
      class: 'crev-modal-backdrop',
      onClick: (e: MouseEvent) => { if (e.target === backdrop) settle(false); },
    }, dialog);

    const previouslyFocused = document.activeElement as HTMLElement | null;
    document.body.appendChild(backdrop);
    document.addEventListener('keydown', onKey, true);
    requestAnimationFrame(() => confirmBtn.focus());
  });
}
