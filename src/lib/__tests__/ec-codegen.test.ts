/**
 * Tests for EC code generation — validates that the EC strings we build
 * are syntactically correct Extended Code.
 *
 * Covers:
 * - batchEnrich EC: template businessId extraction via linkedTo + .template fallback
 * - InputSet lookup EC
 * - resolveTemplate EC with businessId field
 * - RID injection safety
 * - EC syntax validation (no bare inline IF after :=)
 */
import { describe, it, expect } from 'vitest';

// ── EC code generators (must match bmp-client.ts EXACTLY) ──

function generateBatchEnrichEc(rids: string[]): string {
  const BATCH_CHUNK_SIZE = 25;
  let valid = rids.filter(Boolean).filter(rid => /^-?\d+$/.test(rid));
  if (valid.length === 0) return '';
  if (valid.length > BATCH_CHUNK_SIZE) valid = valid.slice(0, BATCH_CHUNK_SIZE);

  const lines = ['_d := "|||"', '_r := ""'];
  for (const rid of valid) {
    lines.push(`_o := lookup(${rid})`);
    lines.push('IF _o != MISSING THEN');
    lines.push('  _t := _o.linkedTo');
    // Enterprise objects use .template instead of .linkedTo
    lines.push('  IF _t = MISSING THEN');
    lines.push('    _t := _o.template');
    lines.push('  ENDIF');
    lines.push('  _tid := (IF _t != MISSING THEN _t.id.whenMissing("") ELSE "" ENDIF)');
    lines.push('  _r := _r + _o.rid.whenMissing("SKIP") + _d + _o.id.whenMissing("") + _d + _o.className.whenMissing("") + _d + _o.name.whenMissing("") + _d + _tid + "\\n"');
    lines.push('ENDIF');
  }
  lines.push('_r');
  return lines.join('\n');
}

function generateResolveTemplateEc(ref: string): string {
  return [
    `_o := ${ref}`,
    '_t := _o.linkedTo',
    '_t.rid.whenMissing("MISSING") + "|||" + _t.name.whenMissing("") + "|||" + _t.className.whenMissing("") + "|||" + _t.id.whenMissing("")',
  ].join('\n');
}

