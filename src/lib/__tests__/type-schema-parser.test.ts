import { describe, expect, it } from 'vitest';
import { parseSchemaPropsLog } from '../handlers/objects';

describe('type schema property identity', () => {
  it('keeps the master property RID and ID used by EditField property selection', () => {
    const parsed = parseSchemaPropsLog([
      '__canon__|||root.CeRiskAssessment',
      'name|||Risk title|||TextPropertyConfig|||false|||8123456789012345678|||ceRiskTitle|||TextMethodConfig',
    ].join('\n'));

    expect(parsed).toEqual({
      canonical: 'CeRiskAssessment',
      props: [{
        accessor: 'name',
        label: 'Risk title',
        configClass: 'TextPropertyConfig',
        systemobject: false,
        propertyRid: '8123456789012345678',
        propertyId: 'ceRiskTitle',
        propertyConfigClass: 'TextMethodConfig',
      }],
    });
  });

  it('accepts older four-column schema rows', () => {
    expect(parseSchemaPropsLog('name|||Name|||TextPropertyConfig|||true').props)
      .toEqual([{
        accessor: 'name',
        label: 'Name',
        configClass: 'TextPropertyConfig',
        systemobject: true,
      }]);
  });
});
