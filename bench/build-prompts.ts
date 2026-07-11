/**
 * Produce the REAL chat system prompts by importing the extension's own
 * prompt-assembly modules (buildChatSystem + knowledge packs + context
 * renderer). Bundled and executed by bundle.mjs (esbuild handles the
 * `?raw` markdown imports the same way Vite does).
 *
 * Emits bench/out/prompts.json with one entry per benchmark config.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildChatSystem } from '../src/lib/ai/prompt';
import type { AiContextEnvelope } from '../src/lib/ai/types';

// When bundled, import.meta.url points at bench/out/ — bundle.mjs passes the
// real bench dir via BENCH_DIR instead.
const here = process.env.BENCH_DIR ?? dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'out');
mkdirSync(outDir, { recursive: true });

/** Selection source on a Scorecard — mirrors the Inspect-flow chip the
 *  extension attaches (identity only, no slot). Real object from the live
 *  Steadfast workspace. */
const selectionEnvelope: AiContextEnvelope = {
  v: 1,
  server: { id: 'steadfast', url: 'https://crev.theinemann.de/Steadfast/' },
  sources: [
    {
      kind: 'selection',
      object: {
        rid: '8925133260007797905',
        businessId: '4761',
        name: 'Control Register',
        type: 'Scorecard',
        templateBusinessId: 'sc_control_register',
      },
    },
  ],
};

/** No attached sources — the chat's stated common case (ships bmp-core + ec). */
const emptyEnvelope: AiContextEnvelope = {
  v: 1,
  server: { id: 'steadfast', url: 'https://crev.theinemann.de/Steadfast/' },
  sources: [],
};

/** Workspace primer captured live via ec_preview of PRIMER_EC
 *  (src/lib/handlers/ai-primer.ts) against the same workspace. Optional. */
const primerPath = join(here, 'out', 'primer.txt');
const primer = existsSync(primerPath) ? readFileSync(primerPath, 'utf8').trim() : null;

const configs: Record<string, { system: string; packs: string[] }> = {
  // Exactly the envelope the task spec asked for. NOTE the pack selection
  // outcome — a selection-kind source has no slot, so selectChatPacks drops
  // the ec pack (langs empty, sources.length > 0).
  'selection-scorecard': buildChatSystem(selectionEnvelope),
  // Chat with no chips: bmp-core + ec, no <context> block.
  'no-context': buildChatSystem(emptyEnvelope),
};
if (primer) configs['no-context-primer'] = buildChatSystem(emptyEnvelope, primer);

writeFileSync(join(outDir, 'prompts.json'), JSON.stringify(configs, null, 2));
for (const [name, c] of Object.entries(configs)) {
  console.log(`${name}: packs=[${c.packs.join(', ')}] systemChars=${c.system.length}`);
}
