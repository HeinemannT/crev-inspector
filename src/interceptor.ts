/**
 * MAIN world script — runs in the page's JS context.
 * Extracts BMP objects from React fibers on demand.
 * Communicates with content script via CustomEvents (no window.postMessage leakage).
 */

import type { BmpObject, InspectorMessage } from './lib/types';

function post(payload: InspectorMessage) {
  document.dispatchEvent(new CustomEvent('crev-interceptor', { detail: payload }));
}

// ── Fiber extraction on demand ──────────────────────────────────

document.addEventListener('crev-content', ((event: CustomEvent) => {
  const msg = event.detail;
  if (msg?.type === 'EXTRACT_FIBERS') {
    const objects = extractAllFiberObjects();
    if (objects.length > 0) {
      post({ type: 'OBJECTS_DISCOVERED', objects });
    }
  }

  if (msg?.type === 'CHECK_BMP_SIGNALS') {
    const signals: string[] = [];
    if ((window as any).Highcharts) signals.push('window.Highcharts');
    if ((window as any).__CORPORATER__) signals.push('__CORPORATER__ global');
    post({ type: 'BMP_SIGNALS_RESULT', signals });
  }
}) as EventListener);

function extractAllFiberObjects(): BmpObject[] {
  const objects: BmpObject[] = [];
  const seen = new Set<string>();
  const now = Date.now();

  const appRoot = document.getElementById('epmapp') ?? document.getElementById('corpo-app') ?? document.getElementById('root') ?? document.body;
  const fiberKey = Object.keys(appRoot).find(k =>
    k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')
  );

  if (!fiberKey) return objects;

  interface FiberNode {
    memoizedProps?: Record<string, unknown>;
    pendingProps?: Record<string, unknown>;
    return?: FiberNode;
    child?: FiberNode;
    sibling?: FiberNode;
  }

  function walkFiber(fiber: FiberNode, depth: number) {
    if (depth > 80) return;

    const props = fiber.memoizedProps ?? fiber.pendingProps;
    if (props) {
      const obj = props.object as Record<string, unknown> | undefined;
      if (obj && typeof obj === 'object' && obj.rid) {
        const rid = String(obj.rid);
        if (!seen.has(rid)) {
          seen.add(rid);
          objects.push({
            rid,
            name: obj.name ? String(obj.name) : undefined,
            type: obj.type ? String(obj.type) : undefined,
            typename: obj.__typename ? String(obj.__typename) : undefined,
            businessId: obj.id ? String(obj.id) : undefined,
            webParentRid: obj.webParentRid ? String(obj.webParentRid) : undefined,
            hasChildren: obj.hasChildren != null ? Boolean(obj.hasChildren) : undefined,
            source: 'fiber',
            discoveredAt: now,
            updatedAt: now,
          });
        }
      }
    }

    try { if (fiber.child) walkFiber(fiber.child, depth + 1); } catch { /* skip malformed subtree */ }
    try { if (fiber.sibling) walkFiber(fiber.sibling, depth + 1); } catch { /* skip malformed subtree */ }
  }

  const rootFiber = (appRoot as unknown as Record<string, unknown>)[fiberKey] as FiberNode;
  if (rootFiber) walkFiber(rootFiber, 0);

  return objects;
}
