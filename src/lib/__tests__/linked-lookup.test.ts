/**
 * Tests for the generic linked object lookup system.
 *
 * Exercises the SHIPPED code in ../handlers/objects — the EC builder, the
 * pipe-delimited parser, and the LINKED_OBJECTS config the LINKED_LOOKUP
 * handler uses. No local copies: a divergence between test and shipped code
 * would fail the build.
 *
 * Covers:
 * - Parser: pipe-delimited EC output (id|||name|||rid) — shared by all linked types
 * - Config: LINKED_OBJECTS definitions for InputView→InputSet, CreateObjectView→EditPage
 * - EC code generation per linked type
 * - Edge cases: no linked object, empty fields, multiline output
 */
import { describe, it, expect } from 'vitest';
import { LINKED_OBJECTS, getLinkedDefs, buildLinkedEc, parseLinkedLog } from '../handlers/objects';

// ── Parser tests ──
// parseLinkedLog only parses log text. The EC-failure (ok === false) branch
// lives in the LINKED_LOOKUP handler, not the parser, so it isn't asserted here.

describe('Linked lookup parser (generic)', () => {
  it('parses valid linked object with all fields', () => {
    const result = parseLinkedLog('t.45|||Risk Input Set|||8765432109876543210');
    expect(result.linkedId).toBe('t.45');
    expect(result.linkedName).toBe('Risk Input Set');
    expect(result.linkedRid).toBe('8765432109876543210');
  });

  it('parses linked object with empty name', () => {
    const result = parseLinkedLog('t.45||||||8765432109876543210');
    expect(result.linkedId).toBe('t.45');
    expect(result.linkedName).toBeUndefined();
    expect(result.linkedRid).toBe('8765432109876543210');
  });

  it('handles no linked object (empty output from ELSE branch)', () => {
    const result = parseLinkedLog('');
    expect(result.linkedId).toBeUndefined();
    expect(result.linkedName).toBeUndefined();
    expect(result.linkedRid).toBeUndefined();
  });

  it('handles undefined output', () => {
    const result = parseLinkedLog(undefined);
    expect(result.linkedId).toBeUndefined();
  });

  it('handles multiline output with noise', () => {
    const log = 'Result : 0\nt.99|||Edit Page ABC|||1234567890\nDuration : 5ms';
    const result = parseLinkedLog(log);
    expect(result.linkedId).toBe('t.99');
    expect(result.linkedName).toBe('Edit Page ABC');
    expect(result.linkedRid).toBe('1234567890');
  });

  it('handles spaces around fields', () => {
    const result = parseLinkedLog('  t.10  |||  My Set  |||  999  ');
    expect(result.linkedId).toBe('t.10');
    expect(result.linkedName).toBe('My Set');
    expect(result.linkedRid).toBe('999');
  });

  it('handles all-empty fields (degenerate case)', () => {
    const result = parseLinkedLog('||||||');
    expect(result.linkedId).toBeUndefined();
    expect(result.linkedName).toBeUndefined();
    expect(result.linkedRid).toBeUndefined();
  });

  it('handles output without pipe separator', () => {
    const result = parseLinkedLog('some random EC output');
    expect(result.linkedId).toBeUndefined();
  });
});

// ── Config tests ──

describe('LINKED_OBJECTS config', () => {
  it('InputView has InputSet link', () => {
    const defs = getLinkedDefs('InputView');
    expect(defs).toHaveLength(1);
    expect(defs[0]).toEqual({ key: 'inputset', label: 'InputSet', ecProperty: 'inputset' });
  });

  it('CreateObjectView has EditPage link', () => {
    const defs = getLinkedDefs('CreateObjectView');
    expect(defs).toHaveLength(1);
    expect(defs[0]).toEqual({ key: 'editpage', label: 'EditPage', ecProperty: 'editPage' });
  });

  it('unknown types have no links', () => {
    expect(getLinkedDefs('Scorecard')).toEqual([]);
    expect(getLinkedDefs('ExtendedTable')).toEqual([]);
    expect(getLinkedDefs('Organisation')).toEqual([]);
  });

  it('all keys are unique across all types', () => {
    const allKeys = new Set<string>();
    for (const defs of Object.values(LINKED_OBJECTS)) {
      for (const def of defs) {
        expect(allKeys.has(def.key)).toBe(false);
        allKeys.add(def.key);
      }
    }
  });
});

// ── EC code generation tests ──

describe('Linked object EC code generation', () => {
  it('generates valid EC for InputSet (property: inputset)', () => {
    const code = buildLinkedEc('lookup(12345)', 'inputset');
    expect(code).toContain('_p := lookup(12345)');
    expect(code).toContain('_l := _p.inputset');
    expect(code).toContain('IF _l != MISSING THEN');
    expect(code).toContain('ELSE');
    expect(code).toContain('ENDIF');
    expect(code).toContain('_l.id.whenMissing("")');
  });

  it('generates valid EC for EditPage (property: editPage)', () => {
    const code = buildLinkedEc('lookup(67890)', 'editPage');
    expect(code).toContain('_l := _p.editPage');
    // Property access — no parens (EC rule)
    expect(code).not.toContain('_p.editPage()');
  });

  it('uses property access not method call', () => {
    for (const defs of Object.values(LINKED_OBJECTS)) {
      for (const def of defs) {
        const code = buildLinkedEc('lookup(1)', def.ecProperty);
        expect(code).toContain(`_p.${def.ecProperty}`);
        expect(code).not.toContain(`_p.${def.ecProperty}()`);
      }
    }
  });

  it('output format has 3 pipe-separated fields: id|||name|||rid', () => {
    const code = buildLinkedEc('lookup(1)', 'inputset');
    const outputLine = code.split('\n').find(l => l.includes('_l.id.whenMissing'));
    expect(outputLine).toBeDefined();
    const pipeCount = (outputLine!.match(/\|\|\|/g) || []).length;
    expect(pipeCount).toBe(2);
  });

  it('has mandatory ELSE branch (EC requirement)', () => {
    const code = buildLinkedEc('lookup(1)', 'anything');
    expect(code).toContain('ELSE');
    expect(code).toContain('""');
  });
});
