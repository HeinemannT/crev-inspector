/**
 * Content script MutationObserver — watches for DOM changes and SPA navigation.
 */

import { OVERLAY_SYNC_DEBOUNCE } from './lib/constants';
import { syncOverlays } from './content-overlays';
import { sendToSW } from './lib/content-port';
import { findActiveTabAnchor } from './lib/dom-scanner';
import type { ContentState } from './content-state';
import type { InspectorMessage } from './lib/types';

/** Debounce window for refreshing the panel's Page-tab widget list after
 *  BMP renders fresh data-rid elements without a URL change (e.g. opening
 *  a sub-tab, expanding a tabset). 250 ms covers a typical React batch. */
const RID_COUNT_REFRESH_DEBOUNCE = 250;

/** Start the MutationObserver that triggers overlay sync and URL change detection. */
export function startObserver(s: ContentState, onUrlChange: () => void) {
  if (s.observer) return;

  // Track the last [data-rid] count we saw so we can detect "BMP just rendered
  // a bunch of widgets" without a URL change — the original observer only
  // pushed PAGE_INFO refreshes on URL transitions, leaving the Page tab
  // showing widgets:[] for a few hundred ms after the user opened a fresh
  // BMP tab. The Page tab's activate() race against React's first paint
  // was the most common cause of the "Page tab empty" complaint.
  let lastRidCount = document.querySelectorAll('[data-rid]').length;
  let ridDebounceTimer: ReturnType<typeof setTimeout> | null = null;

  // Snapshot of the active tab's tabrid. Tab clicks in BMP don't
  // change the URL, but they usually re-render the widget list — if
  // two tabs happen to expose the same widget count, the ridCount diff
  // doesn't fire and the panel context would stay stale. Tracking the
  // tabrid catches that case. Uses findActiveTabAnchor from dom-scanner
  // so the BMP-tab selector + href parsing is centralised.
  let lastTabRid = findActiveTabAnchor()?.rid ?? null;

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

    // SPA navigation — BMP routes by URL param (?rid=…) without a full page
    // load, so we have to detect it via the MutationObserver-driven URL diff.
    // On change: reset overlay/discovery dedup, re-detect BMP, AND signal the
    // panel so the Page tab refreshes its widget list. Without that signal,
    // freshly-rendered widgets show up with grey "?" badges (no type, no name)
    // because the panel's PAGE_INFO is one-shot per panel-activate and stale
    // after a BMP tab switch.
    if (window.location.href !== s.lastUrl) {
      s.lastUrl = window.location.href;
      s.resetOverlays();
      s.resetDiscovery();
      // The bound object changed — drop the stale fiber page context so the
      // resolver falls back to the (new) URL until the interceptor re-posts
      // PAGE_CONTEXT for the new page.
      s.fiberPageContext = null;
      onUrlChange();
      sendToSW({ type: 'BMP_URL_CHANGED' } as InspectorMessage);
    }

    // Did the data-rid population change meaningfully? Cheap querySelectorAll
    // on every batch — under a millisecond on the Steadfast scorecard. If the
    // count flipped from empty → populated (React mounting widgets) or back,
    // push a PAGE_INFO refresh so the Page tab catches up without the user
    // having to click Refresh. Re-use the existing BMP_URL_CHANGED signal —
    // the SW handler is "scan the active tab again", which is what we want.
    const ridCount = document.querySelectorAll('[data-rid]').length;
    const tabRid = findActiveTabAnchor()?.rid ?? null;
    if (ridCount !== lastRidCount || tabRid !== lastTabRid) {
      lastRidCount = ridCount;
      lastTabRid = tabRid;
      if (ridDebounceTimer) clearTimeout(ridDebounceTimer);
      ridDebounceTimer = setTimeout(() => {
        sendToSW({ type: 'BMP_URL_CHANGED' } as InspectorMessage);
      }, RID_COUNT_REFRESH_DEBOUNCE);
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
