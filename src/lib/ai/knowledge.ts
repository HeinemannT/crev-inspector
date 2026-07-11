/**
 * Bundled knowledge packs. Authored under ./knowledge/*.md by distilling the
 * CREV project skills (extended-code reference, CVO design strategy) — each pack
 * stays small so it fits comfortably inside a cached system prefix. Imported as
 * raw strings via Vite's `?raw` loader.
 */

import bmpCore from './knowledge/bmp-core.md?raw';
import ec from './knowledge/ec.md?raw';
import cvo from './knowledge/cvo.md?raw';
import htmlText from './knowledge/html-text.md?raw';

export const KNOWLEDGE = { bmpCore, ec, cvo, htmlText } as const;

export type KnowledgePackId = keyof typeof KNOWLEDGE;
