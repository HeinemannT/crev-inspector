/**
 * Real captured data — scorecard "CREV Demo — Enterprise Risk & Controls" (id 4957)
 * under Steadfast Demo org, pulled live via Extended Code on 2026-06-25.
 *
 * This is the raw, faithful shape the future extension would receive from a single
 * FETCH_LAYOUT_TREE round trip. The reconstruction engine (engine.js) turns it into
 * a renderable blueprint. Swap this array to test another page.
 *
 * Fields:
 *   id      - business id (rid in the real tool)
 *   type    - BMP className
 *   name    - display name
 *   kind    - 'tab' | 'container' | 'widget'  (derived; tabs/containers are portal-model, widgets org-model)
 *   parent  - for tab/container: the .parent id. for widget: its `container` binding id.
 *   L       - columnsLargeScreen (0..6), the width span. null when the type has none.
 *   sort    - sortIndex WITHIN its own model's sibling space (see note below).
 *
 * NOTE — two sort spaces:
 *   widget.sort  is the Scorecard's global child order (0..16).
 *   layout.sort  is the TabSet sibling order (per parent, restarts at 0).
 *   So a Tab that holds BOTH containers and directly-bound widgets has children from
 *   two different counters. How BMP interleaves them is the open question this
 *   prototype exists to pin down.
 */

export const TABSET = { id: 'crev_demo_tabset', name: 'CREV Demo Tabs' };

export const NODES = [
  // ---- Tabs (portal model, children of the TabSet) ----
  { id: '4895', type: 'Tab', name: 'Overview',      kind: 'tab', parent: 'crev_demo_tabset', L: 6, sort: 0 },
  { id: '4904', type: 'Tab', name: 'Risk Register', kind: 'tab', parent: 'crev_demo_tabset', L: 6, sort: 1 },
  { id: '4914', type: 'Tab', name: 'Controls',      kind: 'tab', parent: 'crev_demo_tabset', L: 6, sort: 2 },

  // ---- Containers (portal model) ----
  { id: 'cont_crev_demo_enterprise_4',  type: 'Container', name: 'Summary',         kind: 'container', parent: '4895', L: 2, sort: 0 },
  { id: 'cont_crev_demo_enterprise_7',  type: 'Container', name: 'Charts',          kind: 'container', parent: '4895', L: 4, sort: 1 },
  { id: 'cont_crev_demo_enterprise_14', type: 'Container', name: 'KPIs',            kind: 'container', parent: '4904', L: 2, sort: 0 },
  { id: 'cont_crev_demo_enterprise_18', type: 'Container', name: 'Side Panel',      kind: 'container', parent: '4904', L: 2, sort: 1 },
  { id: 'cont_crev_demo_enterprise_19', type: 'Container', name: 'Detail',          kind: 'container', parent: 'cont_crev_demo_enterprise_18', L: 6, sort: 0 },
  { id: 'cont_crev_demo_enterprise_23', type: 'Container', name: 'Control Library', kind: 'container', parent: '4914', L: 6, sort: 0 },

  // ---- Widgets (org model, parent = container binding) ----
  { id: '4958', type: 'DescriptionView', name: 'Exec Summary',    kind: 'widget', parent: 'cont_crev_demo_enterprise_4',  L: 6, sort: 0 },
  { id: '4959', type: 'SimpleStatus',    name: 'Overall Status',  kind: 'widget', parent: 'cont_crev_demo_enterprise_4',  L: 6, sort: 1 },
  { id: '4960', type: 'BarChart',        name: 'Losses by Cat',   kind: 'widget', parent: 'cont_crev_demo_enterprise_7',  L: 3, sort: 2 },
  { id: '4961', type: 'PieChart',        name: 'Exposure Split',  kind: 'widget', parent: 'cont_crev_demo_enterprise_7',  L: 3, sort: 3 },
  { id: '4962', type: 'ExtendedTable',   name: 'Top Risks',       kind: 'widget', parent: 'cont_crev_demo_enterprise_7',  L: 6, sort: 4 },
  { id: '4963', type: 'ExtendedTable',   name: 'Open Actions',    kind: 'widget', parent: '4895',                         L: 6, sort: 5 },
  { id: '4964', type: 'RiskList',        name: 'Register',        kind: 'widget', parent: '4904',                         L: 4, sort: 6 },
  { id: '4965', type: 'FunctionStatus',  name: 'Control Health',  kind: 'widget', parent: 'cont_crev_demo_enterprise_14', L: 6, sort: 7 },
  { id: '4966', type: 'Status',          name: 'Risk Appetite',   kind: 'widget', parent: 'cont_crev_demo_enterprise_14', L: 6, sort: 8 },
  { id: '4967', type: 'BarLineChart',    name: 'Trend vs Target', kind: 'widget', parent: '4904',                         L: 4, sort: 9 },
  { id: '4968', type: 'PieChart',        name: 'By Owner',        kind: 'widget', parent: 'cont_crev_demo_enterprise_19', L: 6, sort: 10 },
  { id: '4969', type: 'TextElement',     name: 'Notes',           kind: 'widget', parent: 'cont_crev_demo_enterprise_19', L: 6, sort: 11 },
  { id: '4970', type: 'DescriptionView', name: 'Scope',           kind: 'widget', parent: 'cont_crev_demo_enterprise_23', L: 2, sort: 12 },
  { id: '4971', type: 'InputView',       name: 'Owner Input',     kind: 'widget', parent: 'cont_crev_demo_enterprise_23', L: 4, sort: 13 },
  { id: '4972', type: 'ExtendedTable',   name: 'Controls',        kind: 'widget', parent: 'cont_crev_demo_enterprise_23', L: 6, sort: 14 },
  { id: '4973', type: 'ActionButton',    name: 'Run Test',        kind: 'widget', parent: '4914',                         L: 2, sort: 15 },
  { id: '4974', type: 'CheckList',       name: 'Checklist',       kind: 'widget', parent: '4914',                         L: 4, sort: 16 },
];
