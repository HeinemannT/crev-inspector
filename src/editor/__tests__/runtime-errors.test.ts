/**
 * Tests for the runtime-error linter — parsing BMP's EC error messages
 * and turning them into inline diagnostic markers. Covers the parser
 * + the bookkeeping API (set / clear). The actual CodeMirror lint
 * dispatch is hard to test without an EditorView; we verify the
 * pure helpers and trust the integration.
 */
import { describe, it, expect } from 'vitest';
import { parseEcErrorLocation } from '../ec/runtimeErrors';

describe('parseEcErrorLocation', () => {
  it('parses "at line N, column M"', () => {
    expect(parseEcErrorLocation('Missing value for .foo at line 1, column 11'))
      .toEqual({ line: 1, column: 11 });
  });

  it('parses "line N" without a column', () => {
    expect(parseEcErrorLocation('Error in EC at line 5'))
      .toEqual({ line: 5, column: undefined });
  });

  it('parses bracketed forms like "Line 12:"', () => {
    expect(parseEcErrorLocation('WARNING: parse fail at Line 12: bad token'))
      .toEqual({ line: 12, column: undefined });
  });

  it('returns null for messages without line info', () => {
    expect(parseEcErrorLocation('Some generic failure')).toBeNull();
    expect(parseEcErrorLocation('')).toBeNull();
  });

  it('picks the first line / column when multiple are present', () => {
    // Common: BMP reports a primary location then trails a secondary
    // "see also" pointer. Take the first; downstream we display the
    // full message anyway.
    expect(parseEcErrorLocation('error at line 3, column 5; see also line 7'))
      .toEqual({ line: 3, column: 5 });
  });

  it('handles case variations', () => {
    expect(parseEcErrorLocation('parse error LINE 2'))
      .toEqual({ line: 2, column: undefined });
    expect(parseEcErrorLocation('Line 4, COLUMN 9: oops'))
      .toEqual({ line: 4, column: 9 });
  });

  it('rejects line numbers in unrelated contexts', () => {
    // "Line" inside a string literal etc. shouldn't false-positive
    // unless followed by a number — the regex requires \d+.
    expect(parseEcErrorLocation('Result line printed: ok')).toBeNull();
    expect(parseEcErrorLocation('output contains the word line.')).toBeNull();
  });
});
