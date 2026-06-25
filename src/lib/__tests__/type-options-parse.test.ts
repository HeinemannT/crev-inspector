/**
 * parseOptionsLog — groups the FETCH_TYPE_OPTIONS EC output into per-property
 * option sets. Input shape is the live-verified CeRiskAssessment output:
 *   __prop__|||<accessor>|||list|tag
 *   __opt__|||<id>|||<name>   (repeated, belongs to the preceding __prop__)
 */
import { describe, it, expect } from 'vitest';
import { parseOptionsLog, buildOptionsEc } from '../handlers/objects';

describe('parseOptionsLog', () => {
  it('groups options under their property and maps ids to t.<id> refs', () => {
    const log = [
      '__prop__|||subtype|||list',
      '__opt__|||master|||Master',
      '__opt__|||instance|||Instance',
      '__prop__|||domain_tags|||tag',
      '__opt__|||tag_dom_sox|||SOX',
      '__opt__|||tag_dom_esg|||ESG',
    ].join('\n');
    expect(parseOptionsLog(log)).toEqual([
      { accessor: 'subtype', multi: false, items: [
        { ref: 't.master', name: 'Master' },
        { ref: 't.instance', name: 'Instance' },
      ] },
      { accessor: 'domain_tags', multi: true, items: [
        { ref: 't.tag_dom_sox', name: 'SOX' },
        { ref: 't.tag_dom_esg', name: 'ESG' },
      ] },
    ]);
  });

  it('marks tag properties multi and list properties single', () => {
    const log = '__prop__|||subtype|||list\n__opt__|||master|||Master\n__prop__|||tags|||tag\n__opt__|||a|||A';
    const sets = parseOptionsLog(log);
    expect(sets.find(s => s.accessor === 'subtype')!.multi).toBe(false);
    expect(sets.find(s => s.accessor === 'tags')!.multi).toBe(true);
  });

  it('drops properties that resolved to zero members', () => {
    const log = '__prop__|||empty|||list\n__prop__|||subtype|||list\n__opt__|||master|||Master';
    expect(parseOptionsLog(log).map(s => s.accessor)).toEqual(['subtype']);
  });

  it('ignores noise lines (Duration framing, blanks)', () => {
    const log = 'Duration : 76ms\n\n__prop__|||subtype|||list\n__opt__|||master|||Master\n[OK]';
    expect(parseOptionsLog(log)).toEqual([
      { accessor: 'subtype', multi: false, items: [{ ref: 't.master', name: 'Master' }] },
    ]);
  });

  it('returns [] for empty input', () => {
    expect(parseOptionsLog('')).toEqual([]);
  });
});

describe('buildOptionsEc', () => {
  it('embeds the class and branches on the property-config class', () => {
    const ec = buildOptionsEc('CeRiskAssessment');
    expect(ec).toContain('c.get(CeRiskAssessment.name)');
    expect(ec).toContain('ListMethodConfig');
    expect(ec).toContain('HistoricalListMethodConfig');
    expect(ec).toContain('TagMethodConfig');
    expect(ec).toContain('_k.listPropertySet');
    expect(ec).toContain('_k.tagList');
  });
});
