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

export function showToast(text: string, type: 'success' | 'error' | 'info') {
  const container = ensureContainer();

  const toast = document.createElement('div');
  toast.className = `crev-toast crev-toast--${type}`;
  toast.textContent = text;
  container.appendChild(toast);

  // Enforce max stacked
  while (container.children.length > MAX_TOASTS) {
    container.children[0].remove();
  }

  // Trigger enter animation
  requestAnimationFrame(() => {
    toast.classList.add('crev-toast--visible');
  });

  // Auto-dismiss
  setTimeout(() => {
    toast.classList.remove('crev-toast--visible');
    toast.classList.add('crev-toast--exit');
    setTimeout(() => toast.remove(), FADE_MS);
  }, AUTO_DISMISS_MS);
}
