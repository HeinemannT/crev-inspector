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

  // Restore saved position + snap state
  chrome.storage.local.get(POS_KEY, (result) => {
    const pos = result[POS_KEY] as { right?: number; bottom?: number; snap?: string } | undefined;
    if (pos && tagEl) {
      tagEl.style.bottom = `${pos.bottom ?? 12}px`;
      tagEl.style.top = 'auto';
      if (pos.snap === 'left') {
        tagEl.classList.add('crev-env-tag--edge-left');
        tagEl.style.left = '0';
        tagEl.style.right = 'auto';
      } else if (pos.snap === 'right') {
        tagEl.classList.add('crev-env-tag--edge-right');
        tagEl.style.right = '0';
        tagEl.style.left = 'auto';
      } else {
        tagEl.style.right = `${pos.right ?? 12}px`;
        tagEl.style.left = 'auto';
      }
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
      // Clear snap before computing start position so right/bottom are consistent
      tagEl.classList.remove('crev-env-tag--edge-left', 'crev-env-tag--edge-right');
      const rect = tagEl.getBoundingClientRect();
      startRight = window.innerWidth - rect.right;
      startBottom = window.innerHeight - rect.bottom;
      tagEl.style.right = `${startRight}px`;
      tagEl.style.bottom = `${startBottom}px`;
      tagEl.style.left = 'auto';
      tagEl.style.top = 'auto';
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
    if (!tagEl) return;

    const rect = tagEl.getBoundingClientRect();
    const centerX = rect.left + rect.width / 2;
    const vw = window.innerWidth;

    // Edge snapping: snap to left/right edge if tag center is near viewport edges
    tagEl.classList.remove('crev-env-tag--edge-left', 'crev-env-tag--edge-right');
    let snap: 'left' | 'right' | null = null;

    if (centerX < vw * 0.15) {
      snap = 'left';
      tagEl.classList.add('crev-env-tag--edge-left');
      tagEl.style.left = '0';
      tagEl.style.right = 'auto';
    } else if (centerX > vw * 0.85) {
      snap = 'right';
      tagEl.classList.add('crev-env-tag--edge-right');
      tagEl.style.right = '0';
      tagEl.style.left = 'auto';
    }

    // Persist position + snap state
    const updatedRect = tagEl.getBoundingClientRect();
    const pos: { right: number; bottom: number; snap?: string } = {
      right: Math.round(window.innerWidth - updatedRect.right),
      bottom: Math.round(window.innerHeight - updatedRect.bottom),
    };
    if (snap) pos.snap = snap;
    chrome.storage.local.set({ [POS_KEY]: pos }).catch(() => {});
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
