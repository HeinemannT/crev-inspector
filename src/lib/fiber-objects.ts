import type { BmpObject } from './types';

export interface ObjectFiber {
  memoizedProps?: Record<string, unknown>;
  pendingProps?: Record<string, unknown>;
  child?: ObjectFiber;
  sibling?: ObjectFiber;
}

/** Extract BMP objects without recursing through the page's React fiber graph. */
export function extractFiberObjects(root: ObjectFiber, now = Date.now()): BmpObject[] {
  const objects: BmpObject[] = [];
  const seenObjects = new Set<string>();
  const seenFibers = new WeakSet<object>();
  const stack: Array<{ fiber: unknown; depth: number }> = [{ fiber: root, depth: 0 }];

  while (stack.length > 0) {
    const { fiber, depth } = stack.pop()!;
    if (depth > 80 || !fiber || typeof fiber !== 'object' || seenFibers.has(fiber)) continue;
    seenFibers.add(fiber);
    const node = fiber as ObjectFiber;

    const props = node.memoizedProps ?? node.pendingProps;
    const obj = props?.object as Record<string, unknown> | undefined;
    if (obj && typeof obj === 'object' && obj.rid) {
      const rid = String(obj.rid);
      if (!seenObjects.has(rid)) {
        seenObjects.add(rid);
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

    // Push sibling first so the child is processed first, matching the old DFS order.
    if (node.sibling) stack.push({ fiber: node.sibling, depth });
    if (node.child) stack.push({ fiber: node.child, depth: depth + 1 });
  }

  return objects;
}
