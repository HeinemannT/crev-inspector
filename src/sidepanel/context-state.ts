import type { InspectorMessage } from '../lib/types';

export interface PanelObjectContext {
  rid: string;
  name?: string;
  type?: string;
  businessId?: string;
}

/** Apply the service worker's canonical context message. Sparse updates for the
 *  same RID retain identity already learned by the detail pane; a different RID
 *  replaces it, and an empty message clears stale context on non-BMP pages. */
export function contextFromData(
  current: PanelObjectContext | null,
  msg: Extract<InspectorMessage, { type: 'CONTEXT_RID_DATA' }>,
): PanelObjectContext | null {
  if (!msg.rid) return null;
  const same = current?.rid === msg.rid ? current : null;
  return {
    rid: msg.rid,
    name: msg.name ?? same?.name,
    type: msg.objectType ?? same?.type,
    businessId: msg.businessId ?? same?.businessId,
  };
}
