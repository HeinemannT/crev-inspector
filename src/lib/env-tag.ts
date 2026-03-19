/**
 * Floating environment indicator tag — shows current profile + connection state.
 * Draggable, position persisted, opacity 0.25 idle → 1.0 on hover.
 */

const TAG_ID = 'crev-env-tag';
const POS_KEY = 'crev_env_tag_pos';

let tagEl: HTMLDivElement | null = null;
let dotEl: HTMLSpanElement | null = null;
let labelEl: HTMLSpanElement | null = null;

export function initEnvTag(label: string, state: 'connected' | 'disconnected' | 'not-configured') {
  if (tagEl) {
    updateEnvTag(label, state);
    return;
  }

  tagEl = document.createElement('div');
  tagEl.id = TAG_ID;

  dotEl = document.createElement('span');
  dotEl.className = 'crev-env-dot';

  labelEl = document.createElement('span');
  labelEl.className = 'crev-env-label';

  tagEl.appendChild(dotEl);
  tagEl.appendChild(labelEl);
  document.body.appendChild(tagEl);

  updateEnvTag(label, state);

  // Restore saved position
  chrome.storage.local.get(POS_KEY, (result) => {
    const pos = result[POS_KEY] as { right?: number; bottom?: number } | undefined;
    if (pos && tagEl) {
      tagEl.style.right = `${pos.right ?? 12}px`;
      tagEl.style.bottom = `${pos.bottom ?? 12}px`;
      tagEl.style.left = 'auto';
      tagEl.style.top = 'auto';
    }
  });

  // Draggable
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startRight = 0;
  let startBottom = 0;

  tagEl.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    startX = e.clientX;
    startY = e.clientY;
    if (tagEl) {
      const rect = tagEl.getBoundingClientRect();
      startRight = window.innerWidth - rect.right;
      startBottom = window.innerHeight - rect.bottom;
    }
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });

  function onMouseMove(e: MouseEvent) {
    if (!dragging || !tagEl) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const newRight = Math.max(0, startRight - dx);
    const newBottom = Math.max(0, startBottom - dy);
    tagEl.style.right = `${newRight}px`;
    tagEl.style.bottom = `${newBottom}px`;
    tagEl.style.left = 'auto';
    tagEl.style.top = 'auto';
  }

  function onMouseUp() {
    dragging = false;
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    // Persist position
    if (tagEl) {
      const rect = tagEl.getBoundingClientRect();
      const pos = {
        right: Math.round(window.innerWidth - rect.right),
        bottom: Math.round(window.innerHeight - rect.bottom),
      };
      chrome.storage.local.set({ [POS_KEY]: pos }).catch(() => {});
    }
  }
}

export function updateEnvTag(label: string, state: 'connected' | 'disconnected' | 'not-configured') {
  if (dotEl) {
    dotEl.className = `crev-env-dot crev-env-dot--${state}`;
  }
  if (labelEl) {
    labelEl.textContent = label || 'CREV';
  }
}

export function destroyEnvTag() {
  tagEl?.remove();
  tagEl = null;
  dotEl = null;
  labelEl = null;
}
