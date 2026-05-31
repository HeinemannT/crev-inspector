/**
 * Tests for parsePipeLines with 5-field enrichment format.
 *
 * Validates that the shared parser handles the new template businessId field
 * while maintaining backward compatibility with 4-field format.
 */
import { describe, it, expect } from 'vitest';
import { parsePipeLines } from '../ec-parser';

describe('parsePipeLines: 5-field enrichment format', () => {
  it('parses 5-field lines when minFields=4', () => {
    const log = '12345|||bid|||Type|||Name|||t.100';
    const results = parsePipeLines(log, 4);
    expect(results).toHaveLength(1);
    expect(results[0]).toEqual(['12345', 'bid', 'Type', 'Name', 't.100']);
  });

  it('parses 5-field lines when minFields=5', () => {
    const log = '12345|||bid|||Type|||Name|||t.100';
    const results = parsePipeLines(log, 5);
    expect(results).toHaveLength(1);
    expect(results[0]).toHaveLength(5);
  });

  it('rejects 4-field lines when minFields=5', () => {
    const log = '12345|||bid|||Type|||Name';
    const results = parsePipeLines(log, 5);
    expect(results).toHaveLength(0);
  });

  it('accepts 4-field lines when minFields=4', () => {
    const log = '12345|||bid|||Type|||Name';
    const results = parsePipeLines(log, 4);
    expect(results).toHaveLength(1);
    expect(results[0]).toHaveLength(4);
  });

  it('handles mixed 4-field and 5-field lines with minFields=4', () => {
    const log = [
      '111|||bid1|||Type1|||Name1',
      '222|||bid2|||Type2|||Name2|||tmpl2',
    ].join('\n');
    const results = parsePipeLines(log, 4);
    expect(results).toHaveLength(2);
    expect(results[0]).toHaveLength(4);
    expect(results[1]).toHaveLength(5);
    expect(results[1][4]).toBe('tmpl2');
  });

  it('strips whitespace from all fields', () => {
    const log = '  12345  |||  bid  |||  Type  |||  Name  |||  t.100  ';
    const results = parsePipeLines(log, 4);
    expect(results[0]).toEqual(['12345', 'bid', 'Type', 'Name', 't.100']);
  });

  it('skips SKIP lines in 5-field format', () => {
    const log = [
      'SKIP|||||||||||',
      '12345|||bid|||Type|||Name|||t.100',
    ].join('\n');
    const results = parsePipeLines(log, 4);
    expect(results).toHaveLength(1);
    expect(results[0][0]).toBe('12345');
  });

  it('skips MISSING lines in 5-field format', () => {
    const log = [
      'MISSING|||||||||||',
      '12345|||bid|||Type|||Name|||t.100',
    ].join('\n');
    const results = parsePipeLines(log, 4);
    expect(results).toHaveLength(1);
  });

  it('skips non-pipe lines (Duration, noise)', () => {
    const log = [
      'Result : 0',
      '12345|||bid|||Type|||Name|||t.100',
      'Duration : 5ms',
    ].join('\n');
    const results = parsePipeLines(log, 4);
    expect(results).toHaveLength(1);
  });

  it('handles empty template businessId (5th field empty)', () => {
    const log = '12345|||bid|||Type|||Name|||';
    const results = parsePipeLines(log, 4);
    expect(results).toHaveLength(1);
    expect(results[0]).toHaveLength(5);
    expect(results[0][4]).toBe(''); // empty string after trim
  });

  it('handles scale: 25 lines (one batch chunk)', () => {
    const lines: string[] = [];
    for (let i = 0; i < 25; i++) {
      lines.push(`${1000 + i}|||bid${i}|||Type|||Name${i}|||tmpl${i}`);
    }
    const results = parsePipeLines(lines.join('\n'), 4);
    expect(results).toHaveLength(25);
    expect(results[24][4]).toBe('tmpl24');
  });

  it('handles Windows CRLF line endings', () => {
    const log = '12345|||bid|||Type|||Name|||t.100\r\n67890|||bid2|||Type2|||Name2|||t.200\r\n';
    const results = parsePipeLines(log, 4);
    expect(results).toHaveLength(2);
    // CRLF: \r is left in last field but trimmed
    expect(results[0][4]).toBe('t.100');
    expect(results[1][4]).toBe('t.200');
  });
});
