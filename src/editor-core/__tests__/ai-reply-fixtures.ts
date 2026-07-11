/**
 * Reply-fixture library for the AI edit/apply interaction matrix.
 *
 * Each fixture is a REALISTIC model reply, the kind the streaming edit path
 * actually receives, paired with the scope it is exercised against. The matrix
 * test (ai-interaction-matrix.test.ts) drives them through the REAL pipeline
 * functions (scrubToolMarkup → extractReplyCode → detectWholeDocRewrite →
 * composeReplacement, all wrapped by resolveEdit) and asserts the full outcome:
 * what gets spliced, what the user is shown, and that the document is never
 * silently corrupted.
 *
 * The sample script (DOC) is a small EC expression; SELECTIONS are computed by
 * substring so offsets stay honest if the text is edited.
 */

import type { AiSelection } from '../../lib/ai/types';

/** The document under edit. Five lines, no trailing newline. */
export const DOC = [
  '_total := 0',
  'descendants().forEach(r:',
  '     _total := _total + r.score',
  ')',
  'output(_total)',
].join('\n');

/** Build a selection over the first occurrence of `needle` in `text`. */
export function select(text: string, needle: string): AiSelection {
  const from = text.indexOf(needle);
  if (from < 0) throw new Error(`fixture selection needle not found: ${needle}`);
  return { from, to: from + needle.length, text: needle };
}

/** A small partial selection — line 1 only (20% of the doc). */
export const SEL_LINE1 = select(DOC, '_total := 0');

/** A partial selection in the MIDDLE — line 3 body. */
export const SEL_LINE3 = select(DOC, '     _total := _total + r.score');

/** A selection covering the FIRST FOUR lines (80% of the doc). The whole-doc
 *  heuristic must NOT fire for this scope even on a full-length reply. */
export const SEL_MOST = select(
  DOC,
  ['_total := 0', 'descendants().forEach(r:', '     _total := _total + r.score', ')'].join('\n'),
);

/** The whole script, renamed `_total` → `_sum` (a realistic "rename everywhere"
 *  answer). Used as the whole-doc-rewrite reply body. */
export const RENAMED_SCRIPT = [
  '_sum := 0',
  'descendants().forEach(r:',
  '     _sum := _sum + r.score',
  ')',
  'output(_sum)',
].join('\n');

/** The whole script with only line 3 changed — echoes all surrounding context
 *  verbatim, so the out-of-selection signal (A) fires. */
export const CONTEXT_ECHO_SCRIPT = [
  '_total := 0',
  'descendants().forEach(r:',
  '     _total := _total + (r.score * 2)',
  ')',
  'output(_total)',
].join('\n');

const fence = (code: string, lang = ''): string => '```' + lang + '\n' + code + '\n```';

/** The fixture reply catalogue. Values are raw model replies. */
export const REPLIES = {
  /** Clean, single fenced block — a scoped replacement for line 1. */
  cleanFenced: fence('_total := 100', 'extended'),

  /** Fenced block wrapped in prose before AND after. */
  proseAround: `Here's the fix:\n${fence('_total := 100')}\nThat resets the accumulator.`,

  /** The model quotes the broken original first, then the corrected version. */
  quoteThenFix: `${fence('_total := 0')}\n${fence('_total := 100')}`,

  /** Whole-script rewrite returned for a partial-selection scope (the confirmed
   *  bug pattern: "rename everywhere" while only line 1 is selected). */
  wholeDocRewrite: fence(RENAMED_SCRIPT, 'extended'),

  /** Whole-script reply that echoes the out-of-selection context verbatim. */
  wholeDocEchoContext: fence(CONTEXT_ECHO_SCRIPT),

  /** Reply identical to the selected line (a no-op for the selection scope). */
  identicalSelection: fence('_total := 0'),

  /** Reply identical to the WHOLE document (a no-op for the whole scope). */
  identicalWhole: fence(DOC),

  /** Multiple fences; the last is the real answer. */
  multiFence: `${fence('_total := 1')}\n${fence('_total := 2')}\n${fence('_total := 999')}`,

  /** Prose only, no code at all. */
  proseOnly: 'This renames the accumulator variable. It affects three lines of the script.',

  /** DSML tool-markup contamination before a real fenced block (a well-formed
   *  container: the scrubber swallows the whole tool call, the code survives). */
  dsmlContaminated:
    '<｜｜DSML｜｜tool_calls><｜｜DSML｜｜invoke name="search_objects">' +
    '<｜｜DSML｜｜parameter name="query">risk<｜｜DSML｜｜/parameter>' +
    '<｜｜DSML｜｜/invoke><｜｜DSML｜｜/tool_calls>' +
    `\n${fence('_total := 100')}`,

  /** An empty fenced block (no code between the fences). */
  emptyFence: '```extended\n\n```',

  /** An empty fence FOLLOWED by a real one — the empty must be skipped. */
  emptyThenReal: `${fence('')}\n${fence('_total := 100')}`,
} as const;

export type ReplyKey = keyof typeof REPLIES;
