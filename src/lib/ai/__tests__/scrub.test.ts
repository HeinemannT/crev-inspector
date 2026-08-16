import { describe, it, expect } from 'vitest';
import { ToolMarkupScrubber, scrubModelReasoning, scrubToolMarkup } from '../scrub';

/** Feed a whole string through a fresh scrubber as ONE chunk. */
function whole(s: string): string {
  const sc = new ToolMarkupScrubber();
  return sc.feed(s) + sc.flush();
}

/** Feed a string one character at a time — the worst case for marker splits. */
function perChar(s: string): string {
  const sc = new ToolMarkupScrubber();
  let out = '';
  for (const ch of s) out += sc.feed(ch);
  return out + sc.flush();
}

/** Feed with an explicit split point so a marker straddles two chunks. */
function split(s: string, at: number): string {
  const sc = new ToolMarkupScrubber();
  return sc.feed(s.slice(0, at)) + sc.feed(s.slice(at)) + sc.flush();
}

const DSML_BLOCK =
  'Here is the answer.\n' +
  '<｜｜DSML｜｜tool_calls>\n' +
  '<｜｜DSML｜｜invoke name="search_objects">\n' +
  '<｜｜DSML｜｜parameter name="query">risk<｜｜DSML｜｜/parameter>\n' +
  '<｜｜DSML｜｜parameter name="limit">10<｜｜DSML｜｜/parameter>\n' +
  '<｜｜DSML｜｜/invoke>\n' +
  '<｜｜DSML｜｜/tool_calls>';

describe('ToolMarkupScrubber', () => {
  it('passes clean text through untouched', () => {
    const s = 'Just a normal answer with `code` and <div> HTML and a < b comparison.';
    expect(whole(s)).toBe(s);
    expect(perChar(s)).toBe(s);
  });

  it('strips a complete DSML tool_calls block and its inner text', () => {
    const out = whole(DSML_BLOCK);
    expect(out).toBe('Here is the answer.\n');
    expect(out).not.toContain('DSML');
    expect(out).not.toContain('search_objects');
    expect(out).not.toContain('risk');
    expect(out).not.toContain('limit');
  });

  it('strips the block identically no matter where chunks split (per-char)', () => {
    expect(perChar(DSML_BLOCK)).toBe('Here is the answer.\n');
  });

  it('handles a marker split exactly on the boundary `<` | `｜…`', () => {
    // Split right after the first `<` of the opening token.
    const at = DSML_BLOCK.indexOf('<｜') + 1;
    expect(split(DSML_BLOCK, at)).toBe('Here is the answer.\n');
    // And split in the middle of the token name.
    const mid = DSML_BLOCK.indexOf('tool_calls') + 4;
    expect(split(DSML_BLOCK, mid)).toBe('Here is the answer.\n');
  });

  it('drops an unclosed block at end of stream, keeping preceding text', () => {
    const s = 'Answer.\n<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name="x">unterminated';
    expect(whole(s)).toBe('Answer.\n');
    expect(perChar(s)).toBe('Answer.\n');
  });

  it('resumes emitting real text after a closed block', () => {
    const s = 'A<｜｜DSML｜｜tool_calls><｜｜DSML｜｜/tool_calls>B';
    expect(whole(s)).toBe('AB');
    expect(perChar(s)).toBe('AB');
  });

  it('holds back a lone trailing `<` until the next chunk disambiguates it', () => {
    const sc = new ToolMarkupScrubber();
    expect(sc.feed('value <')).toBe('value '); // `<` held back
    expect(sc.feed(' 3')).toBe('< 3');          // not a marker — emitted
    expect(sc.flush()).toBe('');
  });

  it('supports the ASCII-pipe variant `<|…|>` too', () => {
    const s = 'ok <|tool_calls|><|/tool_calls|> done';
    expect(whole(s)).toBe('ok  done');
  });

  it('scrubToolMarkup one-shot matches the streaming result', () => {
    expect(scrubToolMarkup(DSML_BLOCK)).toBe('Here is the answer.\n');
    expect(scrubToolMarkup('plain')).toBe('plain');
  });

  it('removes a complete provider reasoning block while preserving surrounding answer text', () => {
    const s = 'Before. <think>internal chain of thought</think>After.';
    expect(scrubModelReasoning(s)).toBe('Before. After.');
  });

  it('suppresses an incomplete leading reasoning block in cumulative streaming snapshots', () => {
    expect(scrubModelReasoning('<think>internal reasoning')).toBe('');
    expect(scrubModelReasoning('Safe prefix. <think>still reasoning')).toBe('Safe prefix. ');
    expect(scrubModelReasoning('<think>internal reasoning</think>Visible answer.')).toBe('Visible answer.');
  });

  it('treats a stray reasoning close tag as the boundary before the answer', () => {
    const s = 'provider reasoning leaked before the delimiter</think>Visible answer.';
    expect(scrubModelReasoning(s)).toBe('Visible answer.');
  });
});