function generateLinkedLookupEc(ref: string, ecProperty: string): string {
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

// ── EC syntax validator ──

/** Checks common EC syntax errors that would cause parse failures on BMP */
function validateEcSyntax(code: string): string[] {
  const errors: string[] = [];
  const lines = code.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const lineNum = i + 1;

    // Rule: inline IF after := MUST be wrapped in parentheses
    // Bad:  _x := IF ... THEN ... ELSE ... ENDIF
    // Good: _x := (IF ... THEN ... ELSE ... ENDIF)
    if (/:=\s+IF\b/.test(line) && !/:=\s+\(IF\b/.test(line)) {
      errors.push(`Line ${lineNum}: bare inline IF after := — must wrap in parentheses: ${line}`);
    }

    // Rule: every IF must have matching ENDIF (basic count check)
    // Rule: every IF must have ELSE (EC requirement for inline IF expressions)
  }

  // Global IF/ENDIF balance
  const ifCount = lines.filter(l => /^\s*IF\b/.test(l)).length;
  const endifCount = lines.filter(l => /^\s*ENDIF\b/.test(l)).length;
  if (ifCount !== endifCount) {
    errors.push(`IF/ENDIF mismatch: ${ifCount} IF vs ${endifCount} ENDIF`);
  }

  // Parenthesized inline IFs also count
  const inlineIfCount = (code.match(/\(IF\b/g) || []).length;
  const inlineEndifCount = (code.match(/ENDIF\)/g) || []).length;
  if (inlineIfCount !== inlineEndifCount) {
    errors.push(`Inline IF/ENDIF mismatch: ${inlineIfCount} (IF vs ${inlineEndifCount} ENDIF)`);
  }

  return errors;
}

// ── Tests ──

describe('EC syntax validation', () => {
  it('rejects bare inline IF after :=', () => {
    const badCode = '_tid := IF _t != MISSING THEN _t.id ELSE "" ENDIF';
    const errors = validateEcSyntax(badCode);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain('bare inline IF');
  });

  it('accepts parenthesized inline IF after :=', () => {
    const goodCode = '_tid := (IF _t != MISSING THEN _t.id ELSE "" ENDIF)';
    const errors = validateEcSyntax(goodCode);
    expect(errors.filter(e => e.includes('bare inline IF'))).toHaveLength(0);
  });

  it('accepts block IF statements', () => {
    const code = 'IF _o != MISSING THEN\n  _x := _o.name\nENDIF';
    const errors = validateEcSyntax(code);
    expect(errors).toHaveLength(0);
  });
});

describe('batchEnrich EC code generation', () => {
  it('generates valid EC for a single RID', () => {
    const code = generateBatchEnrichEc(['12345']);
    expect(code).toContain('_d := "|||"');
    expect(code).toContain('_r := ""');
    expect(code).toContain('_o := lookup(12345)');
    expect(code).toContain('_t := _o.linkedTo');
    expect(code).toContain('_d + _tid');
    expect(code).toMatch(/_r$/); // ends with _r output
  });

  it('passes EC syntax validation', () => {
    const code = generateBatchEnrichEc(['12345', '67890']);
    const errors = validateEcSyntax(code);
    expect(errors).toHaveLength(0);
  });

  it('uses parenthesized inline IF for template ID', () => {
    const code = generateBatchEnrichEc(['12345']);
    expect(code).toContain('_tid := (IF _t != MISSING THEN');
    expect(code).toContain('ENDIF)');
    // Must NOT have bare IF after :=
    expect(code).not.toMatch(/:=\s+IF\b(?!\s*\()/);
  });

  it('includes enterprise template fallback (.template)', () => {
    const code = generateBatchEnrichEc(['12345']);
    expect(code).toContain('_t := _o.linkedTo');
    expect(code).toContain('IF _t = MISSING THEN');
    expect(code).toContain('_t := _o.template');
  });

  it('generates one lookup block per RID', () => {
    const rids = ['111', '222', '333'];
    const code = generateBatchEnrichEc(rids);
    const lookupCount = (code.match(/lookup\(/g) || []).length;
    expect(lookupCount).toBe(3);
    for (const rid of rids) {
      expect(code).toContain(`_o := lookup(${rid})`);
    }
  });

  it('has balanced IF/ENDIF for each RID', () => {
    const code = generateBatchEnrichEc(['111', '222']);
    const errors = validateEcSyntax(code);
    expect(errors.filter(e => e.includes('mismatch'))).toHaveLength(0);
  });

  it('generates correct output format: rid|||bid|||type|||name|||tbid', () => {
    const code = generateBatchEnrichEc(['111']);
    const concatLine = code.split('\n').find(l => l.includes('_o.rid.whenMissing'));
    expect(concatLine).toBeDefined();
    // Count _d references (should be 4 separators for 5 fields)
    const dCount = (concatLine!.match(/_d/g) || []).length;
    expect(dCount).toBe(4);
  });

  it('returns empty for invalid RIDs', () => {
    expect(generateBatchEnrichEc([])).toBe('');
    expect(generateBatchEnrichEc(['abc', '', 'not-a-rid'])).toBe('');
  });
});

describe('resolveTemplate EC code generation', () => {
  it('generates valid EC with lookup ref', () => {
    const code = generateResolveTemplateEc('lookup(12345)');
    expect(code).toContain('_o := lookup(12345)');
    expect(code).toContain('_t := _o.linkedTo');
    expect(code).toContain('_t.id.whenMissing("")');
    expect(validateEcSyntax(code)).toHaveLength(0);
  });

  it('generates valid EC with namespace.bid ref', () => {
    const code = generateResolveTemplateEc('t.sc_risk');
    expect(code).toContain('_o := t.sc_risk');
    expect(validateEcSyntax(code)).toHaveLength(0);
  });
});

describe('Linked object EC code generation', () => {
  it('generates valid EC for InputSet', () => {
    const code = generateLinkedLookupEc('lookup(99999)', 'inputset');
    expect(code).toContain('_p := lookup(99999)');
    expect(code).toContain('_l := _p.inputset');
    expect(code).toContain('IF _l != MISSING THEN');
    expect(code).toContain('ELSE');
    expect(validateEcSyntax(code)).toHaveLength(0);
  });

  it('uses property access not method call', () => {
    const code = generateLinkedLookupEc('lookup(12345)', 'inputset');
    expect(code).toContain('_p.inputset');
    expect(code).not.toContain('_p.inputset()');
  });
});

describe('RID injection safety', () => {
  it('RID validation regex rejects injection attempts', () => {
    const ridRegex = /^-?\d+$/;
    expect(ridRegex.test('12345')).toBe(true);
    expect(ridRegex.test('-12345')).toBe(true);
    expect(ridRegex.test('12345); evil(); (')).toBe(false);
    expect(ridRegex.test('12345\n_x := evil()')).toBe(false);
    expect(ridRegex.test('')).toBe(false);
    expect(ridRegex.test('abc')).toBe(false);
  });
});
