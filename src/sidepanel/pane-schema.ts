/**
 * Shared property schema for the object pane.
 *
 * Used by:
 * - src/sidepanel/detail-view.ts (side-panel surface)
 * - src/objectview/objectview.ts (full-view popout)
 *
 * Mixin → type sets are sourced from a live `bmp_type_fields` introspection
 * on this workspace. Re-introspect when BMP adds new widget types or mixin
 * coverage shifts. See the project research notes for the snapshot.
 *
 * One source of truth keeps the two surfaces from drifting — adding a new
 * editable prop here surfaces it in both UIs at once.
 */

import type { PANE_PROPS } from '../lib/bmp-client';
import { styleOptions } from '../lib/style-props';

export type EditorKind = 'color' | 'number' | 'enum' | 'boolean' | 'slider' | 'text' | 'string' | 'property';

export interface PropDef {
  prop: typeof PANE_PROPS[number];
  label: string;
  kind: EditorKind;
  /** Enum options where applicable. */
  options?: Array<{ value: string; label?: string }>;
  /** Unit suffix for number editors. */
  unit?: string;
  /** Slider/number bounds. `unit` (e.g. "%") appended to display value. */
  range?: { min: number; max: number; step?: number; unit?: string };
  /** Restrict which BMP types render this property. When omitted, the row is
   *  shown whenever the server has a value (or the user has a draft) — used
   *  for "appears on most things" props like width/height/colors. When set,
   *  the prop is hidden for unsupported types regardless of server value, so
   *  the UI stays type-honest. */
  availableOn?: ReadonlySet<string>;
  /** Render hint — "compact" packs the row into the dense grid (Display group); */
  compact?: boolean;
}

// "List widget" types — the BMP list/table/pivot widgets that all carry
// the same mixin surface as ExtendedTable (verified live via
// bmp_type_fields on IssueList, IndicatorList, RiskList, TaskList,
// RiskAssessmentTable, ProcessTable, BPMNModelTable — all 7 had
// ResponsiveWidth + HasToolsMenu + HasDisableSearch + WebChild +
// HasWidgetColors + Visibillity + ScreenSizeVisibility). Pulled out
// into its own set so every mixin set below can spread it in without
// drifting out of sync.
//
// Compatibility fallback for types exposing HasColumnWidths,
// minus the scorecard-tree nodes (StrategicObjective, Perspective)
// which are NOT widgets and live under a different mixin surface.
export const LIST_WIDGET_TYPES: ReadonlySet<string> = new Set([
  'ActionPlanTable', 'ActivityLogTable', 'AttachmentList', 'BPMNModelTable',
  'CheckList', 'ConsequenceList', 'ExtendedTable', 'ExternalResourcesView',
  'FilterTable', 'IncidentList', 'IndicatorList', 'IssueList',
  'ObjectApproval', 'PolicyAssetList', 'ProcessIncidentTable',
  'ProcessInstanceTable', 'ProcessStatisticsTable', 'ProcessTable',
  'RiskAssessmentTable', 'RiskEventList', 'RiskList', 'ScenarioTable',
  'StandardTable', 'TablePivot', 'TableView', 'TaskList', 'TreatmentList',
  'TreeTable', 'UserTaskInstanceTable', 'ViewCacheStatusTable',
]);

// Mixin → type sets (introspected via bmp_type_fields).
// Tab is included — its `columnsLargeScreen` default is 6 and the field is
// editable. Per skills/bmp-platform/layout.md, every layout-bearing object
// (Tab + Container + widgets) carries the responsive columns triplet.
// Chart widgets — all inherit WebChild + HasResponsiveWidth +
// HasToolsMenu + HasDisableSearch + HasWidgetColors via AbstractChart
// in BMP's class hierarchy, so they get spread into the same mixin
// sets as the list widgets below.
const CHART_WIDGET_TYPES: ReadonlySet<string> = new Set([
  'BarChart', 'PieChart', 'LineChart', 'AreaChart', 'WaterfallChart',
  'BubbleChart', 'RadarChart', 'TreeChart', 'GanttChart',
  'NetworkChart', 'PolarChart', 'BarLineChart',
]);

