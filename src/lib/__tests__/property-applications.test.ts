import { describe, expect, it } from 'vitest';
import {
  PROPERTY_APPLICATION_END,
  PROPERTY_APPLICATION_ERROR,
  PROPERTY_APPLICATION_FIELD,
  PROPERTY_APPLICATION_MARK,
  PROPERTY_APPLICATION_TOTAL,
} from '../ec-codegen';
import { parsePropertyApplicationsLog, parsePropertyApplicationsResult } from '../ec-query-service';

function record(
  classId: string,
  rid: string,
  businessId: string,
  type: string,
  genedit: string,
): string {
  return [
    PROPERTY_APPLICATION_MARK,
    classId,
    PROPERTY_APPLICATION_FIELD,
    rid,
    PROPERTY_APPLICATION_FIELD,
    businessId,
    PROPERTY_APPLICATION_FIELD,
    type,
    PROPERTY_APPLICATION_FIELD,
    genedit,
  ].join('');
}

describe('parsePropertyApplicationsLog', () => {
  it('distinguishes inherited applications from explicit override deltas', () => {
    const log = [
      record('CeControlMeasure', '101', 'bucket_1_max', 'HistoricalNumberMethod',
        "k.CeControlMeasure.bucket_1_max.change(id := 'bucket_1_max')"),
      record('CeRiskAssessment', '102', 'bucket_1_max', 'HistoricalNumberMethod',
        "k.CeRiskAssessment.bucket_1_max.change(id := 'bucket_1_max', name := 'Risk ceiling', category := 'Risk')"),
      PROPERTY_APPLICATION_END,
    ].join('');

    expect(parsePropertyApplicationsLog(log)).toEqual([
      {
        classId: 'CeControlMeasure',
        application: {
          rid: '101',
          businessId: 'bucket_1_max',
          name: '',
          type: 'HistoricalNumberMethod',
        },
        overrides: {},
      },
      {
        classId: 'CeRiskAssessment',
        application: {
          rid: '102',
          businessId: 'bucket_1_max',
          name: '',
          type: 'HistoricalNumberMethod',
        },
        overrides: { name: "'Risk ceiling'", category: "'Risk'" },
      },
    ]);
  });

  it('keeps commas inside strings and nested EC calls intact', () => {
    const log = record(
      'CeRiskAssessment',
      '102',
      'calculated_risk',
      'ExtendedMethod',
      "k.CeRiskAssessment.calculated_risk.change(id := 'calculated_risk', expression := 'a, b', propertyHint := list('x', 'y'))",
    ) + PROPERTY_APPLICATION_END;

    expect(parsePropertyApplicationsLog(log)?.[0]?.overrides).toEqual({
      expression: "'a, b'",
      propertyHint: "list('x', 'y')",
    });
  });

  it('rejects a truncated response without the completion sentinel', () => {
    expect(parsePropertyApplicationsLog(record(
      'CeRiskAssessment',
      '102',
      'bucket_1_max',
      'HistoricalNumberMethod',
      "x.change(id := 'bucket_1_max')",
    ))).toBeNull();
  });

  it('rejects a reserved-marker collision reported by the emitter', () => {
    expect(parsePropertyApplicationsLog(
      PROPERTY_APPLICATION_ERROR + PROPERTY_APPLICATION_END,
    )).toBeNull();
  });

  it('rejects a malformed middle record instead of publishing partial counts', () => {
    const valid = record(
      'CeRiskAssessment',
      '102',
      'bucket_1_max',
      'HistoricalNumberMethod',
      "x.change(id := 'bucket_1_max')",
    );
    const malformed = PROPERTY_APPLICATION_MARK + 'CeService' + PROPERTY_APPLICATION_FIELD + '103';
    expect(parsePropertyApplicationsLog(valid + malformed + PROPERTY_APPLICATION_END)).toBeNull();
  });

  it('reports the authoritative total when the bounded result is truncated', () => {
    const log = PROPERTY_APPLICATION_TOTAL + '137' + record(
      'CeRiskAssessment',
      '102',
      'bucket_1_max',
      'HistoricalNumberMethod',
      "x.change(id := 'bucket_1_max')",
    ) + PROPERTY_APPLICATION_END;

    expect(parsePropertyApplicationsResult(log)).toMatchObject({
      total: 137,
      truncated: true,
      applications: [expect.objectContaining({ classId: 'CeRiskAssessment' })],
    });
  });
});
