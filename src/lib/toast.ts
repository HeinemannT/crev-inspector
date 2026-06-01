/**
 * Connection toast notifications — top-right, auto-dismiss, max 3 stacked.
 */

const CONTAINER_ID = 'crev-toast-container';
const MAX_TOASTS = 3;
const AUTO_DISMISS_MS = 3000;
const FADE_MS = 300;

function ensureContainer(): HTMLDivElement {
  let container = document.getElementById(CONTAINER_ID) as HTMLDivElement | null;
  if (!container) {
    container = document.createElement('div');
    container.id = CONTAINER_ID;
    document.body.appendChild(container);
  }
  return container;
}

/** Optional inline action button on a toast (e.g. "Reload"). When present
 *  the toast lingers longer so the user has time to click it. */
export interface ToastAction {
  label: string;
  onClick: () => void;
}

// Toasts carrying an action stay up longer — a 3s window is too short to
// read "saved, reload to see it" and decide to click.
const ACTION_DISMISS_MS = 8000;

export function showToast(
  text: string,
  type: 'success' | 'error' | 'info',
  action?: ToastAction,
) {
  const container = ensureContainer();

  const toast = document.createElement('div');
  toast.className = `crev-toast crev-toast--${type}`;

  let dismiss: () => void;

  if (action) {
    toast.classList.add('crev-toast--with-action');
    const label = document.createElement('span');
    label.className = 'crev-toast__text';
    label.textContent = text;
    const btn = document.createElement('button');
    btn.className = 'crev-toast__action';
    btn.textContent = action.label;
    btn.addEventListener('click', () => {
      action.onClick();
      dismiss();
    });
    toast.append(label, btn);
  } else {
    toast.textContent = text;
  }

  container.appendChild(toast);

  // Enforce max stacked
  while (container.children.length > MAX_TOASTS) {
    container.children[0].remove();
  }

  // Trigger enter animation
  requestAnimationFrame(() => {
    toast.classList.add('crev-toast--visible');
  });

  let fadeTimer: ReturnType<typeof setTimeout> | undefined;
  dismiss = () => {
    if (!toast.isConnected) return;
    toast.classList.remove('crev-toast--visible');
    toast.classList.add('crev-toast--exit');
    if (fadeTimer) clearTimeout(fadeTimer);
    fadeTimer = setTimeout(() => toast.remove(), FADE_MS);
  };

  // Auto-dismiss
  setTimeout(dismiss, action ? ACTION_DISMISS_MS : AUTO_DISMISS_MS);
}
