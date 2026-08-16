/**
 * Bundled knowledge packs. Authored under ./knowledge/*.md by distilling the
 * CREV project skills (extended-code reference, CVO design strategy) — each pack
 * stays small so it fits comfortably inside a cached system prefix. Imported as
 * raw strings via Vite's `?raw` loader.
 */

import bmpCore from './knowledge/bmp-core.md?raw';
import bmpEditor from './knowledge/bmp-editor.md?raw';
import ecLanguageCore from './knowledge/ec-language-core.md?raw';
import ecSidebarWorkflows from './knowledge/ec-sidebar-workflows.md?raw';
import ecEditorPolicy from './knowledge/ec-editor-policy.md?raw';
import cvo from './knowledge/cvo.md?raw';
import htmlText from './knowledge/html-text.md?raw';

const JOIN = '\n\n---\n\n';

/**
 * Callers select product-level packs. The implementation composes both EC
 * products from one canonical language core so grammar fixes cannot drift
 * between the sidebar configurator and the one-shot editor.
 */
const ec = [ecLanguageCore, ecSidebarWorkflows].join(JOIN);
const ecEditor = [ecLanguageCore, ecEditorPolicy].join(JOIN);

export const KNOWLEDGE = { bmpCore, bmpEditor, ec, ecEditor, cvo, htmlText } as const;

export type KnowledgePackId = keyof typeof KNOWLEDGE;
