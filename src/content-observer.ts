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
function renderedRidFingerprint(): string {
  let count = 0;
  let hash = 2166136261;
  for (const el of document.querySelectorAll('[data-rid],[data-object-rid],[data-container-rid]')) {
    const rid = el.getAttribute('data-rid') ?? el.getAttribute('data-object-rid') ?? el.getAttribute('data-container-rid') ?? '';
    count++;
    for (let i = 0; i < rid.length; i++) {
      hash ^= rid.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
  }
  return `${count}:${hash >>> 0}`;
}

function bmpRootFingerprint(): string {
  return `${document.getElementById('epmapp') ? 1 : 0}:${document.getElementById('corpo-app') ? 1 : 0}`;
}

function pageOwnerRid(href: string): string | null {
  try { return new URL(href).searchParams.get('rid'); }
  catch { return null; }
}

export function startObserver(
  s: ContentState,
  refreshDetection: () => void,
  syncInspect: () => void = () => syncOverlays(s),
) {
  if (s.observer) return;

  // Track the last [data-rid] count we saw so we can detect "BMP just rendered
  // a bunch of widgets" without a URL change — the original observer only
  // pushed PAGE_INFO refreshes on URL transitions, leaving the Page tab
  // showing widgets:[] for a few hundred ms after the user opened a fresh
  // BMP tab. The Page tab's activate() race against React's first paint
  // was the most common cause of the "Page tab empty" complaint.
  let lastRidFingerprint = renderedRidFingerprint();
  let lastRootFingerprint = bmpRootFingerprint();
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
      const ownerChanged = pageOwnerRid(window.location.href) !== pageOwnerRid(s.lastUrl);
      s.lastUrl = window.location.href;
      s.resetOverlays();
      s.resetDiscovery();
      // Form definition can change even when BMP keeps the same parent `rid`
      // and only rewrites create/edit parameters.
      s.editPageContext = null;
      refreshDetection();
      if (ownerChanged) {
        // The page owner changed — drop the stale fiber context and tell the
        // worker this is navigation (which also clears explicit selection).
        s.fiberPageContext = null;
        sendToSW({ type: 'BMP_URL_CHANGED' } as InspectorMessage);
      } else {
        // BMP may write tabrid, period, ytd, and other presentation state into
        // the URL. Those are renders within the same page owner and must not
        // erase an object the user explicitly selected.
        sendToSW({ type: 'BMP_PAGE_RENDER_CHANGED' } as InspectorMessage);
      }
    }

    // Did the data-rid population change meaningfully? If the count flipped from
    // empty → populated (React mounting widgets) or back, push a PAGE_INFO
    // refresh so the Page tab catches up without the user clicking Refresh.
    // The two querySelectorAll-style measurements (rid count + active tab anchor)
    // run in the DEBOUNCED tail rather than on every mutation batch — during an
    // animation/typing burst that's one measurement after things settle instead
    // of one per batch. Re-uses the BMP_URL_CHANGED signal (SW handler = "scan
    // the active tab again").
    // Coalesce to at most one scan per window. Unlike a trailing debounce this
    // cannot starve forever on a live dashboard that mutates continuously.
    if (!s.renderRefreshTimer) s.renderRefreshTimer = setTimeout(() => {
      s.renderRefreshTimer = null;
      const ridFingerprint = renderedRidFingerprint();
      const rootFingerprint = bmpRootFingerprint();
      const tabRid = findActiveTabAnchor()?.rid ?? null;
      if (ridFingerprint !== lastRidFingerprint || rootFingerprint !== lastRootFingerprint || tabRid !== lastTabRid) {
        lastRidFingerprint = ridFingerprint;
        lastRootFingerprint = rootFingerprint;
        lastTabRid = tabRid;
        // The content script can boot before BMP's React tree has mounted. In
        // that case the initial DOM scan caches `isBmp: false`; merely asking
        // the panel to refresh cannot recover because fiber extraction is
        // gated on that cached result. Re-run detection first, then notify the
        // panel (runtime port messages preserve this order).
        refreshDetection();
        sendToSW({ type: 'BMP_PAGE_RENDER_CHANGED' } as InspectorMessage);
      }
    }, RID_COUNT_REFRESH_DEBOUNCE);

    // Overlay sync (debounced, only when inspect active)
    if (s.inspectActive) {
      if (s.debounceTimer) clearTimeout(s.debounceTimer);
      s.debounceTimer = setTimeout(syncInspect, OVERLAY_SYNC_DEBOUNCE);
    }
  });

  s.observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'data-rid', 'data-object-rid', 'data-container-rid'],
  });
  window.__crev_observer = s.observer;
}
