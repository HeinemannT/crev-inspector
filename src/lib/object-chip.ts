/**
 * Shared semantic representation of a BMP object.
 *
 * `typeBadge()` remains a passive visual primitive. An ObjectChip owns the
 * object-level contract: a readable identity, keyboard activation, and the
 * existing rich object preview. This keeps navigable rows free to use passive
 * badges without creating nested click targets.
 */
import { h } from './dom';
import { sendFireForget, sendRequest } from './messaging';
import { buildObjectCard } from './object-card';
import { typeBadge } from './type-badge';
import { getTypeColor, type ObjectReference } from './types';

export interface ObjectChipOptions {
  /** Override the visible name while retaining the real identity in preview. */
  label?: string;
  /** Show the business ID (or RID fallback) after the label. */
  showId?: boolean;
  /** Quiet trailing context such as "via template". */
  annotation?: string;
  /** Extra surface-specific class; shared object-chip classes are always kept. */
  className?: string;
  size?: 'xs';
  /** Primary activation. Omit for a display-only chip. */
  onActivate?: () => void;
  /** Preview-card expand action. Defaults to the full object view. */
  onOpenFull?: () => void;
  /** Disable the rich preview only for constrained/specialized hosts. */
  preview?: boolean;
}

interface ResolvedPreview {
  name?: string;
  type?: string;
  businessId?: string;
  codePreview?: string;
}

const previewCache = new Map<string, ResolvedPreview>();
let previewHost: HTMLElement | null = null;
let activeAnchor: HTMLElement | null = null;
let showTimer: ReturnType<typeof setTimeout> | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
let requestSequence = 0;
let viewportListenersWired = false;
let warmUntil = 0;

const INITIAL_DELAY = 450;
const WARM_DELAY = 100;
const WARM_WINDOW = 300;
const LEAVE_DELAY = 220;

function clearTimer(timer: ReturnType<typeof setTimeout> | null): void {
  if (timer) clearTimeout(timer);
}

function ensurePreviewHost(): HTMLElement {
  if (previewHost?.isConnected) return previewHost;
  previewHost = h('div', { class: 'object-preview-host' });
  previewHost.addEventListener('pointerenter', () => clearTimer(hideTimer));
  previewHost.addEventListener('pointerleave', scheduleHide);
  previewHost.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hidePreview();
  });
  document.body.appendChild(previewHost);
  if (!viewportListenersWired) {
    viewportListenersWired = true;
    window.addEventListener('resize', () => {
      if (activeAnchor?.isConnected && previewHost?.classList.contains('object-preview-host--visible')) {
        positionPreview(activeAnchor, previewHost);
      }
    });
    // Nested panes can scroll without firing a window scroll. Capturing the
    // event keeps the card attached to its object anywhere in the UI.
    document.addEventListener('scroll', () => {
      if (activeAnchor?.isConnected && previewHost?.classList.contains('object-preview-host--visible')) {
        positionPreview(activeAnchor, previewHost);
      }
    }, true);
  }
  return previewHost;
}

function positionPreview(anchor: HTMLElement, host: HTMLElement): void {
  const gap = 4;
  const edge = 8;
  const anchorRect = anchor.getBoundingClientRect();
  const hostRect = host.getBoundingClientRect();
  let top = anchorRect.bottom + gap;
  let left = anchorRect.left;

  if (top + hostRect.height > window.innerHeight - edge) {
    top = anchorRect.top - hostRect.height - gap;
  }
  top = Math.max(edge, top);
  left = Math.min(left, window.innerWidth - hostRect.width - edge);
  left = Math.max(edge, left);

  host.style.top = `${top}px`;
  host.style.left = `${left}px`;
}

function hidePreview(): void {
  clearTimer(showTimer);
  clearTimer(hideTimer);
  showTimer = null;
  hideTimer = null;
  activeAnchor = null;
  requestSequence += 1;
  previewHost?.classList.remove('object-preview-host--visible');
  warmUntil = Date.now() + WARM_WINDOW;
}

function scheduleHide(): void {
  clearTimer(hideTimer);
  hideTimer = setTimeout(() => {
    if (previewHost?.matches(':hover')) return;
    hidePreview();
  }, LEAVE_DELAY);
}

function mergedIdentity(identity: ObjectReference, resolved?: ResolvedPreview): ObjectReference {
  return {
    ...identity,
    name: identity.name || resolved?.name,
    type: identity.type || resolved?.type,
    businessId: identity.businessId || resolved?.businessId,
  };
}

