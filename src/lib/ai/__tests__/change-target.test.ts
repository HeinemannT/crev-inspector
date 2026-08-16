import { describe, expect, it } from 'vitest';
import {
  parseChangeTargetRecords,
  resolveChangeTarget,
  type ChangeTargetIdentity,
  type ChangeTargetPageFacts,
} from '../change-target';

describe('parseChangeTargetRecords', () => {
  it('extracts only complete machine-readable target records', () => {
    expect(parseChangeTargetRecords([
      'Default page-owner target: target=[[object:111]] mutationRef=t.landing_template scope=shared-template impact=all-linked-instances',
      'Target mention without routing: target=[[object:222]]',
      'change-target: target=[[object:333]] mutationRef=_page scope=direct-page reason=direct-page-owner',
    ].join('\n'))).toEqual([
      { rid: '111', mutationRef: 't.landing_template', scope: 'shared-template' },
      { rid: '333', mutationRef: '_page', scope: 'direct-page' },
    ]);
  });
});

const ref = (rid: string, businessId: string, type = 'Scorecard'): ChangeTargetIdentity => ({
  rid,
  businessId,
  type,
  ecRef: `t.${businessId}`,
});

const linkedPage: ChangeTargetPageFacts = {
  viewed: ref('222', 'page_118'),
  owner: ref('222', 'page_118'),
  linkedTemplate: ref('111', 'landing_template'),
};

describe('resolveChangeTarget', () => {
  it('covers the page-family and subject routing matrix', () => {
    const enterprise: ChangeTargetPageFacts = {
      viewed: ref('444', '444', 'CeRisk'),
      owner: ref('333', 'risk_template', 'EnterpriseTemplate'),
    };
    const direct: ChangeTargetPageFacts = {
      viewed: ref('555', 'direct_page'),
      owner: ref('555', 'direct_page'),
    };
    const inherited = ref('919', '119', 'ExtendedTable');
    const master = ref('818', 'navigation_table', 'ExtendedTable');
    const local = ref('717', 'local_note', 'TextElement');
    const container = ref('616', 'main_container', 'Container');

    const cases = [
      {
        name: 'linked page defaults to shared template',
        actual: resolveChangeTarget({ kind: 'page', page: linkedPage }),
        expected: ['resolved', 'landing_template', 'shared-template', 'linked-page-default'],
      },
      {
        name: 'linked page honors explicit instance-only scope',
        actual: resolveChangeTarget({ kind: 'page', page: linkedPage }, 'instance-only'),
        expected: ['resolved', 'page_118', 'instance-only', 'explicit-instance-override'],
      },
      {
        name: 'inherited widget defaults to exact master widget',
        actual: resolveChangeTarget({ kind: 'widget', page: linkedPage, instance: inherited, linkedTemplate: master }),
        expected: ['resolved', 'navigation_table', 'shared-template', 'inherited-widget-default'],
      },
      {
        name: 'inherited widget honors explicit local override',
        actual: resolveChangeTarget({ kind: 'widget', page: linkedPage, instance: inherited, linkedTemplate: master }, 'instance-only'),
        expected: ['resolved', '119', 'instance-only', 'explicit-instance-override'],
      },
      {
        name: 'unlinked widget on linked page remains local',
        actual: resolveChangeTarget({ kind: 'widget', page: linkedPage, instance: local }),
        expected: ['resolved', 'local_note', 'instance-only', 'local-widget-only'],
      },
      {
        name: 'enterprise instance routes to EnterpriseTemplate owner',
        actual: resolveChangeTarget({ kind: 'page', page: enterprise }),
        expected: ['resolved', 'risk_template', 'enterprise-template', 'enterprise-template-owner'],
      },
      {
        name: 'standalone page routes directly',
        actual: resolveChangeTarget({ kind: 'page', page: direct }),
        expected: ['resolved', 'direct_page', 'direct-page', 'direct-page-owner'],
      },
      {
        name: 'portal structure remains shared regardless of viewed page',
        actual: resolveChangeTarget({ kind: 'portal-structure', page: linkedPage, object: container }),
        expected: ['resolved', 'main_container', 'shared-portal', 'portal-structure-is-shared'],
      },
    ];

    for (const test of cases) {
      expect(test.actual.status, test.name).toBe(test.expected[0]);
      if (test.actual.status !== 'resolved') continue;
      expect(test.actual.target.businessId, test.name).toBe(test.expected[1]);
      expect(test.actual.scope, test.name).toBe(test.expected[2]);
      expect(test.actual.reason, test.name).toBe(test.expected[3]);
    }
  });

  it('returns explicit unavailable results instead of inventing unsupported scopes', () => {
    const enterprise: ChangeTargetPageFacts = {
      viewed: ref('444', '444', 'CeRisk'),
      owner: ref('333', 'risk_template', 'EnterpriseTemplate'),
    };
    expect(resolveChangeTarget({ kind: 'page', page: enterprise }, 'instance-only')).toMatchObject({
      status: 'unavailable',
      reason: 'enterprise-instance-cannot-own-widgets',
    });
    expect(resolveChangeTarget({ kind: 'portal-structure', page: linkedPage, object: ref('616', 'container', 'Container') }, 'instance-only')).toMatchObject({
      status: 'unavailable',
      reason: 'portal-structure-has-no-instance-scope',
    });
    expect(resolveChangeTarget({ kind: 'widget', page: linkedPage, instance: ref('717', 'local_note') }, 'shared-template')).toMatchObject({
      status: 'unavailable',
      reason: 'shared-template-unavailable',
    });
  });
});
