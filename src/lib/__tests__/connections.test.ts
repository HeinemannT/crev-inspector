import { describe, it, expect } from 'vitest';
import {
  refFieldsFromSchema, buildConnectionsEc, parseConnections,
  buildJunctionEc, parseJunctions, pickFarSide,
  buildInboundEc, parseInbound,
  type SchemaProp, type RefField, type ConnTarget,
} from '../connections';
import { FLOW_SEP } from '../ec-codegen';

const prop = (accessor: string, configClass: string, label = ''): SchemaProp =>
  ({ accessor, configClass, label, systemobject: false });

describe('refFieldsFromSchema', () => {
  it('extracts forward and reverse refs, ignoring non-ref props', () => {
    const fields = refFieldsFromSchema([
      prop('mitigated_risk', 'ReferenceMethodConfig'),
      prop('risk_mitigations', 'ReverseReferenceMethodConfig'),
      prop('status', 'EnumMethodConfig'),
      prop('expression', 'ExpressionMethodConfig'),
      prop('last_reviewed', 'HistoricalReferenceMethodConfig'),
    ]);
    expect(fields.map(f => [f.accessor, f.direction])).toEqual([
      ['mitigated_risk', 'out'],
      ['risk_mitigations', 'in'],
      ['last_reviewed', 'out'],
    ]);
  });

  it('prefers the config label, falls back to a de-snaked accessor', () => {
    const fields = refFieldsFromSchema([
      prop('mitigating_control', 'ReferenceMethodConfig', 'Mitigating Control'),
      prop('risk_mitigations', 'ReverseReferenceMethodConfig'),
    ]);
    expect(fields[0].label).toBe('Mitigating Control');
    expect(fields[1].label).toBe('risk mitigations');
  });

  it('skips entries with no accessor', () => {
    expect(refFieldsFromSchema([prop('', 'ReferenceMethodConfig')])).toEqual([]);
  });
});

describe('buildConnectionsEc', () => {
  const fields: RefField[] = [
    { accessor: 'mitigated_risk', label: 'mitigated risk', direction: 'out' },
    { accessor: 'risk_mitigations', label: 'risk mitigations', direction: 'in' },
  ];

  it('reads every ref (forward + reverse) uniformly via forEach', () => {
    const ec = buildConnectionsEc('t.99', fields);
    expect(ec).toContain('_o := t.99');
    // both directions → forEach (verified live to handle single + multi)
    expect(ec).toContain('_o.mitigated_risk.forEach(_t:');
    expect(ec).toContain('_o.risk_mitigations.forEach(_t:');
    // no IF guard — EC's IF is an expression, not a statement
    expect(ec).not.toContain('IF ');
    // headers + terminator
    expect(ec).toContain('"f:mitigated_risk"');
    expect(ec).toContain('"f:risk_mitigations"');
    expect(ec).toContain('"DONE"');
    expect(ec).toContain(FLOW_SEP);
  });

  it('refuses to interpolate an unsafe accessor', () => {
    const ec = buildConnectionsEc('t.99', [
      { accessor: 'x := lookup(1)', label: 'bad', direction: 'out' },
      { accessor: 'good_ref', label: 'good', direction: 'out' },
    ]);
    expect(ec).not.toContain('lookup(1)');
    expect(ec).toContain('good_ref');
  });
});

