// Type-color/abbreviation registry — extracted from types.ts (Plan 012) so it can be
// edited (adding a new widget-type color) without invalidating every message-contract
// consumer of the InspectorMessage union. Re-exported from './types' for back-compat.

/** Chart types — all share the same color. Charts are visualizations →
 *  warm/red family per the pill taxonomy below. */
export const CHART_TYPES = ['BarChart','PieChart','LineChart','AreaChart','WaterfallChart','BubbleChart','RadarChart','TreeChart','GanttChart','NetworkChart','PolarChart','BarLineChart','RiskChart','RiskRadarChart'] as const;
// Charts share one softer coral so they read as a family — and so the bold
// ExtendedTable red (#fa4d56) clearly stands out from them. Risk charts get
// their own deeper red below (they're a distinct beast from generic charts).
const CHART_COLOR = '#ff8a80'; // chart coral (lighter than table red)
const RISK_CHART_COLOR = '#ff7eb6'; // pink — risk charts (grouped with DashboardHTML)
const CHART_ABBREVIATIONS: Record<string, string> = {
  BarChart: 'BAR', PieChart: 'PIE', LineChart: 'LIN', AreaChart: 'ARA',
  WaterfallChart: 'WFC', BubbleChart: 'BUB', RadarChart: 'RDR', TreeChart: 'TRE',
  GanttChart: 'GNT', NetworkChart: 'NET', PolarChart: 'PLR', BarLineChart: 'BLC',
  // RiskChart / RiskRadarChart are HasExtendedExpression charts too — same viz
  // family, same `expression` code-prop. Explicit abbrs so they don't both
  // collapse to the "RIS" first-three fallback.
  RiskChart: 'RKC', RiskRadarChart: 'RRC',
};

/**
 * Pill colors — semantic taxonomy.
 *
 * The user should be able to read a page at a glance and tell what each
 * widget DOES from the pill color alone:
 *
 *   • Blue family     → interactable (user clicks/types: inputs, buttons)
 *   • Warm/red family → visualization (tables, charts, dashboards)
 *   • Green family    → structural/page (pages, scorecards, model)
 *   • Purple family   → logic / code-bearing (workflow, EC, expression)
 *   • Cool neutral    → content (text, labels — passive)
 *   • Domain palette  → preserved for Risk/Control/Action/Measure etc. since
 *                       those carry meaning beyond UI-role classification
 *   • #707070 grey    → unknown / not-yet-loaded (DEFAULT_TYPE_COLOR below)
 *
 * Keep families internally distinguishable (light/medium/dark per family) so
 * adjacent pills on a dense page don't read as one block of color.
 */