export const RESPONSIVE_WIDTH_TYPES: ReadonlySet<string> = new Set([
  'ActionButton', 'Container', 'CustomVisualization',
  'InputView', 'Tab', 'TextElement',
  ...LIST_WIDGET_TYPES,
  ...CHART_WIDGET_TYPES,
]);
export const HAS_TOOLS_MENU_TYPES: ReadonlySet<string> = new Set([
  'ActionButton', 'CustomVisualization', 'InputView',
  'ModelPage', 'Scorecard', 'TextElement',
  ...LIST_WIDGET_TYPES,
  ...CHART_WIDGET_TYPES,
]);
// disableSearch (HasDisableSearch) is a STRICT SUBSET of HasToolsMenu — verified against the
// 5.6.10 live type metadata (2026-07-06): 33 classes carry the tools menu but NOT disable-search,
// including the chart family (RiskChart/RiskRadarChart), several list widgets, CreateObjectView
// and DescriptionView. Derived as a difference so a type added to the tools set stays honest here.
const TOOLS_ONLY_TYPES: ReadonlySet<string> = new Set([
  'ActionPlanTable', 'AssessmentPlan', 'Attachment', 'AttachmentList', 'BowtieDiagram',
  'BPMNModel', 'BPMNModelTable', 'BPMNView', 'CreateObjectView', 'DescriptionView',
  'EnterpriseObject', 'EPMForm', 'FlowProject', 'Function', 'Incident', 'Issue', 'Kpi',
  'Milestone', 'Organisation', 'PolicyAssetList', 'RiskAssessmentTable', 'RiskChart',
  'RiskEventList', 'RiskFactor', 'RiskList', 'RiskRadarChart', 'Scenario', 'ScenarioTable',
  'StrategicObjective', 'Task', 'TopBarComponent', 'TreatmentList', 'TreeTable',
]);
export const HAS_DISABLE_SEARCH_TYPES: ReadonlySet<string> =
  new Set([...HAS_TOOLS_MENU_TYPES].filter(t => !TOOLS_ONLY_TYPES.has(t)));
// Appearance family — every type carrying the WebChild styling props
// (shadow / headerStyle / borderStyle / transparency) AND the
// HasWidgetColors colour links (headerColor / fontColor). The two mixins
// are reported on the same 103 types in the live type metadata, so one
// constant gates both. The fallback covers every type that exposes the
// WebChild `shadow` descriptor (minus the
// abstract WebChildReference wrapper).
//
// The live type schema (pane-schema-runtime) overrides this at render
// time, so this is only the FIRST-RENDER fallback — but it must mirror
// BMP's real coverage, else the styling/Appearance controls flash absent
// on the 57 types the old hand-curated `WebChild` set omitted (Dashboard,
// ImageView, URLView, Status, SimpleStatus, Perspective, StrategicObjective,
// Kpi, Indicator, CreateObjectView, StandardChart, BowtieDiagram, …).
export const APPEARANCE_TYPES: ReadonlySet<string> = new Set([
  ...LIST_WIDGET_TYPES,
  ...CHART_WIDGET_TYPES,
  // WebChild / HasWidgetColors types outside the list+chart subsets:
  'ActionButton', 'AnsweredReportFormEnrollment', 'Asset', 'BowtieDiagram',
  'BPMNView', 'BPMNViewOnUserTaskPage', 'ControlMeasure', 'CorrelationMatrix',
  'CreateObjectView', 'CustomVisualization', 'Dashboard', 'DatasetTableQueryView',
  'DataTable', 'DescriptionView', 'Enrollment', 'Enrollments',
  'EPMForm', 'FilteredComments', 'FormResponses', 'FunctionStatus',
  'HappyPathViewForProcessReference', 'HappyPathViewOnUserTaskPage', 'ImageView', 'Indicator',
  'InputView', 'Kpi', 'LinkMap', 'LocalComments',
  'Milestone', 'NodeInputTable', 'NotificationTable', 'ObjectClassification',
  'PdfView', 'Perspective', 'Policy', 'PowerBi',
  'Procedure', 'ProcessInstanceEnrollmentWidget', 'ProcessLandscapeView', 'ProcessLandscapeViewSection',
  'ReportFormEnrollment', 'ReportFormEnrollments', 'ReportForms', 'ReportsList',
  'RiskChart', 'RiskRadarChart', 'SearchBox', 'SelectionTable',
  'ShortcutList', 'SimpleStatus', 'SpreadsheetView', 'StandardChart',
  'Status', 'StrategicObjective', 'Task', 'TaskFormEnrollment',
  'TextElement', 'TreatmentActivity', 'URLView', 'UserTaskInstanceEnrollmentWidget',
  'UserTaskVariablesInputWidget',
]);
// HasVisibility (boolean `visible`) — covers all layout-bearing types
// PLUS Container. Drop-down menu items and Tab subtypes inherit via
// parent visibility, so they aren't in the field map.
export const HAS_VISIBLE_TYPES: ReadonlySet<string> = new Set([
  ...HAS_TOOLS_MENU_TYPES, 'Container',
]);
// shownOnLargeDisplay / Medium / Small — same coverage as HAS_VISIBLE_TYPES.
export const HAS_RESPONSIVE_VIS_TYPES: ReadonlySet<string> = HAS_VISIBLE_TYPES;

