/**
 * MAIN world script — runs in the page's JS context.
 * Extracts BMP objects from React fibers on demand.
 * Communicates with content script via CustomEvents (no window.postMessage leakage).
 */

import type { BmpObject, InspectorMessage } from './lib/types';
import { isRidShaped } from './lib/rid-shape';
import { extractEditPageContext } from './lib/edit-page-context';
import { extractFiberObjects, type ObjectFiber } from './lib/fiber-objects';

function post(payload: InspectorMessage) {
  document.dispatchEvent(new CustomEvent('crev-interceptor', { detail: payload }));
}

// ── Fiber extraction on demand ──────────────────────────────────

document.addEventListener('crev-content', ((event: CustomEvent) => {
  const msg = event.detail;
  if (msg?.type === 'EXTRACT_FIBERS') {
    try {
      const objects = extractAllFiberObjects();
      if (objects.length > 0) {
        post({ type: 'OBJECTS_DISCOVERED', objects });
      }
      // Page context (the bound object + active tab) — present in the fiber even
      // when BMP's custom routing leaves the URL/DOM blank. Posted alongside the
      // object scan so the content script can resolve "what is this page about".
      const ctx = extractPageContext();
      if (ctx) post({ type: 'PAGE_CONTEXT', rid: ctx.rid, tabRid: ctx.tabRid });
      post({ type: 'EDIT_PAGE_CONTEXT', context: extractEditPageContext() ?? undefined });
    } catch {
      // React internals are page-owned and may be malformed or change shape.
      // Never let inspection failures escape into the host page's MAIN world.
    }
  }

  if (msg?.type === 'CHECK_BMP_SIGNALS') {
    const signals: string[] = [];
    if ((window as any).Highcharts) signals.push('window.Highcharts');
    if ((window as any).__CORPORATER__) signals.push('__CORPORATER__ global');
    post({ type: 'BMP_SIGNALS_RESULT', signals });
  }
}) as EventListener);

interface FiberLike {
  type?: unknown;
  memoizedProps?: Record<string, unknown>;
  pendingProps?: Record<string, unknown>;
  return?: FiberLike;
  child?: FiberLike;
  sibling?: FiberLike;
}

/** The object the page is bound to (`webParentRid`) + the active tab
 *  (`selectedTabRid`), read from the React fiber.
 *
 *  Detection is STRUCTURAL, not by component name: from each rendered widget
 *  element we walk UP to the first fiber whose props carry a rid-shaped
 *  `webParentRid`. On this BMP build the carrier varies (WidgetContainer,
 *  DescriptionViewWidget, WidgetSearchContainer…) and `#epmapp` itself has no
 *  fiber key, so neither a name match nor a downward walk from the app root is
 *  reliable — the upward-from-element walk resolved 100% of widgets in
 *  testing. The page object is the most common `webParentRid` across widgets
 *  (embedded sub-scorecards lose the majority vote). Returns null when no
 *  fiber carries one (non-React / pre-render), so the resolver falls back to
 *  URL/DOM. */
function extractPageContext(): { rid: string; tabRid?: string } | null {
  const tally = new Map<string, number>();
  const tabFor = new Map<string, string>();
  const widgets = document.querySelectorAll('[data-rid]');
  for (const el of widgets) {
    const fiberKey = Object.keys(el).find(k =>
      k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$'),
    );
    if (!fiberKey) continue;
    let f = (el as unknown as Record<string, FiberLike>)[fiberKey] as FiberLike | undefined;
    let depth = 0;
    while (f && depth < 40) {
      const props = f.memoizedProps ?? f.pendingProps;
      if (props && isRidShaped(props.webParentRid)) {
        const rid = props.webParentRid;
        tally.set(rid, (tally.get(rid) ?? 0) + 1);
        if (isRidShaped(props.selectedTabRid) && !tabFor.has(rid)) tabFor.set(rid, props.selectedTabRid);
        break;
      }
      f = f.return;
      depth++;
    }
  }
  if (tally.size === 0) return null;
  let best = '';
  let bestN = -1;
  for (const [rid, n] of tally) {
    if (n > bestN) { best = rid; bestN = n; }
  }
  return { rid: best, tabRid: tabFor.get(best) };
}

function extractAllFiberObjects(): BmpObject[] {
  const appRoot = document.getElementById('epmapp') ?? document.getElementById('corpo-app') ?? document.getElementById('root') ?? document.body;
  const fiberKey = Object.keys(appRoot).find(k =>
    k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
  );

  if (!fiberKey) return [];

  const rootFiber = (appRoot as unknown as Record<string, unknown>)[fiberKey] as ObjectFiber;
  return rootFiber ? extractFiberObjects(rootFiber) : [];
}
