/** Shared utility functions for sidepanel modules */

import { log } from '../lib/logger';
import { h, svg } from '../lib/dom';
import { type CopyableIdentity, resolveCopyText, getModifier, COPY_TOOLTIP } from '../lib/namespace';

// Re-export icons used by sidepanel consumers
export { ICON_COPY, ICON_REFRESH, ICON_ARROW_LEFT, ICON_PAINT, ICON_EYE_OPEN, ICON_EYE_CLOSED, ICON_STAR_FILLED, ICON_STAR_HOLLOW, ICON_SEARCH } from '../lib/icons';

/** Copy button with optional tooltip override. */
export function copyBtn(text: string, tooltip?: string): HTMLElement {
  return h('button', {
    class: 'copy-btn',
    title: tooltip ?? 'Copy',
    onClick: (e: Event) => {
      e.stopPropagation();
      copyText(text);
      const el = e.currentTarget as HTMLElement;
      el.style.color = 'var(--accent)';
      setTimeout(() => { el.style.color = ''; }, 1200);
    },
  }, svg(ICON_COPY));
}

/** Identity-aware copy button — click=ID, shift=Template ID, ctrl=ns.ref.
 *  Uses the shared resolveCopyText strategy from namespace.ts. */
export function copyBtnIdentity(identity: CopyableIdentity): HTMLElement {
  return h('button', {
    class: 'copy-btn',
    title: COPY_TOOLTIP,
    onClick: (e: Event) => {
      e.stopPropagation();
      const { text, label } = resolveCopyText(identity, getModifier(e as MouseEvent));
      copyText(text);
      const el = e.currentTarget as HTMLElement;
      el.style.color = 'var(--accent)';
      el.title = `Copied ${label}`;
      setTimeout(() => {
        el.style.color = '';
        el.title = COPY_TOOLTIP;
      }, 1200);
    },
  }, svg(ICON_COPY));
}

/** Truncate a long RID for display */
export function truncRid(rid: string): string {
  if (rid.length <= 8) return rid;
  return rid.slice(0, 4) + '\u2026' + rid.slice(-4);
}

/** Copy text to clipboard */
export function copyText(text: string): void {
  navigator.clipboard.writeText(text).catch(e => log.swallow('clipboard:write', e));
}

/** Format an unknown value for display in property tables */
export function formatValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(String).join(', ');
  if (typeof value === 'object') {
    try { return JSON.stringify(value); } catch { return String(value); }
  }
  return String(value);
}

/** Format relative time (e.g. "2s ago", "1m ago") */
export function relativeTime(ts: number): string {
  const diff = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (diff < 5) return 'now';
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  return `${Math.floor(diff / 3600)}h ago`;
}