// HasColumnWidths mixin — every list/table widget PLUS the two
// scorecard-tree nodes that BMP also annotated with column widths
// (StrategicObjective, Perspective). Reuses LIST_WIDGET_TYPES so
// the two sets stay aligned automatically.
export const HAS_COLUMN_WIDTHS_TYPES: ReadonlySet<string> = new Set([
  ...LIST_WIDGET_TYPES,
  'StrategicObjective', 'Perspective',
]);
const EDIT_FIELD_TYPES: ReadonlySet<string> = new Set(['EditField']);
const LABEL_TYPES: ReadonlySet<string> = new Set(['Label']);

export const PROP_GROUPS: Array<{ title: string; props: PropDef[] }> = [
  {
    title: 'Layout',
    props: [
      { prop: 'width',  label: 'Width',  kind: 'number', unit: 'px' },
      { prop: 'height', label: 'Height', kind: 'number', unit: 'px' },
    ],
  },
  {
    // Compact 3-column "Display" group: responsive columns + display toggles
    // + styling. Conditional per type via availableOn. The columns triplet
    // renders as three side-by-side number boxes inside one row (see the
    // dedicated render path in the consumer).
    title: 'Display',
    props: [
      { prop: 'columnsLargeScreen',  label: 'L', kind: 'number', range: { min: 0, max: 6, step: 1 },
        availableOn: RESPONSIVE_WIDTH_TYPES, compact: true },
      { prop: 'columnsMediumScreen', label: 'M', kind: 'number', range: { min: 0, max: 6, step: 1 },
        availableOn: RESPONSIVE_WIDTH_TYPES, compact: true },
      { prop: 'columnsSmallScreen',  label: 'S', kind: 'number', range: { min: 0, max: 6, step: 1 },
        availableOn: RESPONSIVE_WIDTH_TYPES, compact: true },
      { prop: 'showToolMenu',  label: 'Tool menu',      kind: 'boolean', availableOn: HAS_TOOLS_MENU_TYPES },
      { prop: 'disableSearch', label: 'Disable search', kind: 'boolean', availableOn: HAS_DISABLE_SEARCH_TYPES },
      { prop: 'shadow',        label: 'Shadow',         kind: 'boolean', availableOn: APPEARANCE_TYPES },
      // Enum members come from the single style catalog (style-props) so this pane and the blueprint
      // Style toolbar can't drift on the values. Labels are the catalog's compact form.
      { prop: 'headerStyle',   label: 'Header style',   kind: 'enum',    availableOn: APPEARANCE_TYPES, options: [...styleOptions('headerStyle')] },
      { prop: 'borderStyle',   label: 'Border',         kind: 'enum',    availableOn: APPEARANCE_TYPES, options: [...styleOptions('borderStyle')] },
      { prop: 'transparency',  label: 'Transparency',   kind: 'slider',  availableOn: APPEARANCE_TYPES,
        range: { min: 0, max: 100, step: 1, unit: '%' } },
    ],
  },
  {
    // Appearance — colour LINKS (CorpoColor references, picked from the
    // colourset list, never typed). HasWidgetColors declares exactly two
    // accessors: `headerColor` and `fontColor`. There is NO `bgColor` on
    // any BMP widget (confirmed against the live type schema) — it was a
    // phantom prop and has been removed.
    // Gated to APPEARANCE_TYPES so the colour editors don't surface on
    // non-widget nodes (Organisation, plain Kpi/Node, …) in the
    // pre-schema fallback window.
    title: 'Appearance',
    props: [
      { prop: 'headerColor', label: 'Header', kind: 'color', availableOn: APPEARANCE_TYPES },
      { prop: 'fontColor',   label: 'Font',   kind: 'color', availableOn: APPEARANCE_TYPES },
    ],
  },
  {
    // Visibility — `visible` (BMP's HasVisibility boolean) + the responsive
    // breakpoint toggles. Replaces the old single "Hidden" toggle which was
    // mislabelled (BMP doesn't have a `hidden` prop; the user wants the
    // semantic `visible` field). `showExpression` / `enableExpression` carry
    // EC code and surface via the Flow / Code section rather than here.
    title: 'Visibility',
    props: [
      { prop: 'visible',             label: 'Visible',          kind: 'boolean', availableOn: HAS_VISIBLE_TYPES },
      { prop: 'shownOnLargeDisplay', label: 'Show on large',    kind: 'boolean', availableOn: HAS_RESPONSIVE_VIS_TYPES, compact: true },
      { prop: 'shownOnMediumDisplay', label: 'Show on medium',  kind: 'boolean', availableOn: HAS_RESPONSIVE_VIS_TYPES, compact: true },
      { prop: 'shownOnSmallDisplay', label: 'Show on small',    kind: 'boolean', availableOn: HAS_RESPONSIVE_VIS_TYPES, compact: true },
    ],
  },
  {
    title: 'Default',
    props: [
      { prop: 'textInputType', label: 'Text type', kind: 'enum', availableOn: LABEL_TYPES, options: [
        { value: 'SINGLELINE', label: 'Single line' },
        { value: 'MULTILINE', label: 'Multi-line' },
        { value: 'RICH', label: 'Rich text' },
      ] },
      { prop: 'advancedDefault', label: 'Advanced default', kind: 'boolean', availableOn: LABEL_TYPES },
    ],
  },
  {
    title: 'Field',
    props: [
      { prop: 'propertyMapping', label: 'Property', kind: 'property', availableOn: EDIT_FIELD_TYPES },
      { prop: 'required', label: 'Required', kind: 'boolean', availableOn: EDIT_FIELD_TYPES },
      { prop: 'placeholder', label: 'Placeholder', kind: 'string', availableOn: EDIT_FIELD_TYPES },
      { prop: 'propertyHint', label: 'Help text', kind: 'string', availableOn: EDIT_FIELD_TYPES },
    ],
  },
  {
    // Columns — read-only summary of the configured columnWidths object
    // for list/table widgets. Editing is structured (per-column map) and
    // deferred to a future iteration; surfacing the value here at least
    // lets users SEE what's set without round-tripping to BMP.
    title: 'Columns',
    props: [
      { prop: 'columnWidths', label: 'Column widths', kind: 'text', availableOn: HAS_COLUMN_WIDTHS_TYPES },
    ],
  },
];

/** Look up a PropDef by name across all groups. */
export function findPropDef(prop: string): PropDef | undefined {
  for (const g of PROP_GROUPS) {
    const d = g.props.find(p => p.prop === prop);
    if (d) return d;
  }
  return undefined;
}
