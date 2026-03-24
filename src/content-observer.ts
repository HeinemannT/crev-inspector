/**
 * Content script MutationObserver — watches for DOM changes and SPA navigation.
 */

import { OVERLAY_SYNC_DEBOUNCE } from './lib/constants';
import { syncOverlays } from './content-overlays';
import type { ContentState } from './content-state';

/** Start the MutationObserver that triggers overlay sync and URL change detection. */
export function startObserver(s: ContentState, onUrlChange: () => void) {
  if (s.observer) return;

  s.observer = new MutationObserver((mutations) => {
    // Self-filter: skip if ALL mutations are only our own insertions
    const onlySelf = mutations.every(m => {
      if (m.type !== 'childList') return false;
      if (m.removedNodes.length > 0) return false;
      return Array.from(m.addedNodes).every(n =>
        n instanceof HTMLElement && (n.classList.contains('crev-label') || n.id === 'crev-tooltip')
      );
    });
    if (onlySelf) return;

    // Check for URL change (SPA navigation) — re-detect + reset dedup
    if (window.location.href !== s.lastUrl) {
      s.lastUrl = window.location.href;
      s.requestedRids.clear();
      s.discoveredRids.clear();
      if (s.labelClickTimer) { clearTimeout(s.labelClickTimer); s.labelClickTimer = null; s.labelClickRid = null; }
      onUrlChange();
    }

    // Overlay sync (debounced, only when inspect active)
    if (s.inspectActive) {
      if (s.debounceTimer) clearTimeout(s.debounceTimer);
      s.debounceTimer = setTimeout(() => syncOverlays(s), OVERLAY_SYNC_DEBOUNCE);
    }
  });

  s.observer.observe(document.body, { childList: true, subtree: true });
  window.__crev_observer = s.observer;
}