function renderPreview(
  anchor: HTMLElement,
  identity: ObjectReference,
  options: ObjectChipOptions,
  resolved?: ResolvedPreview,
): void {
  if (activeAnchor !== anchor || !anchor.isConnected) return;
  const data = mergedIdentity(identity, resolved);
  const host = ensurePreviewHost();
  const openFull = options.onOpenFull
    ?? (() => sendFireForget({ type: 'OPEN_OBJECT_VIEW', rid: identity.rid }));

  host.replaceChildren(buildObjectCard({
    name: data.name,
    type: data.type,
    businessId: data.businessId,
    templateBusinessId: data.templateBusinessId,
    rid: data.rid,
    color: getTypeColor(data.type),
    codePreview: resolved?.codePreview,
  }, {
    onOpenFull: openFull,
  }));
  host.classList.add('object-preview-host--visible');
  warmUntil = Date.now() + WARM_WINDOW;
  positionPreview(anchor, host);
}

async function enrichPreview(
  anchor: HTMLElement,
  identity: ObjectReference,
  options: ObjectChipOptions,
): Promise<void> {
  const cached = previewCache.get(identity.rid);
  if (cached) {
    renderPreview(anchor, identity, options, cached);
    return;
  }

  // A complete identity renders without a round trip. The lazy lookup adds a
  // code preview and fills sparse identities, then remains cached per window.
  renderPreview(anchor, identity, options);
  const sequence = ++requestSequence;
  const response = await sendRequest({ type: 'HOVER_LOOKUP', rid: identity.rid });
  if (sequence !== requestSequence || activeAnchor !== anchor) return;
  if (response?.type !== 'HOVER_LOOKUP_RESULT') return;
  const resolved: ResolvedPreview = {
    name: response.name,
    type: response.objectType,
    businessId: response.businessId,
    codePreview: response.codePreview,
  };
  previewCache.set(identity.rid, resolved);
  renderPreview(anchor, identity, options, resolved);
}

function wirePreview(anchor: HTMLElement, identity: ObjectReference, options: ObjectChipOptions): void {
  const scheduleShow = (delay: number) => {
    clearTimer(hideTimer);
    clearTimer(showTimer);
    activeAnchor = anchor;
    showTimer = setTimeout(() => {
      showTimer = null;
      void enrichPreview(anchor, identity, options);
    }, delay);
  };

  anchor.addEventListener('pointerenter', () => {
    const visible = previewHost?.classList.contains('object-preview-host--visible') ?? false;
    scheduleShow(visible || Date.now() < warmUntil ? WARM_DELAY : INITIAL_DELAY);
  });
  anchor.addEventListener('pointerleave', scheduleHide);
  anchor.addEventListener('focusin', () => scheduleShow(0));
  anchor.addEventListener('focusout', (event) => {
    if (previewHost?.contains(event.relatedTarget as Node | null)) return;
    scheduleHide();
  });
  anchor.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') hidePreview();
  });
}

export function objectChip(identity: ObjectReference, options: ObjectChipOptions = {}): HTMLElement {
  const interactive = !!options.onActivate;
  const label = options.label ?? identity.name ?? identity.businessId ?? identity.rid;
  const shownId = identity.businessId || identity.rid;
  const className = [
    'object-chip',
    options.size === 'xs' ? 'object-chip--xs' : '',
    interactive ? 'object-chip--interactive' : '',
    options.preview !== false ? 'object-chip--preview' : '',
    options.className ?? '',
  ].filter(Boolean).join(' ');
  const attrs = interactive
    ? {
        class: className,
        type: 'button',
        title: `Open ${identity.type || 'object'} ${label}`,
        onClick: options.onActivate,
      }
    : {
        class: className,
        title: `${identity.type || 'Object'} · ${label}`,
      };
  const chip = h(interactive ? 'button' : 'span', attrs,
    typeBadge(identity.type, options.size ? { size: options.size } : {}),
    h('span', { class: 'object-chip-label' }, label),
    options.showId && shownId !== label
      ? h('span', { class: 'object-chip-id' }, shownId)
      : null,
    options.annotation
      ? h('span', { class: 'object-chip-annotation' }, options.annotation)
      : null,
  );

  if (options.preview !== false) wirePreview(chip, identity, options);
  return chip;
}

/** Test/lifecycle hook: extension documents are normally destroyed wholesale. */
export function resetObjectPreview(): void {
  hidePreview();
  warmUntil = 0;
  previewCache.clear();
  previewHost?.remove();
  previewHost = null;
}
