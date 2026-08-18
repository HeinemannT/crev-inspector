/**
 * Inspect-mode identity for BMP's page title.
 *
 * Normal page headings do not carry a RID, so the generic DOM scanner cannot
 * badge them. This module joins the already-resolved page context to a
 * high-confidence semantic heading without adding fake BMP data attributes.
 */

import { createIdentityLabel } from './content-overlays';
import type { ContentState } from './content-state';
import { detectPageHeader } from './lib/page-header-detection';
import { sendToSW } from './lib/content-port';
import { getTypeColor } from './lib/types';
import { PAGE_HEADER_PRESENTATION } from './lib/overlay-presentation';

export function removePageHeaderIdentity(s: ContentState): void {
  s.pageHeaderLabel?.remove();
  s.pageHeaderElement?.style.removeProperty('--crev-color');
  s.pageHeaderElement = null;
  s.pageHeaderLabel = null;
  s.pageHeaderRid = null;
}

export function syncPageHeaderIdentity(s: ContentState, rid: string | undefined): void {
  if (!rid) {
    removePageHeaderIdentity(s);
    return;
  }

  if (
    s.pageHeaderRid === rid
    && s.pageHeaderElement?.isConnected
    && s.pageHeaderLabel?.isConnected
  ) {
    const name = s.enrichments.get(rid)?.name;
    s.pageHeaderLabel.querySelector<HTMLElement>('.crev-stub')?.setAttribute(
      'aria-label',
      name ? `Inspect page object ${name}` : 'Inspect this page object',
    );
    return;
  }

  removePageHeaderIdentity(s);
  const enrichment = s.enrichments.get(rid);
  const match = detectPageHeader({ expectedName: enrichment?.name });
  if (!match) return;

  const label = createIdentityLabel(s, rid, PAGE_HEADER_PRESENTATION);
  const stub = label.querySelector<HTMLElement>('.crev-stub');
  stub?.setAttribute(
    'aria-label',
    enrichment?.name ? `Inspect page object ${enrichment.name}` : 'Inspect this page object',
  );
  match.element.appendChild(label);
  match.element.style.setProperty('--crev-color', getTypeColor('Page'));

  s.pageHeaderElement = match.element;
  s.pageHeaderLabel = label;
  s.pageHeaderRid = rid;

  if (!enrichment && !s.requestedRids.has(rid)) {
    s.requestedRids.add(rid);
    sendToSW({ type: 'ENRICH_BADGES', rids: [rid] });
  }
}