const TYPE_COLORS: Record<string, string> = {
  // ── Organisation — the only true green ────────────────────────
  Organisation: '#24a148',

  // ── Pages (page-green) ────────────────────────────────────────
  Scorecard: '#6fdc8c',
  ModelPage: '#6fdc8c',

  // ── Scorecard-tree / GRC objects — four yellow-orange pairs. For a
  // configurator these are functionally alike, so we DON'T over-distinguish
  // by hue: icon carries the object, colour just groups the band.
  Strategy:    '#f1c21b', Perspective: '#f1c21b', // amber pair
  Theme:       '#f5cd47', Objective:   '#f5cd47',  // gold group
  Measure:     '#f5cd47', Action:      '#f5cd47',  // gold group
  Risk:        '#e8890c', Control:     '#e8890c',  // orange pair
  Issue:       '#b28600', Indicator:   '#b28600',  // dark-gold pair

  // ── Input surfaces (blue A — object-creating shells) ──────────
  InputView:        '#1f8bff',
  CreateObjectView: '#1f8bff',
  // ── Input definitions (blue B — the linked set / page) ────────
  InputSet: '#4589ff',
  EditPage: '#4589ff',
  // ── Input fields + Label (light blue — live under an InputSet) ─
  TextInput:      '#78a9ff',
  NumberInput:    '#78a9ff',
  DateInput:      '#78a9ff',
  ChoiceInput:    '#78a9ff',
  BooleanInput:   '#78a9ff',
  ReferenceInput: '#78a9ff',
  ButtonInput:    '#78a9ff',
  Label:          '#78a9ff',
  // ── Action button — keeps its strong blue ─────────────────────
  ActionButton: '#0f62fe',

  // ── Layout structure (indigo family) ──────────────────────────
  Container: '#9aa3e8',
  TabSet:    '#5d6bc7',
  Tab:       '#7e8ce0',
  DashboardFolder: '#ff7eb6',

  // ── Tables — ExtendedTable bold red, the rest coral ───────────
  ExtendedTable:    '#fa4d56',
  FilterTable:      '#ff8389',
  ReportTable:      '#ff8389',
  FilteredComments: '#ff8389',

  // ── Visualization ─────────────────────────────────────────────
  CustomVisualization: '#fa4d56', // code-bearing → red, like ExtendedTable
  DashboardHTML:       '#ff7eb6',

  // ── Logic / code (purple family) ──────────────────────────────
  ExtendedCode:       '#be95ff',
  ExtendedExpression: '#d4bbff',
  ExtendedTransport:  '#9b7bff',
  Workflow:           '#a56eff',

  // ── Content ───────────────────────────────────────────────────
  TextElement: '#d2a373',

  // ── Status ────────────────────────────────────────────────────
  StatusType: '#8d8d8d', // grey

  // ── Expanded coverage — bands chosen to sit apart from the ones above ──
  // Scorecard-tree lists + objects (gold/orange, like the GRC objects)
  StrategicObjective: '#f5cd47', Kpi:      '#f5cd47', TaskList: '#f5cd47',
  CheckList:          '#f5cd47', Function: '#f5cd47',
  RiskList:           '#e8890c', IndicatorList: '#b28600',
  // Tables (coral, like FilterTable)
  ActionPlanTable: '#ff8389', RiskAssessmentTable: '#ff8389', ReportsList: '#ff8389',
  ProcessStatisticsTable: '#ff8389', UserTaskInstanceTable: '#ff8389', BPMNModelTable: '#ff8389',
  ProcessIncidentTable: '#ff8389', ProcessInstanceTable: '#ff8389', ProcessTable: '#ff8389',
  // Forms (cyan — a distinct data-entry band)
  ContinuousForm: '#1192e8', EPMForm: '#1192e8', PeriodicFormPage: '#1192e8',
  ScheduledForm: '#1192e8', ScheduledFormPage: '#1192e8',
  ScheduledFormDistributionList: '#1192e8', FormSchedule: '#1192e8',
  // Process / BPMN / flow (deep purple, distinct from the light code purples)
  BPMNView: '#6929c4', HappyPathViewForProcessReference: '#6929c4', RelationshipDiagram: '#6929c4',
  FlowProject: '#6929c4', FlowProjectGroup: '#6929c4', TransformerSchedule: '#6929c4', LogFolder: '#6929c4',
  // Status (grey, like StatusType)
  Status: '#8d8d8d', SimpleStatus: '#8d8d8d', FunctionStatus: '#8d8d8d',
  // Views / media (brown, like TextElement)
  DescriptionView: '#d2a373', ImageView: '#d2a373', PdfView: '#d2a373', Spacer: '#d2a373',
  // Templates / misc
  EnterpriseTemplate: '#6fdc8c',            // page-green — a template shell
  CustomVisualizationExpression: '#be95ff', // code purple, like ExtendedCode
  // Enterprise (Ce*) — shared teal family
  CeAsset: '#08bdba', CeIncident: '#08bdba', CeRiskAssessment: '#08bdba', CeControlMeasure: '#08bdba',
  CeIssue: '#08bdba', CeProcedure: '#08bdba', CeComplianceRequirement: '#08bdba', CeRegulation: '#08bdba',
  CeTIA: '#08bdba', CePreScreening: '#08bdba', CeWorkflow: '#08bdba', CeService: '#08bdba',
  CeQuestionnaire: '#08bdba', CeTask: '#08bdba', CeIndicator: '#08bdba', CeAssuranceActivity: '#08bdba',

  // ── Addable widget types (from the containment model) — reusing the bands above ──
  // Tables / lists (coral)
  ActivityLogTable: '#ff8389', DataTable: '#ff8389', DataTableView: '#ff8389',
  DatasetTableQueryView: '#ff8389', NodeInputTable: '#ff8389', StandardTable: '#ff8389',
  TablePivot: '#ff8389', TableView: '#ff8389', TreeTable: '#ff8389', ScenarioTable: '#ff8389',
  ViewCacheStatusTable: '#ff8389', IncidentList: '#ff8389', IssueList: '#ff8389',
  PolicyAssetList: '#ff8389', RiskEventList: '#ff8389', ShortcutList: '#ff8389',
  TreatmentList: '#ff8389', LocalComments: '#ff8389', AttachmentList: '#ff8389',
  // Forms / enrollments (cyan)
  AnsweredReportFormEnrollment: '#1192e8', Enrollment: '#1192e8', Enrollments: '#1192e8',
  FormResponses: '#1192e8', ReportFormEnrollment: '#1192e8', ReportFormEnrollments: '#1192e8',
  ReportForms: '#1192e8', TaskFormEnrollment: '#1192e8',
  // Views / media (brown, like TextElement)
  URLView: '#d2a373', ExternalResourcesView: '#d2a373', SpreadsheetView: '#d2a373',
  // Process / diagram (deep purple)
  ProcessLandscapeView: '#6929c4', LinkMap: '#6929c4', BowtieDiagram: '#6929c4',
  // Dashboards / BI (pink, like DashboardHTML)
  Dashboard: '#ff7eb6', PowerBi: '#ff7eb6',
  // Charts (chart coral)
  StandardChart: CHART_COLOR, Trend: CHART_COLOR,
  // Structural (indigo, like Container)
  ButtonContainer: '#9aa3e8', Section: '#9aa3e8', WebChildReference: '#9aa3e8',
  // Governance / metadata (grey)
  ObjectApproval: '#8d8d8d', ObjectClassification: '#8d8d8d',

  ...Object.fromEntries(CHART_TYPES.map(t => [t, CHART_COLOR])),
  // Risk charts override the generic chart coral with a deeper red so they
  // stand apart from the other charts at a glance.
  RiskChart: RISK_CHART_COLOR,
  RiskRadarChart: RISK_CHART_COLOR,
};

