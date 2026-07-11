/**
 * Tests for the frame-side edit-reply parsing in ai-assist.ts:
 *   - extractReplyCode: multi-fence LAST-preference + same-as-input fallback
 *     (the fix for "repeat Edit requests silently propose a no-op").
 *   - composeReplacement: the whole-document a proposal would produce, used to
 *     detect a byte-identical no-op before showing an Accept/Reject bar.
 *
 * These are pure functions — no DOM needed. They mirror the SW-side
 * extractCodeBlock (src/lib/ai/prompt.ts), which has its own suite.
 */
import { describe, it, expect } from 'vitest';
import { extractReplyCode, composeReplacement } from '../ai-assist';
import type { AiSelection } from '../../lib/ai/types';

describe('extractReplyCode', () => {
  it('takes the (only) fenced block', () => {
    const reply = 'Here:\n```extended\noutput(t.x.name)\n```';
    expect(extractReplyCode(reply)).toEqual({ code: 'output(t.x.name)' });
  });

  it('prefers the LAST fence when the model quotes the original first, then the fix', () => {
    const reply = 'Broken:\n```\nfoo()\n```\nCorrected:\n```\nfoo(bar)\n```';
    expect(extractReplyCode(reply)).toEqual({ code: 'foo(bar)' });
  });

  it('falls back to an earlier fence when the last block equals the input', () => {
    const current = 'output(t.x.name)';
    const reply = '```\noutput(t.x.name.whenMissing(""))\n```\n```\noutput(t.x.name)\n```';
    expect(extractReplyCode(reply, current)).toEqual({ code: 'output(t.x.name.whenMissing(""))' });
  });

  it('returns the same-as-input code when all fences match the input (UI treats as no-op)', () => {
    const current = 'output(t.x.name)';
    const reply = '```\noutput(t.x.name)\n```';
    expect(extractReplyCode(reply, current)).toEqual({ code: current });
  });

  it('errors on a prose-only reply', () => {
    const r = extractReplyCode('This reads the name. It returns the display value.');
    expect(r.code).toBeNull();
    expect(r.error).toMatch(/did not contain code/);
  });

  it('errors on an empty reply', () => {
    expect(extractReplyCode('   ').code).toBeNull();
  });
});

describe('composeReplacement', () => {
  const before = 'AAA BBB CCC';

  it('replaces the whole document when there is no selection', () => {
    expect(composeReplacement(before, 'ZZZ', null)).toBe('ZZZ');
  });

  it('splices a selection-scoped replacement into the document', () => {
    const sel: AiSelection = { from: 4, to: 7, text: 'BBB' };
    expect(composeReplacement(before, 'XXX', sel)).toBe('AAA XXX CCC');
  });

  it('yields a byte-identical document (a no-op) when the replacement equals the selection', () => {
    const sel: AiSelection = { from: 4, to: 7, text: 'BBB' };
    expect(composeReplacement(before, 'BBB', sel)).toBe(before);
  });

  it('yields a no-op when the whole-document replacement equals the original', () => {
    expect(composeReplacement(before, before, null)).toBe(before);
  });
});
