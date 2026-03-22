/**
 * Quick Inspector popup — double-click overlay label to see object details inline.
 * Singleton panel, positioned near element, dismissed on click-outside / Escape / inspect off.
 */

const PANEL_ID = 'crev-quick-inspector';

let panelEl: HTMLDivElement | null = null;
let currentRid: string | null = null;

interface QuickInspectorData {
  rid: string;
  businessId?: string;
  type?: string;
  name?: string;
  isFavorite?: boolean;
}

export function showQuickInspector(
  anchorEl: HTMLElement,
  data: QuickInspectorData,
  onOpenEditor: (rid: string) => void,
  onToggleFavorite?: (rid: string) => void,
  onOpenObjectView?: (rid: string) => void,
) {
  hideQuickInspector();
  currentRid = data.rid;

  panelEl = document.createElement('div');
  panelEl.id = PANEL_ID;

  // Type badge
  if (data.type) {
    const badge = document.createElement('span');
    badge.className = 'crev-qi-badge';
    badge.textContent = data.type;
    panelEl.appendChild(badge);
  }

  // Name
  if (data.name) {
    const name = document.createElement('div');
    name.className = 'crev-qi-name';
    name.textContent = data.name;
    panelEl.appendChild(name);
  }

  // BID
  if (data.businessId) {
    const bid = document.createElement('div');
    bid.className = 'crev-qi-row';
    bid.textContent = `ID: ${data.businessId}`;
    panelEl.appendChild(bid);
  }

  // RID
  const ridRow = document.createElement('div');
  ridRow.className = 'crev-qi-row crev-qi-rid';
  ridRow.textContent = `RID: ${data.rid}`;
  panelEl.appendChild(ridRow);

  // Star button
  const starBtn = document.createElement('button');
  starBtn.className = `crev-qi-star${data.isFavorite ? ' active' : ''}`;
  starBtn.textContent = data.isFavorite ? '\u2605' : '\u2606';
  starBtn.title = data.isFavorite ? 'Remove from pinned' : 'Pin this object';
  starBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    onToggleFavorite?.(data.rid);
    // Toggle visual state immediately
    const isNowFav = starBtn.classList.toggle('active');
    starBtn.textContent = isNowFav ? '\u2605' : '\u2606';
  });
  panelEl.appendChild(starBtn);

  // Action buttons
  const actions = document.createElement('div');
  actions.className = 'crev-qi-actions';

  const copyRidBtn = document.createElement('button');
  copyRidBtn.className = 'crev-qi-btn';
  copyRidBtn.textContent = 'Copy RID';
  copyRidBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    navigator.clipboard.writeText(data.rid).then(() => {
      copyRidBtn.textContent = '\u2713';
      setTimeout(() => { copyRidBtn.textContent = 'Copy RID'; }, 600);
    }).catch(() => {});
  });

  const copyBidBtn = document.createElement('button');
  copyBidBtn.className = 'crev-qi-btn';
  copyBidBtn.textContent = 'Copy ID';
  copyBidBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const text = data.businessId ?? data.rid;
    navigator.clipboard.writeText(text).then(() => {
      copyBidBtn.textContent = '\u2713';
      setTimeout(() => { copyBidBtn.textContent = 'Copy ID'; }, 600);
    }).catch(() => {});
  });

  const editorBtn = document.createElement('button');
  editorBtn.className = 'crev-qi-btn crev-qi-btn--accent';
  editorBtn.textContent = 'Editor';
  editorBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    onOpenEditor(data.rid);
    hideQuickInspector();
  });

  const fullViewBtn = document.createElement('button');
  fullViewBtn.className = 'crev-qi-btn';
  fullViewBtn.textContent = 'Full View';
  fullViewBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    onOpenObjectView?.(data.rid);
    hideQuickInspector();
  });

  actions.appendChild(copyRidBtn);
  actions.appendChild(copyBidBtn);
  actions.appendChild(editorBtn);
  actions.appendChild(fullViewBtn);
  panelEl.appendChild(actions);

  document.body.appendChild(panelEl);

  // Position near anchor
  positionPanel(anchorEl);
}

function positionPanel(anchor: HTMLElement) {
  if (!panelEl) return;

  // Render offscreen first to measure
  panelEl.style.top = '-9999px';
  panelEl.style.left = '-9999px';
  panelEl.style.display = 'block';

  const anchorRect = anchor.getBoundingClientRect();
  const panelRect = panelEl.getBoundingClientRect();
  const pad = 6;

  let top = anchorRect.bottom + pad;
  let left = anchorRect.left;

  // Flip above if no room below
  if (top + panelRect.height > window.innerHeight - pad) {
    top = anchorRect.top - panelRect.height - pad;
  }
  // Clamp to viewport
  if (top < pad) top = pad;
  if (left + panelRect.width > window.innerWidth - pad) {
    left = window.innerWidth - panelRect.width - pad;
  }
  if (left < pad) left = pad;

  panelEl.style.top = `${top}px`;
  panelEl.style.left = `${left}px`;
}

export function hideQuickInspector() {
  panelEl?.remove();
  panelEl = null;
  currentRid = null;
}

export function isQuickInspectorVisible(): boolean {
  return panelEl != null;
}

function getQuickInspectorRid(): string | null {
  return currentRid;
}