describe('parseConnections', () => {
  const fields: RefField[] = [
    { accessor: 'mitigated_risk', label: 'mitigated risk', direction: 'out' },
    { accessor: 'mitigating_control', label: 'mitigating control', direction: 'out' },
    { accessor: 'risk_mitigations', label: 'risk mitigations', direction: 'in' },
  ];

  const log = [
    '', `f:mitigated_risk`, '\n111|ceras.7|Ransomware|CeRiskAssessment\n',
    `f:mitigating_control`, '\n',                                           // unset forward
    `f:risk_mitigations`, '\n201|cewf.1|Patch SMB|CeWorkflow\n202|cewf.2|Segment|CeWorkflow\n',
    'DONE', '',
  ].join(FLOW_SEP);

  it('maps fields to groups, preserving order + direction', () => {
    const groups = parseConnections(log, fields);
    expect(groups.map(g => [g.field, g.direction, g.targets.length])).toEqual([
      ['mitigated_risk', 'out', 1],
      ['mitigating_control', 'out', 0],
      ['risk_mitigations', 'in', 2],
    ]);
    expect(groups[0].targets[0]).toMatchObject({ rid: '111', name: 'Ransomware', type: 'CeRiskAssessment', businessId: 'ceras.7' });
    expect(groups[2].targets.map(t => t.name)).toEqual(['Patch SMB', 'Segment']);
  });

  it('flags a target that resolves to a rid but no identity as broken', () => {
    const brokenLog = ['', 'f:mitigated_risk', '\n999|||\n', 'DONE', ''].join(FLOW_SEP);
    const groups = parseConnections(brokenLog, [fields[0]]);
    expect(groups[0].targets[0]).toMatchObject({ rid: '999', broken: true });
  });

  it('returns empty groups for fields entirely absent from the log', () => {
    const groups = parseConnections('', fields);
    expect(groups.every(g => g.targets.length === 0)).toBe(true);
    expect(groups).toHaveLength(3);
  });
});

describe('junction inlining (C2)', () => {
  const fwd: RefField[] = [
    { accessor: 'mitigated_risk', label: 'mitigated risk', direction: 'out' },
    { accessor: 'mitigating_control', label: 'mitigating control', direction: 'out' },
  ];

  it('buildJunctionEc reads each junction\'s forward refs, guarding non-numeric rids', () => {
    const ec = buildJunctionEc(['201', 'bad;rid', '202'], fwd);
    expect(ec).toContain('_j := lookup(201)');
    expect(ec).toContain('_j := lookup(202)');
    expect(ec).not.toContain('bad;rid');
    expect(ec).toContain('"j:201"');
    expect(ec).toContain('_j.mitigating_control.forEach(_t:');
  });

  it('parseJunctions maps junction rid → forward-ref targets', () => {
    const log = [
      '', 'j:201', '\n111|loc_ddos|DDoS Risk|CeRiskAssessment\n301|cloc_waf|WAF|CeControlMeasure\n',
      'j:202', '\n111|loc_ddos|DDoS Risk|CeRiskAssessment\n',
    ].join(FLOW_SEP);
    const m = parseJunctions(log);
    expect(m.get('201')!.map(t => t.rid)).toEqual(['111', '301']);
    expect(m.get('202')!.map(t => t.rid)).toEqual(['111']);
  });

  it('pickFarSide returns the ref that is not the source (back-edge) nor the junction', () => {
    const fars: ConnTarget[] = [
      { rid: '111', name: 'DDoS Risk', type: 'CeRiskAssessment', businessId: 'loc_ddos' }, // back-edge (source)
      { rid: '301', name: 'WAF', type: 'CeControlMeasure', businessId: 'cloc_waf' },        // far side
    ];
    const far = pickFarSide('111', '201', fars);
    expect(far?.rid).toBe('301');
  });

  it('pickFarSide returns undefined when only the back-edge is present', () => {
    const fars: ConnTarget[] = [{ rid: '111', name: 'R', type: 'CeRiskAssessment', businessId: 'r' }];
    expect(pickFarSide('111', '201', fars)).toBeUndefined();
  });
});

describe('inbound scan (C3)', () => {
  it('buildInboundEc walks rref() emitting identity rows', () => {
    const ec = buildInboundEc('lookup(123)');
    expect(ec).toContain('_o := lookup(123)');
    expect(ec).toContain('_o.rref().forEach(_t:');
    expect(ec).toContain('_t.rid.whenMissing("")');
  });

  it('parseInbound parses referrer rows', () => {
    const log = '201|mit_ddos|DDoS mitigation|CeWorkflow\n402|issue_cap|Capacity issue|CeIssue\n';
    const { targets, capped } = parseInbound(log);
    expect(targets.map(t => t.type)).toEqual(['CeWorkflow', 'CeIssue']);
    expect(capped).toBe(false);
  });

  it('parseInbound caps and flags when over the limit', () => {
    const log = Array.from({ length: 5 }, (_, i) => `${i}|b${i}|n${i}|CeIssue`).join('\n');
    const { targets, capped } = parseInbound(log, 3);
    expect(targets).toHaveLength(3);
    expect(capped).toBe(true);
  });
});
