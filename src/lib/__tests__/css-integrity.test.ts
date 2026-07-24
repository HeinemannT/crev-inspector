/**
 * CSS integrity locks for the INJECTED stylesheets. A single unclosed comment
 * swallows every rule up to the next comment terminator — that failure silently
 * destroyed the .crev-eo-host position:fixed (2026-07-06) and left the floating
 * editor in document flow under the widgets. The SAME class of break drops the
 * badges (.crev-label) and their positioning context (.crev-outline) into normal
 * flow, piling them up in the lower-left of the page — the reported "badges leaking
 * into the page" symptom. These tests strip comments the way a CSS parser does and
 * assert that every load-bearing overlay rule survives intact.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const FILES = ['src/content-overlay.css', 'src/content-blueprint.css'];

/** Every rule whose loss lets an overlay element leak into page flow. `selector`
 *  is matched as a standalone base rule (selector directly followed by `{ … }`),
 *  and each `must` substring has to survive comment-stripping. NB: content-overlay
 *  uses spaced declarations (`position: fixed`); content-blueprint is compact
 *  (`position:absolute`) — the tokens below match each file's actual style. */
const LOAD_BEARING: Array<{ file: string; selector: string; must: string[] }> = [
  // content-overlay.css — every element injected into the host page and positioned
  // by this sheet: outline context, badges, paint banner, hover card, editor host,
  // drag snap-ghost, toast container. Losing any one's position drops it
  // into document flow (the lower-left leak).
  { file: 'src/content-overlay.css',   selector: '.crev-outline',         must: ['position: relative'] },
  { file: 'src/content-overlay.css',   selector: '.crev-label',           must: ['position: absolute', 'z-index'] },
  { file: 'src/content-overlay.css',   selector: '.crev-label.crev-page-label', must: ['position: static !important', 'display: inline-flex'] },
  { file: 'src/content-overlay.css',   selector: '#crev-paint-banner',    must: ['position: fixed', 'z-index'] },
  { file: 'src/content-overlay.css',   selector: '#crev-tooltip',         must: ['position: fixed', 'z-index', '2147483644'] },
  { file: 'src/content-overlay.css',   selector: '.crev-eo-host',         must: ['position: fixed', 'z-index'] },
  { file: 'src/content-overlay.css',   selector: '.crev-eo-snap-ghost',   must: ['position: fixed', 'z-index'] },
  { file: 'src/content-overlay.css',   selector: '#crev-toast-container',  must: ['position: fixed', 'z-index'] },
  // content-blueprint.css — the full-page editing layer
  { file: 'src/content-blueprint.css', selector: '#crev-blueprint-layer', must: ['position:absolute', 'z-index'] },
];

function read(p: string): string {
  return readFileSync(join(__dirname, '../../..', p), 'utf8');
}

/** Strip /* … *​/ comments; throws on an unclosed one. */
function stripComments(css: string, file: string): string {
  let out = '', i = 0;
  while (i < css.length) {
    const open = css.indexOf('/*', i);
    if (open === -1) { out += css.slice(i); break; }
    out += css.slice(i, open);
    const close = css.indexOf('*/', open + 2);
    if (close === -1) throw new Error(`${file}: unclosed comment at offset ${open}`);
    i = close + 2;
  }
  return out;
}

/** Escape a CSS selector for use inside a RegExp. */
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('injected CSS integrity', () => {
  it.each(FILES)('%s has no unclosed comments and balanced braces', (f) => {
    const css = stripComments(read(f), f);
    let depth = 0;
    for (const ch of css) {
      if (ch === '{') depth++;
      else if (ch === '}') { depth--; expect(depth).toBeGreaterThanOrEqual(0); }
    }
    expect(depth).toBe(0);
  });

  // Each load-bearing rule must survive comment-stripping with its position/z-index
  // intact. Losing any one of these drops an overlay element into document flow.
  it.each(LOAD_BEARING)('$selector keeps its layout props ($file)', ({ file, selector, must }) => {
    const css = stripComments(read(file), file);
    const m = css.match(new RegExp(esc(selector) + '\\s*\\{[^}]*\\}'));
    expect(m, `${selector} base rule missing in ${file}`).toBeTruthy();
    for (const token of must) expect(m![0], `${selector} lost "${token}"`).toContain(token);
  });
});
