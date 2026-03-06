import type { BmpObject } from './types';

/** Compare source priority: server > fiber > dom. */
export function prioritySource(a: BmpObject['source'], b: BmpObject['source']): BmpObject['source'] {
  const order: Record<string, number> = { server: 3, fiber: 1, dom: 0 };
  return (order[a] ?? 0) >= (order[b] ?? 0) ? a : b;
}

/** Merge incoming object data into an existing entry, preferring non-null fields and higher-priority source. */
export function mergeBmpObject(existing: BmpObject, incoming: BmpObject): BmpObject {
  return {
    rid: incoming.rid,
    name: incoming.name ?? existing.name,
    type: incoming.type ?? existing.type,
    typename: incoming.typename ?? existing.typename,
    businessId: incoming.businessId ?? existing.businessId,
    webParentRid: incoming.webParentRid ?? existing.webParentRid,
    hasChildren: incoming.hasChildren ?? existing.hasChildren,
    properties: incoming.properties ?? existing.properties,
    treePath: incoming.treePath ?? existing.treePath,
    source: prioritySource(incoming.source, existing.source),
    discoveredAt: existing.discoveredAt,
    updatedAt: Date.now(),
  };
}
