/**
 * Badge enrichment handlers.
 */

import { register } from '../handler-registry';
import { enrichBadges, refreshEnrichment } from '../enrichment';

register('ENRICH_BADGES', (msg) => {
  void enrichBadges(msg.rids);
});

register('REFRESH_ENRICHMENT', () => {
  refreshEnrichment();
});
