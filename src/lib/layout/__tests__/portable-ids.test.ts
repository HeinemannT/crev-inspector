import { describe, expect, it } from 'vitest';
import type { LModel, LNode, PlanStep } from '../types';
import { compile } from '../ec';
import {
  DEFAULT_PORTABLE_ID_PATTERN,
  SUPPORT_CATEGORY_KEY,
  VIRTUAL_TABSET_KEY,
  portableIdPatternError,
  portableIdRequests,
  portableIdSlug,
  buildPortableIdOccupancyEc,
  parseOccupiedPortableIds,
  preflightPortableIdRequests,
  renderPortableId,
  resolvePortableIdPlan,
} from '../portable-ids';

const node = (partial: Partial<LNode> & Pick<LNode, 'id' | 'kind' | 'className' | 'name'>): LNode => ({
  cols: { L: 6 },
  children: [],
  ...partial,
});

const model = (): LModel => ({
  pageId: '48021',
  pageName: 'Enterprise Risk',
  pageClass: 'ModelPage',
  tabsetId: 'new:tabset',
  tabsetVirtual: true,
  tabsetName: 'Risk tabs',
  target: 'template',
  hasTemplate: true,
  tabs: [
    node({
      id: 'new:tab',
      kind: 'tab',
      className: 'Tab',
      name: 'Risk overview',
      tabsetId: 'new:tabset',
      children: [
        node({
          id: 'new:container',
          kind: 'container',
          className: 'Container',
          name: 'Summary',
          children: [
            node({ id: 'new:widget', kind: 'widget', className: 'TextElement', name: 'Top risks' }),
          ],
        }),
      ],
    }),
  ],
});

describe('portable Blueprint IDs', () => {
  it('normalizes human text into a stable BMP business ID', () => {
    expect(portableIdSlug('  Größte Risiken & Maßnahmen  ')).toBe('grosste_risiken_and_massnahmen');
  });

  it('renders and validates text-tag patterns', () => {
    expect(renderPortableId('{page}_{class}_{name}', {
      page: 'Risk Register',
      parent: 'Overview',
      class: 'TextElement',
      name: 'Top 10',
    })).toBe('risk_register_textelement_top_10');
    expect(portableIdPatternError('{page}_{unknown}')).toBe('Unknown tag {unknown}.');
    expect(portableIdPatternError('fixed_only')).toBe('Add at least one text tag.');
  });

  it('covers implicit support objects and every staged layout object', () => {
    const current = model();
    const plan: PlanStep[] = [
      { kind: 'create', node: current.tabs[0], parentId: 'new:tabset', parentKind: 'tab' },
      { kind: 'create', node: current.tabs[0].children[0], parentId: 'new:tab', parentKind: 'tab' },
      { kind: 'create', node: current.tabs[0].children[0].children[0], parentId: 'new:container', parentKind: 'container' },
    ];

    const requests = portableIdRequests(plan, current, DEFAULT_PORTABLE_ID_PATTERN);

    expect(requests.map(request => request.key)).toEqual([
      SUPPORT_CATEGORY_KEY,
      VIRTUAL_TABSET_KEY,
      'new:tab',
      'new:container',
      'new:widget',
    ]);
    expect(requests.find(request => request.key === 'new:widget')?.base)
      .toBe('enterprise_risk_summary_textelement_top_risks');
  });

  it('suffixes live and same-batch collisions case-insensitively', () => {
    expect(resolvePortableIdPlan([
      { key: 'a', base: 'risk_tab' },
      { key: 'b', base: 'risk_tab' },
    ], ['RISK_TAB'])).toEqual({
      a: 'risk_tab_2',
      b: 'risk_tab_3',
    });
  });

  it('resolves live and same-batch collisions through batched read-only probes', async () => {
    const calls: string[] = [];
    const plan = await preflightPortableIdRequests({
      exec: async (code) => {
        calls.push(code);
        const occupied = code.includes('"risk_tab"')
          ? '<PORTABLE_ID>risk_tab|123\n'
          : '';
        return { ok: true, log: occupied };
      },
    }, [
      { key: 'a', base: 'risk_tab' },
      { key: 'b', base: 'risk_tab' },
    ]);

    expect(plan).toEqual({ a: 'risk_tab_2', b: 'risk_tab_3' });
    expect(calls).toHaveLength(3);
    expect(calls.every(code => !code.includes('.add(') && !code.includes('.change('))).toBe(true);
  });

  it('builds and parses a dynamic template-space collision probe', () => {
    const ec = buildPortableIdOccupancyEc(['risk_tab', 'risk_tab_2']);
    expect(ec).toContain('t.get(_id).rid.whenMissing("")');
    expect(ec).toContain('LIST("risk_tab", "risk_tab_2")');
    expect(parseOccupiedPortableIds([
      'Message : Result : <PORTABLE_ID>risk_tab|123',
      '<PORTABLE_ID>risk_tab_2|',
    ].join('\n'))).toEqual(new Set(['risk_tab']));
  });

  it('compiles portable IDs for implicit, layout, and flow creations', () => {
    const current = model();
    const plan: PlanStep[] = [
      { kind: 'create', node: current.tabs[0], parentId: 'new:tabset', parentKind: 'tab' },
      { kind: 'create', node: current.tabs[0].children[0], parentId: 'new:tab', parentKind: 'tab' },
      { kind: 'create', node: current.tabs[0].children[0].children[0], parentId: 'new:container', parentKind: 'container' },
      {
        kind: 'flowCreate',
        node: { id: 'new:field', className: 'TextInput', name: 'Risk title' },
        parentId: 'new:widget',
        parentClass: 'InputSet',
      },
    ];
    const portableIds = {
      [SUPPORT_CATEGORY_KEY]: 'enterprise_risk_portal_category_enterprise_risk',
      [VIRTUAL_TABSET_KEY]: 'enterprise_risk_enterprise_risk_tabset_risk_tabs',
      'new:tab': 'enterprise_risk_risk_tabs_tab_risk_overview',
      'new:container': 'enterprise_risk_risk_overview_container_summary',
      'new:widget': 'enterprise_risk_summary_textelement_top_risks',
      'new:field': 'enterprise_risk_top_risks_textinput_risk_title',
    };

    const { script } = compile(plan, current, portableIds);

    expect(script).toContain('root.portal.add(Category, id := "enterprise_risk_portal_category_enterprise_risk"');
    expect(script).toContain('.add(TabSet, id := "enterprise_risk_enterprise_risk_tabset_risk_tabs"');
    expect(script).toContain('.add(Tab, id := "enterprise_risk_risk_tabs_tab_risk_overview"');
    expect(script).toContain('.add(Container, id := "enterprise_risk_risk_overview_container_summary"');
    expect(script).toContain('_sc.add(TextElement, id := "enterprise_risk_summary_textelement_top_risks"');
    expect(script).toContain('_ff0 := _n2.add(TextInput, id := "enterprise_risk_top_risks_textinput_risk_title"');
  });
});
