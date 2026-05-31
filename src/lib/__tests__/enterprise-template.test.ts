/**
 * Tests for enterprise object template resolution.
 *
 * Enterprise objects (CeIssue, CeRiskAssessment, etc.) use .template
 * instead of .linkedTo. The resolveTemplate EC now tries .linkedTo first,
 * then falls back to .template.
 *
 * Verified against live BMP (Steadfast) on 2026-03-25:
 * - CeIssue with template → EnterpriseTemplate via .template ✓
 * - ExtendedTable → template via .linkedTo ✓
 * - CeIssue without template → MISSING ✓
 */
import { describe, it, expect } from 'vitest';

// ── Parser (mirrors bmp-client.ts resolveTemplate output parsing) ──

interface TemplateResolution {
  templateRid: string | null;
  templateName?: string;
  templateType?: string;
  templateBusinessId?: string;
}

function parseResolveTemplate(log: string | undefined | null, ok: boolean): TemplateResolution {
  if (!ok || !log) return { templateRid: null };
  const lines = log.trim().split('\n');
  const match = lines.find(l => l.includes('|||'))?.trim();
  if (!match || match.startsWith('MISSING')) return { templateRid: null };

  const parts = match.split('|||');
  const tRid = parts[0]?.trim();
  const tName = parts[1]?.trim();
  const tType = parts[2]?.trim();
  const tBid = parts[3]?.trim();
  if (!tRid || tRid === 'MISSING') return { templateRid: null };
  return {
    templateRid: tRid,
    templateName: tName || undefined,
    templateType: tType || undefined,
    templateBusinessId: tBid || undefined,
  };
}

// ── Tests ──

describe('Enterprise template resolution (linkedTo → .template fallback)', () => {
  it('resolves portal object via linkedTo (ExtendedTable)', () => {
    // EC output when .linkedTo returns the template directly
    const log = '4203202680316907033|||Modules|||ExtendedTable|||506773\nDuration : 26ms';
    const result = parseResolveTemplate(log, true);
    expect(result.templateRid).toBe('4203202680316907033');
    expect(result.templateName).toBe('Modules');
    expect(result.templateType).toBe('ExtendedTable');
    expect(result.templateBusinessId).toBe('506773');
  });

  it('resolves enterprise object via .template fallback (CeIssue)', () => {
    // EC output when .linkedTo is MISSING but .template returns EnterpriseTemplate
    const log = '5812262373885555143|||--->>Issue template - 1Step|||EnterpriseTemplate|||RDS_EntIssInv_template_OneStep\nDuration : 3ms';
    const result = parseResolveTemplate(log, true);
    expect(result.templateRid).toBe('5812262373885555143');
    expect(result.templateName).toBe('--->>Issue template - 1Step');
    expect(result.templateType).toBe('EnterpriseTemplate');
    expect(result.templateBusinessId).toBe('RDS_EntIssInv_template_OneStep');
  });

  it('returns null when both linkedTo and .template are MISSING', () => {
    // Enterprise object with no template (e.g., Gift registrations)
    const log = 'MISSING|||||||\nDuration : 1ms';
    const result = parseResolveTemplate(log, true);
    expect(result.templateRid).toBeNull();
  });

  it('returns null on EC failure', () => {
    const result = parseResolveTemplate(null, false);
    expect(result.templateRid).toBeNull();
  });

  it('returns null on empty log', () => {
    const result = parseResolveTemplate('', true);
    expect(result.templateRid).toBeNull();
  });

  it('handles enterprise template with all fields populated', () => {
    const log = '3090736750598064277|||Issue template - Default|||EnterpriseTemplate|||RDS_EntIssInv_template_default';
    const result = parseResolveTemplate(log, true);
    expect(result.templateRid).toBe('3090736750598064277');
    expect(result.templateName).toBe('Issue template - Default');
    expect(result.templateType).toBe('EnterpriseTemplate');
    expect(result.templateBusinessId).toBe('RDS_EntIssInv_template_default');
  });

  it('handles enterprise template with empty businessId', () => {
    const log = '3090736750598064277|||Issue template|||EnterpriseTemplate|||';
    const result = parseResolveTemplate(log, true);
    expect(result.templateRid).toBe('3090736750598064277');
    expect(result.templateName).toBe('Issue template');
    expect(result.templateType).toBe('EnterpriseTemplate');
    expect(result.templateBusinessId).toBeUndefined();
  });

  it('handles Result prefix in output', () => {
    const log = 'Result : 0\n5812262373885555143|||Template|||EnterpriseTemplate|||tmpl_1\nDuration : 3ms';
    const result = parseResolveTemplate(log, true);
    expect(result.templateRid).toBe('5812262373885555143');
    expect(result.templateBusinessId).toBe('tmpl_1');
  });
});

describe('batchEnrich template businessId for enterprise objects', () => {
  // The batch enrichment EC now includes the .template fallback:
  //   _t := _o.linkedTo
  //   IF _t = MISSING THEN _t := _o.template ENDIF
  //   _tid := IF _t != MISSING THEN _t.id.whenMissing("") ELSE "" ENDIF
  //
  // This means template businessId is available for both portal and enterprise objects.

  // Parser mirrors batchEnrich output (5-field: rid|||bid|||type|||name|||templateBid)
  function parseBatchLine(line: string) {
    const parts = line.split('|||').map(s => s.trim());
    return {
      rid: parts[0],
      businessId: parts[1] || undefined,
      type: parts[2] || undefined,
      name: parts[3] || undefined,
      templateBusinessId: parts[4] || undefined,
    };
  }

  it('portal object has template businessId via linkedTo', () => {
    const result = parseBatchLine('4203202680316907033|||506773|||ExtendedTable|||Modules|||506773_tmpl');
    expect(result.templateBusinessId).toBe('506773_tmpl');
  });

  it('enterprise object has template businessId via .template fallback', () => {
    const result = parseBatchLine('6930869287928975748|||GRC_GIS_001|||CeIssue|||Process Quality Control Deficiency|||RDS_EntIssInv_template_default');
    expect(result.templateBusinessId).toBe('RDS_EntIssInv_template_default');
  });

  it('enterprise object without template has empty templateBusinessId', () => {
    const result = parseBatchLine('1234567890|||GIFT_001|||CeIssue|||Gift Registration|||');
    expect(result.templateBusinessId).toBeUndefined();
  });
});
