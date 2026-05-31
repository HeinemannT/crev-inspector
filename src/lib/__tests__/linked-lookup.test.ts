/**
 * Tests for the generic linked object lookup system.
 *
 * Covers:
 * - Parser: pipe-delimited EC output (id|||name|||rid) — shared by all linked types
 * - Config: LINKED_OBJECTS definitions for InputView→InputSet, CreateObjectView→EditPage
 * - EC code generation per linked type
 * - Edge cases: no linked object, empty fields, failure, multiline output
 */
import { describe, it, expect } from 'vitest';

// ── Generic linked object parser (mirrors message-router.ts handleLinkedLookup) ──

interface LinkedResult {
  linkedId?: string;
  linkedName?: string;
  linkedRid?: string;
  error?: string;
}

function parseLinkedLookup(log: string | undefined | null, ok: boolean, error?: string): LinkedResult {
  if (!ok) return { error: error ?? 'EC execution failed' };
  if (!log || !log.includes('|||')) return {};

  const line = log.trim().split('\n').find(l => l.includes('|||'));
  if (!line) return {};

  const [lId, lName, lRid] = line.split('|||').map(s => s.trim());
  return {
    linkedId: lId || undefined,
    linkedName: lName || undefined,
    linkedRid: lRid || undefined,
  };
}

// ── Linked object config (mirrors message-router.ts LINKED_OBJECTS) ──

interface LinkedObjectDef {
  key: string;
  label: string;
  ecProperty: string;
}

const LINKED_OBJECTS: Record<string, LinkedObjectDef[]> = {
  InputView: [
    { key: 'inputset', label: 'InputSet', ecProperty: 'inputset' },
  ],
  CreateObjectView: [
    { key: 'editpage', label: 'EditPage', ecProperty: 'editPage' },
  ],
};

function generateLinkedEc(ref: string, ecProperty: string): string {
  return [
    `_p := ${ref}`,
    `_l := _p.${ecProperty}`,
    'IF _l != MISSING THEN',
    '  _l.id.whenMissing("") + "|||" + _l.name.whenMissing("") + "|||" + _l.rid.whenMissing("")',
    'ELSE',
    '  ""',
    'ENDIF',
  ].join('\n');
}

// ── Parser tests ──

describe('Linked lookup parser (generic)', () => {
  it('parses valid linked object with all fields', () => {
    const result = parseLinkedLookup('t.45|||Risk Input Set|||8765432109876543210', true);
    expect(result.linkedId).toBe('t.45');
    expect(result.linkedName).toBe('Risk Input Set');
    expect(result.linkedRid).toBe('8765432109876543210');
    expect(result.error).toBeUndefined();
  });

  it('parses linked object with empty name', () => {
    const result = parseLinkedLookup('t.45||||||8765432109876543210', true);
    expect(result.linkedId).toBe('t.45');
    expect(result.linkedName).toBeUndefined();
    expect(result.linkedRid).toBe('8765432109876543210');
  });

  it('handles no linked object (empty output from ELSE branch)', () => {
    const result = parseLinkedLookup('', true);
    expect(result.linkedId).toBeUndefined();
    expect(result.linkedName).toBeUndefined();
    expect(result.linkedRid).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  it('handles null output', () => {
    const result = parseLinkedLookup(null, true);
    expect(result.linkedId).toBeUndefined();
    expect(result.error).toBeUndefined();
  });

  it('handles EC failure', () => {
    const result = parseLinkedLookup(null, false, 'Not connected');
    expect(result.error).toBe('Not connected');
  });

  it('handles multiline output with noise', () => {
    const log = 'Result : 0\nt.99|||Edit Page ABC|||1234567890\nDuration : 5ms';
    const result = parseLinkedLookup(log, true);
    expect(result.linkedId).toBe('t.99');
    expect(result.linkedName).toBe('Edit Page ABC');
    expect(result.linkedRid).toBe('1234567890');
  });

  it('handles spaces around fields', () => {
    const result = parseLinkedLookup('  t.10  |||  My Set  |||  999  ', true);
    expect(result.linkedId).toBe('t.10');
    expect(result.linkedName).toBe('My Set');
    expect(result.linkedRid).toBe('999');
  });

  it('handles all-empty fields (degenerate case)', () => {
    const result = parseLinkedLookup('||||||', true);
    expect(result.linkedId).toBeUndefined();
    expect(result.linkedName).toBeUndefined();
    expect(result.linkedRid).toBeUndefined();
  });

  it('handles output without pipe separator', () => {
    const result = parseLinkedLookup('some random EC output', true);
    expect(result.linkedId).toBeUndefined();
  });
});

// ── Config tests ──

describe('LINKED_OBJECTS config', () => {
  it('InputView has InputSet link', () => {
    const defs = LINKED_OBJECTS['InputView'];
    expect(defs).toHaveLength(1);
    expect(defs[0]).toEqual({ key: 'inputset', label: 'InputSet', ecProperty: 'inputset' });
  });

  it('CreateObjectView has EditPage link', () => {
    const defs = LINKED_OBJECTS['CreateObjectView'];
    expect(defs).toHaveLength(1);
    expect(defs[0]).toEqual({ key: 'editpage', label: 'EditPage', ecProperty: 'editPage' });
  });

  it('unknown types have no links', () => {
    expect(LINKED_OBJECTS['Scorecard']).toBeUndefined();
    expect(LINKED_OBJECTS['ExtendedTable']).toBeUndefined();
    expect(LINKED_OBJECTS['Organisation']).toBeUndefined();
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
    const code = generateLinkedEc('lookup(12345)', 'inputset');
    expect(code).toContain('_p := lookup(12345)');
    expect(code).toContain('_l := _p.inputset');
    expect(code).toContain('IF _l != MISSING THEN');
    expect(code).toContain('ELSE');
    expect(code).toContain('ENDIF');
    expect(code).toContain('_l.id.whenMissing("")');
  });

  it('generates valid EC for EditPage (property: editPage)', () => {
    const code = generateLinkedEc('lookup(67890)', 'editPage');
    expect(code).toContain('_l := _p.editPage');
    // Property access — no parens (EC rule)
    expect(code).not.toContain('_p.editPage()');
  });

  it('uses property access not method call', () => {
    for (const defs of Object.values(LINKED_OBJECTS)) {
      for (const def of defs) {
        const code = generateLinkedEc('lookup(1)', def.ecProperty);
        expect(code).toContain(`_p.${def.ecProperty}`);
        expect(code).not.toContain(`_p.${def.ecProperty}()`);
      }
    }
  });

  it('output format has 3 pipe-separated fields: id|||name|||rid', () => {
    const code = generateLinkedEc('lookup(1)', 'inputset');
    const outputLine = code.split('\n').find(l => l.includes('_l.id.whenMissing'));
    expect(outputLine).toBeDefined();
    const pipeCount = (outputLine!.match(/\|\|\|/g) || []).length;
    expect(pipeCount).toBe(2);
  });

  it('has mandatory ELSE branch (EC requirement)', () => {
    const code = generateLinkedEc('lookup(1)', 'anything');
    expect(code).toContain('ELSE');
    expect(code).toContain('""');
  });
});
