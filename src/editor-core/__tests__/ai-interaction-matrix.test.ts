/**
 * AI edit/apply INTERACTION MATRIX.
 *
 * Drives the realistic reply fixtures (ai-reply-fixtures.ts) through the REAL
 * pipeline — resolveEdit (which composes scrubToolMarkup → extractReplyCode →
 * detectWholeDocRewrite → composeReplacement) — for both scope kinds
 * (partial SELECTION / WHOLE script), plus the Insert-at-cursor composition.
 *
 * The contract every scenario asserts:
 *   - what OUTCOME the user is shown: proposal / no-change / error / whole-doc
 *     choice;
 *   - what gets spliced (the resulting document for a proposal);
 *   - that the document is NEVER silently corrupted — the confirmed bug
 *     (a whole-script rewrite spliced into a 2-line selection) is intercepted
 *     as a CHOICE, never applied blindly.
 */
import { describe, it, expect } from 'vitest';
import {
  resolveEdit, detectWholeDocRewrite, composeReplacement, extractReplyCode,
  type EditOutcome,
} from '../ai-assist';
import { scrubToolMarkup } from '../../lib/ai/scrub';
import type { AiSelection } from '../../lib/ai/types';
import {
  DOC, SEL_LINE1, SEL_LINE3, SEL_MOST, RENAMED_SCRIPT, CONTEXT_ECHO_SCRIPT, REPLIES,
} from './ai-reply-fixtures';

/** Convenience: the document a proposal for `code` at `sel` would produce. */
const after = (code: string, sel: AiSelection | null): string => composeReplacement(DOC, code, sel);

describe('interaction matrix — edit reply × scope → outcome', () => {
  // Each row: fixture, scope, and the expected outcome shape. `after`/replacement
  // are recomputed with the real composeReplacement, never hand-copied.
  interface Row {
    name: string;
    reply: string;
    sel: AiSelection | null;
    expect: (o: EditOutcome) => void;
  }

  const proposalIs = (replacement: string, sel: AiSelection | null) => (o: EditOutcome) => {
    expect(o.kind).toBe('proposal');
    if (o.kind !== 'proposal') return;
    expect(o.replacement).toBe(replacement);
    expect(o.after).toBe(after(replacement, sel));
    // A proposal always changes the document (no-op would be its own kind).
    expect(o.after).not.toBe(DOC);
  };
  const noChange = (o: EditOutcome) => expect(o.kind).toBe('no-change');
  const errorLike = (re: RegExp) => (o: EditOutcome) => {
    expect(o.kind).toBe('error');
    if (o.kind === 'error') expect(o.message).toMatch(re);
  };
  const wholeDocChoice = (body: string) => (o: EditOutcome) => {
    expect(o.kind).toBe('whole-doc-choice');
    if (o.kind !== 'whole-doc-choice') return;
    expect(o.replacement).toBe(body);
    // Applying the choice targets the FULL document.
    expect(o.wholeDocAfter).toBe(body);
  };

  const rows: Row[] = [
    // Clean fenced reply.
    { name: 'cleanFenced @ selection', reply: REPLIES.cleanFenced, sel: SEL_LINE1, expect: proposalIs('_total := 100', SEL_LINE1) },
    { name: 'cleanFenced @ whole', reply: REPLIES.cleanFenced, sel: null, expect: proposalIs('_total := 100', null) },

    // Prose before and after the fence.
    { name: 'proseAround @ selection', reply: REPLIES.proseAround, sel: SEL_LINE1, expect: proposalIs('_total := 100', SEL_LINE1) },
    { name: 'proseAround @ whole', reply: REPLIES.proseAround, sel: null, expect: proposalIs('_total := 100', null) },

    // Quote-original-then-corrected: pick the corrected (last-differing) block.
    { name: 'quoteThenFix @ selection', reply: REPLIES.quoteThenFix, sel: SEL_LINE1, expect: proposalIs('_total := 100', SEL_LINE1) },
    { name: 'quoteThenFix @ whole', reply: REPLIES.quoteThenFix, sel: null, expect: proposalIs('_total := 100', null) },

    // THE BUG: whole-doc rewrite for a partial selection → choice, not a splice.
    { name: 'wholeDocRewrite @ selection', reply: REPLIES.wholeDocRewrite, sel: SEL_LINE1, expect: wholeDocChoice(RENAMED_SCRIPT) },
    // Same reply at whole scope is exactly right → a plain proposal.
    { name: 'wholeDocRewrite @ whole', reply: REPLIES.wholeDocRewrite, sel: null, expect: proposalIs(RENAMED_SCRIPT, null) },

    // Whole-doc reply that echoes the out-of-selection context (Signal A).
    { name: 'wholeDocEchoContext @ selection', reply: REPLIES.wholeDocEchoContext, sel: SEL_LINE3, expect: wholeDocChoice(CONTEXT_ECHO_SCRIPT) },
    { name: 'wholeDocEchoContext @ whole', reply: REPLIES.wholeDocEchoContext, sel: null, expect: proposalIs(CONTEXT_ECHO_SCRIPT, null) },

    // Reply identical to input → honest no-change (scope-matched).
    { name: 'identicalSelection @ selection', reply: REPLIES.identicalSelection, sel: SEL_LINE1, expect: noChange },
    { name: 'identicalWhole @ whole', reply: REPLIES.identicalWhole, sel: null, expect: noChange },

    // Multi-fence → last block wins.
    { name: 'multiFence @ selection', reply: REPLIES.multiFence, sel: SEL_LINE1, expect: proposalIs('_total := 999', SEL_LINE1) },
    { name: 'multiFence @ whole', reply: REPLIES.multiFence, sel: null, expect: proposalIs('_total := 999', null) },

    // Prose only → error, nothing spliced.
    { name: 'proseOnly @ selection', reply: REPLIES.proseOnly, sel: SEL_LINE1, expect: errorLike(/did not contain code/) },
    { name: 'proseOnly @ whole', reply: REPLIES.proseOnly, sel: null, expect: errorLike(/did not contain code/) },

    // DSML-contaminated → scrubbed, then the real fence is proposed.
    { name: 'dsmlContaminated @ selection', reply: REPLIES.dsmlContaminated, sel: SEL_LINE1, expect: proposalIs('_total := 100', SEL_LINE1) },
    { name: 'dsmlContaminated @ whole', reply: REPLIES.dsmlContaminated, sel: null, expect: proposalIs('_total := 100', null) },

    // Empty fence → error (never a silent deletion / whole-doc wipe).
    { name: 'emptyFence @ selection', reply: REPLIES.emptyFence, sel: SEL_LINE1, expect: errorLike(/did not contain code/) },
    { name: 'emptyFence @ whole', reply: REPLIES.emptyFence, sel: null, expect: errorLike(/did not contain code/) },

    // Empty fence then a real one → the real block is used.
    { name: 'emptyThenReal @ selection', reply: REPLIES.emptyThenReal, sel: SEL_LINE1, expect: proposalIs('_total := 100', SEL_LINE1) },
    { name: 'emptyThenReal @ whole', reply: REPLIES.emptyThenReal, sel: null, expect: proposalIs('_total := 100', null) },
  ];

  for (const row of rows) {
    it(row.name, () => {
      row.expect(resolveEdit(row.reply, DOC, row.sel));
    });
  }

  // The guard case: the selection IS most of the document. A full-length reply
  // must be treated as a normal proposal, NOT a whole-doc choice.
  it('wholeDocRewrite @ most-of-doc selection → proposal, heuristic does NOT fire', () => {
    const o = resolveEdit(REPLIES.wholeDocRewrite, DOC, SEL_MOST);
    expect(o.kind).toBe('proposal');
  });
});

