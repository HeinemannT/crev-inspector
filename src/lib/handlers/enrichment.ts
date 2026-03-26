/**
 * Badge enrichment handlers.
 */

import { register } from '../handler-registry';
import { getCtx } from '../sw-context';
import { enrichBadges, refreshEnrichment } from '../enrichment';

register('ENRICH_BADGES', (msg) => {
  enrichBadges(msg.rids);
});

register('REFRESH_ENRICHMENT', () => {
  refreshEnrichment();
});