// All abbreviations normalised to 3 characters so pills render at uniform
// width — mixed 2/3-letter codes (IS vs TIN vs CVO) created a stepladder
// effect that was distracting on dense pages.
const TYPE_ABBREVIATIONS: Record<string, string> = {
  Organisation:        'ORG',
  Scorecard:           'SCD',
  ExtendedTable:       'TBL',
  FilterTable:         'FTB',
  FilteredComments:    'FCM',
  ReportTable:         'RTB',
  CustomVisualization: 'CVO',
  DashboardFolder:     'DSH',
  DashboardHTML:       'DHT',
  EditPage:            'EPG',
  ModelPage:           'MPG',
  Container:           'CON',
  TabSet:              'TBS',
  Tab:                 'TAB',
  StatusType:          'STA',
  Strategy:            'STR',
  Theme:               'THM',
  Perspective:         'PER',
  Objective:           'OBJ',
  Measure:             'MEA',
  Risk:                'RSK',
  Control:             'CTL',
  Action:              'ACT',
  Issue:               'ISS',
  Indicator:           'IND',
  InputView:           'INV',
  InputSet:            'INS',
  TextInput:           'TIN',
  NumberInput:         'NIN',
  DateInput:           'DIN',
  ChoiceInput:         'CIN',
  BooleanInput:        'BIN',
  ReferenceInput:      'REF',
  ButtonInput:         'BTN',
  CreateObjectView:    'COV',
  TextElement:         'TXT',
  Label:               'LBL',
  ActionButton:        'ACB',
  Workflow:            'WFL',
  ExtendedCode:        'XCO',
  ExtendedExpression:  'XPR',
  ExtendedTransport:   'XTR',
  // ── Expanded coverage (SOB/STS avoid the existing OBJ/STA codes) ──
  StrategicObjective: 'SOB', Kpi: 'KPI', TaskList: 'TSK', CheckList: 'CHK',
  RiskList: 'RKL', IndicatorList: 'INL', Function: 'FUN',
  ActionPlanTable: 'APT', RiskAssessmentTable: 'RAT', ReportsList: 'RPL',
  ProcessStatisticsTable: 'PST', UserTaskInstanceTable: 'UTI', BPMNModelTable: 'BMT',
  ProcessIncidentTable: 'PIT', ProcessInstanceTable: 'PIN', ProcessTable: 'PRC',
  ContinuousForm: 'CFM', EPMForm: 'FRM', PeriodicFormPage: 'PFP', ScheduledForm: 'SFM',
  ScheduledFormPage: 'SFP', ScheduledFormDistributionList: 'SFD', FormSchedule: 'FSC',
  BPMNView: 'BPM', HappyPathViewForProcessReference: 'HPP', RelationshipDiagram: 'RLD',
  FlowProject: 'FLP', FlowProjectGroup: 'FPG', TransformerSchedule: 'TRS', LogFolder: 'LOG',
  Status: 'STS', SimpleStatus: 'SST', FunctionStatus: 'FST',
  DescriptionView: 'DSV', ImageView: 'IMG', PdfView: 'PDF', Spacer: 'SPC',
  EnterpriseTemplate: 'ETP', CustomVisualizationExpression: 'CVE',
  CeAsset: 'AST', CeIncident: 'INC', CeRiskAssessment: 'RAS', CeControlMeasure: 'CTM',
  CeIssue: 'ISU', CeProcedure: 'PCD', CeComplianceRequirement: 'CMP', CeRegulation: 'REG',
  CeTIA: 'TIA', CePreScreening: 'PRS', CeWorkflow: 'WKF', CeService: 'SVC',
  CeQuestionnaire: 'QNR', CeTask: 'CTK', CeIndicator: 'CID', CeAssuranceActivity: 'ASA',
  // ── Addable widget types (from the containment model) ──
  ActivityLogTable: 'ATL', DataTable: 'DTB', DataTableView: 'DTV', DatasetTableQueryView: 'DQV',
  NodeInputTable: 'NIT', StandardTable: 'STB', TablePivot: 'TPV', TableView: 'TVW', TreeTable: 'TTB',
  ScenarioTable: 'SCT', ViewCacheStatusTable: 'VCT', IncidentList: 'ICL', IssueList: 'ISL',
  PolicyAssetList: 'PAL', RiskEventList: 'REL', ShortcutList: 'SCL', TreatmentList: 'TML',
  LocalComments: 'LCM', AttachmentList: 'ATT',
  AnsweredReportFormEnrollment: 'ARE', Enrollment: 'ENR', Enrollments: 'ENS', FormResponses: 'FRS',
  ReportFormEnrollment: 'RFE', ReportFormEnrollments: 'RFS', ReportForms: 'RPF', TaskFormEnrollment: 'TFE',
  URLView: 'URL', ExternalResourcesView: 'ERV', SpreadsheetView: 'SSV',
  ProcessLandscapeView: 'PLV', LinkMap: 'LKM', BowtieDiagram: 'BOW',
  Dashboard: 'DBD', PowerBi: 'PBI',
  StandardChart: 'SCH', Trend: 'TRN',
  ButtonContainer: 'BCN', Section: 'SEC', WebChildReference: 'WCR',
  ObjectApproval: 'APR', ObjectClassification: 'CLS',
  ...CHART_ABBREVIATIONS,
};

export const DEFAULT_TYPE_COLOR = '#8d8d8d'; // grey — unmapped / unknown type (pairs with the cube fallback badge)

export function getTypeColor(type?: string): string {
  if (!type) return DEFAULT_TYPE_COLOR;
  return TYPE_COLORS[type] ?? DEFAULT_TYPE_COLOR;
}

export function getTypeAbbr(type?: string): string {
  if (!type) return '?';
  return TYPE_ABBREVIATIONS[type] ?? type.substring(0, 3).toUpperCase();
}