describe('detectWholeDocRewrite — signals + guard', () => {
  it('does not fire for a whole-script scope (no selection)', () => {
    expect(detectWholeDocRewrite(DOC, RENAMED_SCRIPT, null)).toBe(false);
  });

  it('fires on Signal B (reply is ~whole doc by line count) for a small selection', () => {
    expect(detectWholeDocRewrite(DOC, RENAMED_SCRIPT, SEL_LINE1)).toBe(true);
  });

  it('fires on Signal A (reply echoes out-of-selection context)', () => {
    expect(detectWholeDocRewrite(DOC, CONTEXT_ECHO_SCRIPT, SEL_LINE3)).toBe(true);
  });

  it('does NOT fire when the selection already covers most of the doc', () => {
    expect(detectWholeDocRewrite(DOC, RENAMED_SCRIPT, SEL_MOST)).toBe(false);
  });

  it('does NOT fire for a genuine selection-scoped replacement', () => {
    expect(detectWholeDocRewrite(DOC, '_total := 100', SEL_LINE1)).toBe(false);
  });
});

describe('insert-at-cursor composition (zero-width splice)', () => {
  // Insert reuses composeReplacement with a zero-width selection at the cursor.
  const insertAt = (pos: number, code: string): string =>
    composeReplacement(DOC, code, { from: pos, to: pos, text: '' });

  it('inserts at the start of the document', () => {
    expect(insertAt(0, 'X\n')).toBe('X\n' + DOC);
  });

  it('inserts at the end of the document', () => {
    expect(insertAt(DOC.length, '\nY')).toBe(DOC + '\nY');
  });

  it('inserts in the middle without dropping surrounding text', () => {
    const pos = DOC.indexOf('descendants');
    const out = insertAt(pos, '// note\n');
    expect(out).toBe(DOC.slice(0, pos) + '// note\n' + DOC.slice(pos));
    // No character of the original is lost.
    expect(out.replace('// note\n', '')).toBe(DOC);
  });

  it('an empty insertion is a no-op', () => {
    expect(insertAt(5, '')).toBe(DOC);
  });
});

describe('DSML scrubber interplay', () => {
  it('scrubToolMarkup strips the tool-call container entirely', () => {
    const clean = scrubToolMarkup(REPLIES.dsmlContaminated);
    expect(clean).not.toMatch(/DSML/);
    expect(clean).toContain('_total := 100');
  });

  it('extractReplyCode scrubs before parsing, so DSML never reaches the doc', () => {
    const { code } = extractReplyCode(REPLIES.dsmlContaminated);
    expect(code).toBe('_total := 100');
  });
});

describe('invariant — the document is never silently corrupted', () => {
  const scopes: { name: string; sel: AiSelection | null }[] = [
    { name: 'selection(line1)', sel: SEL_LINE1 },
    { name: 'selection(line3)', sel: SEL_LINE3 },
    { name: 'selection(most)', sel: SEL_MOST },
    { name: 'whole', sel: null },
  ];
  for (const [key, reply] of Object.entries(REPLIES)) {
    for (const scope of scopes) {
      it(`${key} @ ${scope.name} → honest & reviewable`, () => {
        const o = resolveEdit(reply, DOC, scope.sel);
        // Outcome is always one of the four honest kinds.
        expect(['error', 'no-change', 'proposal', 'whole-doc-choice']).toContain(o.kind);
        // A proposal must be a real change AND must not lose the original when it
        // is a genuine selection-scoped splice (the outside text is preserved by
        // construction). A whole-doc choice targets the full document, never the
        // selection range — so the bug (splice a whole script into a slot) can't
        // happen.
        if (o.kind === 'proposal') expect(o.after).not.toBe(DOC);
      });
    }
  }
});
