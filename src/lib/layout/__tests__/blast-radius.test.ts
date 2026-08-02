import { describe, it, expect } from 'vitest';
import {
  buildInstanceFanoutEc, parseInstanceFanout,
  buildContainerBlastEc, parseContainerBlast,
  buildFlowContainerBlastEc, parseFlowContainerBlast,
} from '../blast-radius';

const SEP = '<<<CREV_BLAST>>>';

describe('instance fan-out', () => {
  it('builds an rref(linkedTo) probe with a SELF row', () => {
    const ec = buildInstanceFanoutEc('t.crev_demo_complex');
    expect(ec).toContain('_p := t.crev_demo_complex');
    expect(ec).toContain('_p.rref(linkedTo).forEach');
    expect(ec).toContain('SELF|');
  });

  it('reads a master + its instances (own family = own rid when not linked)', () => {
    // verified shape: SELF|<rid>|<linkedTo>  then  INST|<rid>|<id>|<name>
    const log = `${SEP}SELF|6921|\n${SEP}INST|451|4957|CREV Demo — Enterprise Risk & Controls\n`;
    const f = parseInstanceFanout(log);
    expect(f.isMaster).toBe(true);
    expect(f.ownFamilyKey).toBe('6921');             // not linked → family is its own rid
    expect(f.instances).toEqual([{ rid: '451', businessId: '4957', name: 'CREV Demo — Enterprise Risk & Controls' }]);
  });

  it('an instance is not a master, and its family is its linkedTo (the master)', () => {
    const log = `${SEP}SELF|451|6921\n`; // page IS an instance, no one links to it
    const f = parseInstanceFanout(log);
    expect(f.isMaster).toBe(false);
    expect(f.ownFamilyKey).toBe('6921');             // family = the master it links to
    expect(f.instances).toEqual([]);
  });

  it('preserves a pipe in an instance name (name is the last field)', () => {
    const log = `${SEP}SELF|6921|\n${SEP}INST|451|4957|Revenue | 2024\n`;
    expect(parseInstanceFanout(log).instances[0].name).toBe('Revenue | 2024');
  });
});

describe('shared flow-container blast', () => {
  it('probes the correct reverse-reference property for each form container', () => {
    const ec = buildFlowContainerBlastEc([
      { id: 'risk_page', className: 'EditPage', ref: 't.risk_page' },
      { id: 'risk_inputs', className: 'InputSet', ref: 't.risk_inputs' },
    ]);
    expect(ec).toContain('_f0.rref(editPage).forEach');
    expect(ec).toContain('_f1.rref(inputSet).forEach');
  });

  it('reports only containers referenced by more than one view', () => {
    const log = [
      `${SEP}FLOW|risk_page|EditPage|100|cov_a|CreateObjectView|Create risk`,
      `${SEP}FLOW|risk_page|EditPage|101|cov_b|CreateObjectView|Edit risk`,
      `${SEP}FLOW|risk_inputs|InputSet|200|input_view|InputView|Risk inputs`,
    ].join('\n');
    expect(parseFlowContainerBlast(log)).toEqual({
      sharedContainers: 1,
      containers: [{
        id: 'risk_page',
        className: 'EditPage',
        usages: [
          {
            rid: '100',
            businessId: 'cov_a',
            className: 'CreateObjectView',
            name: 'Create risk',
          },
          {
            rid: '101',
            businessId: 'cov_b',
            className: 'CreateObjectView',
            name: 'Edit risk',
          },
        ],
      }],
    });
  });
});

describe('buildInstanceFanoutEc / buildContainerBlastEc (golden, plan 014)', () => {
  it('emits the exact SELF + INST row EC as before the ec-row-codec migration', () => {
    expect(buildInstanceFanoutEc('t.crev_demo_complex')).toBe([
      '_p := t.crev_demo_complex',
      `_r := "${SEP}SELF|" + _p.rid.whenMissing("") + "|" + _p.linkedTo.rid.whenMissing("") + "\\n"`,
      '_p.rref(linkedTo).forEach(_i:',
      `     _r := _r + "${SEP}INST|" + _i.rid.whenMissing("") + "|" + _i.id.whenMissing("") + "|" + (IF _i.name.whenMissing("") = "*<<<CREV_*" THEN "[reserved CREV marker]" ELSE _i.name.whenMissing("") ENDIF) + "\\n"`,
      ')',
      '_r',
    ].join('\n'));
  });

  it('emits the exact per-container scorecard row EC as before the migration', () => {
    expect(buildContainerBlastEc(['t.cont_a'])).toBe([
      '_r := ""',
      '_c0 := t.cont_a',
      '_c0.rref(container).forEach(_w:',
      '     _sc := _w.scorecard',
      `     _r := _r + "${SEP}" + _sc.rid.whenMissing("") + "|" + _sc.linkedTo.rid.whenMissing("") + "|" + (IF _sc.name.whenMissing("") = "*<<<CREV_*" THEN "[reserved CREV marker]" ELSE _sc.name.whenMissing("") ENDIF) + "\\n"`,
      ')',
      '_r',
    ].join('\n'));
  });
});

describe('shared-structure blast', () => {
  it('builds one rref(container) walk per touched container', () => {
    const ec = buildContainerBlastEc(['t.cont_a', 't.cont_b']);
    expect(ec).toContain('_c0 := t.cont_a');
    expect(ec).toContain('_c1 := t.cont_b');
    expect((ec.match(/rref\(container\)/g) || []).length).toBe(2);
    expect(ec).toContain('_sc := _w.scorecard');     // ModelAscender, not ancestor(Scorecard)
  });

  it('collapses a master + its instances into ONE family → no external blast', () => {
    // the demo case: container used by master 6921 and instance 451 (linkedTo 6921)
    const log =
      `${SEP}6921||CREV Demo\n` +
      `${SEP}6921||CREV Demo\n` +
      `${SEP}451|6921|CREV Demo\n` +
      `${SEP}451|6921|CREV Demo\n`;
    const blast = parseContainerBlast(log, '6921'); // page's own family is 6921
    expect(blast.otherFamilies).toBe(0);             // all within the page's own family
    expect(blast.families).toEqual([]);
  });

  it('counts a genuinely UNRELATED family as external blast', () => {
    const log =
      `${SEP}6921||CREV Demo\n` +        // own family (master)
      `${SEP}451|6921|CREV Demo\n` +     // own family (instance)
      `${SEP}999||Unrelated Scorecard\n`; // a different standalone page reusing the cell
    const blast = parseContainerBlast(log, '6921');
    expect(blast.otherFamilies).toBe(1);
    expect(blast.families[0]).toMatchObject({ rid: '999', name: 'Unrelated Scorecard', isMaster: true });
  });

  it('dedupes two instances of a SECOND template into one external family', () => {
    const log =
      `${SEP}500||Other Template\n` +     // a different master
      `${SEP}600|500|Other Inst A\n` +    // its instance
      `${SEP}700|500|Other Inst B\n`;     // its instance
    const blast = parseContainerBlast(log, '6921'); // page's own family is 6921 (not present here)
    expect(blast.otherFamilies).toBe(1);             // 500 + its instances = one family
    expect(blast.families[0]).toMatchObject({ rid: '500', isMaster: true });
  });

  it('does not parse an embedded blast marker in a name as another family', () => {
    const injected = `${SEP}999||Phantom`;
    const blast = parseContainerBlast(`${SEP}500||Real ${injected}\n`, '6921');
    expect(blast.families).toEqual([
      { rid: '500', name: `Real ${injected}`, isMaster: true },
    ]);
  });
});
