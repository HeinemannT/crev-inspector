/**
 * Type badge — the signature "full-bleed stub": a domain-coloured tile (icon,
 * white) welded to a neutral code chip (the 3-letter abbreviation). The icon
 * carries the object's role; the tile colour carries its domain band. Colour
 * lives on the tile ONLY, so a wall of badges reads as a colour-keyed column
 * without shouting.
 *
 * Shared across Browse rows, the object tree, the object header, the inspect
 * overlay, and the EC window so every surface labels a type identically.
 *
 * Sub-badges (opts.sub) stack UNDERNEATH the stub — a violet `</>` when the
 * object carries Extended Code, a teal link when it references other objects
 * (its jump target). Used on the inspect corner label + detail header.
 */
import { h, svg } from './dom';
import {
  ICON_BUILDINGS, ICON_BROWSER, ICON_COMPASS, ICON_EYE_OPEN, ICON_STACK,
  ICON_CROSSHAIR, ICON_GAUGE, ICON_LIGHTNING, ICON_WARNING, ICON_SHIELD,
  ICON_WARNING_CIRCLE, ICON_CHART_LINE_UP, ICON_TRAY, ICON_CARDHOLDER,
  ICON_TRAY_ARROW_DOWN, ICON_CARDS_THREE, ICON_PENCIL, ICON_VARIABLE,
  ICON_CLOCK, ICON_LIST, ICON_CHECK, ICON_PLAY, ICON_BOOK, ICON_CONTAINER,
  ICON_TABS, ICON_FOLDER, ICON_TABLE, ICON_FILE_JS, ICON_FILE_HTML,
  ICON_CHART, ICON_CODE, ICON_SWAP, ICON_CUBE, ICON_LINK,
  ICON_FLOW_ARROW, ICON_LAYOUT, ICON_DOTS_THREE_V, ICON_TREE_STRUCTURE,
  ICON_NOTE_PENCIL, ICON_CIRCLE, ICON_ARTICLE, ICON_IMAGE, ICON_FILE_PDF,
  ICON_BOULES, ICON_SQUARES_FOUR, ICON_GRID_NINE, ICON_GLOBE, ICON_PAPERCLIP,
  ICON_CHECK_CIRCLE,
  ICON_PROP_SYSTEM, ICON_PROP_TEXT, ICON_PROP_RICH_TEXT, ICON_PROP_BOOLEAN,
  ICON_PROP_NUMBER, ICON_PROP_DATE, ICON_PROP_URL, ICON_PROP_LIST, ICON_PROP_TAG,
  ICON_PROP_REFERENCE, ICON_PROP_REVERSE_REFERENCE, ICON_PROP_EXTENDED,
  ICON_PROP_FILE, ICON_PROP_TOKEN, ICON_PROP_FUNCTION, ICON_PROP_NODE_FUNCTION,
  ICON_PROP_PROGRESS, ICON_PROP_STATUS, ICON_PROP_HISTORY,
} from './icons';
import { getTypeAbbr, getTypeColor, CHART_TYPES } from './types';
import { isHistoricalPropertyConfigClass, isPropertyConfigClass } from './property-config';

/** BMP type → its role glyph. Colour comes from getTypeColor (the domain band);
 *  this map is only the icon. Anything absent falls back to the cube. */
const TYPE_ICON: Record<string, string> = {
  // Organisation + pages
  Organisation: ICON_BUILDINGS,
  Scorecard: ICON_BROWSER,
  ModelPage: ICON_BROWSER,
  // GRC / scorecard-tree objects
  Strategy: ICON_COMPASS,
  Perspective: ICON_EYE_OPEN,
  Theme: ICON_STACK,
  Objective: ICON_CROSSHAIR,
  Measure: ICON_GAUGE,
  Action: ICON_LIGHTNING,
  Risk: ICON_WARNING,
  Control: ICON_SHIELD,
  Issue: ICON_WARNING_CIRCLE,
  Indicator: ICON_CHART_LINE_UP,
  // Input surfaces — the tray/card pairs
  InputView: ICON_TRAY,
  CreateObjectView: ICON_CARDHOLDER,
  InputSet: ICON_TRAY_ARROW_DOWN,
  EditPage: ICON_CARDS_THREE,
  // Input fields
  TextInput: ICON_PENCIL,
  NumberInput: ICON_VARIABLE,
  DateInput: ICON_CLOCK,
  ChoiceInput: ICON_LIST,
  BooleanInput: ICON_CHECK,
  ReferenceInput: ICON_LIST,
  ButtonInput: ICON_PLAY,
  Label: ICON_BOOK,
  ListInput: ICON_LIST,
  ActionButton: ICON_LIGHTNING,
  // Flow-chain elements (blueprint flow editing) — EditPage/InputSet children
  EditField: ICON_PENCIL,
  EditPageInfo: ICON_BOOK,
  EditPageButton: ICON_PLAY,
  ButtonGroup: ICON_SQUARES_FOUR,
  Validation: ICON_CHECK,
  EditPageValidation: ICON_CHECK,
  EditPageBreak: ICON_DOTS_THREE_V,
  EditPageColumnBreak: ICON_DOTS_THREE_V,
  // Layout structure
  Container: ICON_CONTAINER,
  TabSet: ICON_TABS,
  Tab: ICON_TABS,
  DashboardFolder: ICON_FOLDER,
  // Tables
  ExtendedTable: ICON_TABLE,
  FilterTable: ICON_TABLE,
  ReportTable: ICON_TABLE,
  FilteredComments: ICON_TABLE,
  // Visualization
  CustomVisualization: ICON_FILE_JS,
  DashboardHTML: ICON_FILE_HTML,
  RiskChart: ICON_GRID_NINE, // risk matrix — its own glyph, not the generic chart
  RiskRadarChart: ICON_CHART,
  // Logic / code
  ExtendedCode: ICON_CODE,
  ExtendedExpression: ICON_VARIABLE,
  ExtendedTransport: ICON_SWAP,
  Workflow: ICON_SWAP,
  // Content + status
  TextElement: ICON_BOOK,
  StatusType: ICON_CHECK,

  // Property objects — Phosphor Fill glyphs. Historical variants reuse the
  // base value-kind glyph and receive the shared ClockCountdown seam mark in
  // typeBadge(); this preserves both type identity and temporal state.
  SystemMethodConfig: ICON_PROP_SYSTEM,
  TextMethodConfig: ICON_PROP_TEXT,
  HistoricalTextMethodConfig: ICON_PROP_TEXT,
  RichTextMethodConfig: ICON_PROP_RICH_TEXT,
  HistoricalRichTextMethodConfig: ICON_PROP_RICH_TEXT,
  BooleanMethodConfig: ICON_PROP_BOOLEAN,
  HistoricalBooleanMethodConfig: ICON_PROP_BOOLEAN,
  NumberMethodConfig: ICON_PROP_NUMBER,
  HistoricalNumberMethodConfig: ICON_PROP_NUMBER,
  DateMethodConfig: ICON_PROP_DATE,
  HistoricalDateMethodConfig: ICON_PROP_DATE,
  UrlMethodConfig: ICON_PROP_URL,
  ListMethodConfig: ICON_PROP_LIST,
  HistoricalListMethodConfig: ICON_PROP_LIST,
  TagMethodConfig: ICON_PROP_TAG,
  ReferenceMethodConfig: ICON_PROP_REFERENCE,
  HistoricalReferenceMethodConfig: ICON_PROP_REFERENCE,
  ReverseReferenceMethodConfig: ICON_PROP_REVERSE_REFERENCE,
  ExtendedMethodConfig: ICON_PROP_EXTENDED,
  FileMethodConfig: ICON_PROP_FILE,
  TokenMethodConfig: ICON_PROP_TOKEN,
  FunctionMethodConfig: ICON_PROP_FUNCTION,
  NodeTypeFunctionMethodConfig: ICON_PROP_NODE_FUNCTION,
  HistoricalProgressMethodConfig: ICON_PROP_PROGRESS,
  HistoricalStatusMethodConfig: ICON_PROP_STATUS,

  // ── Expanded coverage — colours come from getTypeColor (the domain band);
  //    one glyph per group (Views + EnterpriseTemplate get individual ones). ──
  // Scorecard-tree nodes (lists + StrategicObjective/Kpi/Function) → tree glyph
  StrategicObjective: ICON_TREE_STRUCTURE,
  Kpi:                ICON_TREE_STRUCTURE,
  TaskList:           ICON_TREE_STRUCTURE,
  CheckList:          ICON_TREE_STRUCTURE,
  RiskList:           ICON_TREE_STRUCTURE,
  IndicatorList:      ICON_TREE_STRUCTURE,
  Function:           ICON_TREE_STRUCTURE,
  // Tables
  ActionPlanTable:        ICON_TABLE,
  RiskAssessmentTable:    ICON_TABLE,
  ReportsList:            ICON_TABLE,
  ProcessStatisticsTable: ICON_TABLE,
  UserTaskInstanceTable:  ICON_TABLE,
  BPMNModelTable:         ICON_TABLE,
  ProcessIncidentTable:   ICON_TABLE,
  ProcessInstanceTable:   ICON_TABLE,
  ProcessTable:           ICON_TABLE,
  // Forms → note-pencil
  ContinuousForm:                ICON_NOTE_PENCIL,
  EPMForm:                       ICON_NOTE_PENCIL,
  PeriodicFormPage:              ICON_NOTE_PENCIL,
  ScheduledForm:                 ICON_NOTE_PENCIL,
  ScheduledFormPage:             ICON_NOTE_PENCIL,
  ScheduledFormDistributionList: ICON_NOTE_PENCIL,
  FormSchedule:                  ICON_NOTE_PENCIL,
  // Process / BPMN / flow → flow-arrow
  BPMNView:                         ICON_FLOW_ARROW,
  HappyPathViewForProcessReference: ICON_FLOW_ARROW,
  RelationshipDiagram:              ICON_FLOW_ARROW,
  FlowProject:                      ICON_FLOW_ARROW,
  FlowProjectGroup:                 ICON_FLOW_ARROW,
  TransformerSchedule:              ICON_FLOW_ARROW,
  LogFolder:                        ICON_FLOW_ARROW,
  // Status → circle
  Status:         ICON_CIRCLE,
  SimpleStatus:   ICON_CIRCLE,
  FunctionStatus: ICON_CIRCLE,
  // Views / media — individual glyphs; Spacer is a layout filler → dots
  DescriptionView: ICON_ARTICLE,
  ImageView:       ICON_IMAGE,
  PdfView:         ICON_FILE_PDF,
  Spacer:          ICON_DOTS_THREE_V,
  // Templates / misc
  EnterpriseTemplate:            ICON_LAYOUT,
  CustomVisualizationExpression: ICON_CODE,
  // Enterprise (Ce*) → boules
  CeAsset:                 ICON_BOULES,
  CeIncident:              ICON_BOULES,
  CeRiskAssessment:        ICON_BOULES,
  CeControlMeasure:        ICON_BOULES,
  CeIssue:                 ICON_BOULES,
  CeProcedure:             ICON_BOULES,
  CeComplianceRequirement: ICON_BOULES,
  CeRegulation:            ICON_BOULES,
  CeTIA:                   ICON_BOULES,
  CePreScreening:          ICON_BOULES,
  CeWorkflow:              ICON_BOULES,
  CeService:               ICON_BOULES,
  CeQuestionnaire:         ICON_BOULES,
  CeTask:                  ICON_BOULES,
  CeIndicator:             ICON_BOULES,
  CeAssuranceActivity:     ICON_BOULES,

  // ── Addable widget types (from the containment model) — one glyph per group ──
  // Tables / lists → table (AttachmentList gets the paperclip)
  ActivityLogTable: ICON_TABLE, DataTable: ICON_TABLE, DataTableView: ICON_TABLE,
  DatasetTableQueryView: ICON_TABLE, NodeInputTable: ICON_TABLE, StandardTable: ICON_TABLE,
  TablePivot: ICON_TABLE, TableView: ICON_TABLE, TreeTable: ICON_TABLE, ScenarioTable: ICON_TABLE,
  ViewCacheStatusTable: ICON_TABLE, IncidentList: ICON_TABLE, IssueList: ICON_TABLE,
  PolicyAssetList: ICON_TABLE, RiskEventList: ICON_TABLE, ShortcutList: ICON_TABLE,
  TreatmentList: ICON_TABLE, LocalComments: ICON_TABLE, AttachmentList: ICON_PAPERCLIP,
  // Forms / enrollments → note-pencil
  AnsweredReportFormEnrollment: ICON_NOTE_PENCIL, Enrollment: ICON_NOTE_PENCIL,
  Enrollments: ICON_NOTE_PENCIL, FormResponses: ICON_NOTE_PENCIL, ReportFormEnrollment: ICON_NOTE_PENCIL,
  ReportFormEnrollments: ICON_NOTE_PENCIL, ReportForms: ICON_NOTE_PENCIL, TaskFormEnrollment: ICON_NOTE_PENCIL,
  // Views / media
  URLView: ICON_GLOBE, ExternalResourcesView: ICON_FOLDER, SpreadsheetView: ICON_TABLE,
  // Process / diagram → flow-arrow
  ProcessLandscapeView: ICON_FLOW_ARROW, LinkMap: ICON_FLOW_ARROW, BowtieDiagram: ICON_FLOW_ARROW,
  // Dashboards / BI → dashboard grid
  Dashboard: ICON_SQUARES_FOUR, PowerBi: ICON_SQUARES_FOUR,
  // Charts
  StandardChart: ICON_CHART, Trend: ICON_CHART_LINE_UP,
  // Structural → container (WebChildReference is a reference → link)
  ButtonContainer: ICON_CONTAINER, Section: ICON_CONTAINER, WebChildReference: ICON_LINK,
  // Governance / metadata
  ObjectApproval: ICON_CHECK_CIRCLE, ObjectClassification: ICON_LIST,
};

const CHART_SET = new Set<string>(CHART_TYPES);

/** Resolve a type to its badge glyph. Charts (Bar/Pie/…) → the bar-chart icon;
 *  everything unmapped → the generic cube. */
export function typeIcon(type?: string): string {
  if (!type) return ICON_CUBE;
  return TYPE_ICON[type] ?? (CHART_SET.has(type) ? ICON_CHART : ICON_CUBE);
}

/** True when we have a real mapping for this type (icon or chart). Unmapped
 *  types render the grey cube + 'OBJ' fallback. */
function isMapped(type?: string): boolean {
  return !!type && (TYPE_ICON[type] !== undefined || CHART_SET.has(type));
}

export interface BadgeOpts {
  /** Compact 18px variant for dense rows (tree, Browse results, references). */
  size?: 'xs';
  /** Sub-badges stacked under the stub (inspect corner label / detail header). */
  sub?: { code?: boolean; ref?: boolean };
}

export interface BadgeCopyOpts {
  /** Optional surface feedback after the clipboard write succeeds. */
  onCopied?: (id: string) => void;
  /** Optional surface feedback when clipboard access is unavailable or blocked. */
  onCopyError?: () => void;
}

/**
 * Wire the panel-wide badge gesture onto a stub badge: click copies the
 * surface-resolved identity with a brief, non-layout-shifting green tint.
 * The badge label stays stable; the host surface announces the result through
 * `onCopied` / `onCopyError` (normally the panel's polite live status line).
 */
export function wireBadgeCopy(
  badge: HTMLElement,
  id: (event?: Event) => string,
  opts: BadgeCopyOpts = {},
): HTMLElement {
  badge.classList.add('bdg-copy');
  badge.setAttribute('role', 'button');
  badge.tabIndex = 0;
  const current = (event?: Event) => id(event);
  badge.setAttribute('aria-label', `Copy ${current()}`);
  badge.title = `${badge.title} \u00b7 Click to copy ${current()}`;
  let copiedTimer: ReturnType<typeof setTimeout> | undefined;

  const showCopied = (val: string): void => {
    opts.onCopied?.(val);
    badge.classList.add('bdg-copied');
    if (copiedTimer !== undefined) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      badge.classList.remove('bdg-copied');
      copiedTimer = undefined;
    }, 700);
  };

  const copy = (e: Event): void => {
    e.stopPropagation();
    const val = current(e);
    if (!val) return;
    const clipboard = navigator.clipboard;
    if (!clipboard) {
      opts.onCopyError?.();
      return;
    }
    void clipboard.writeText(val).then(
      () => showCopied(val),
      () => opts.onCopyError?.(),
    );
  };
  badge.addEventListener('click', copy);
  badge.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    copy(e);
  });
  return badge;
}

/**
 * Build a type badge element. Default is the 20px stub; `size: 'xs'` is the
 * compact row variant. Pass `sub` to weld code / reference indicator squares
 * underneath (the inspect-overlay corner label).
 */
export function typeBadge(type?: string, opts: BadgeOpts = {}): HTMLElement {
  const mapped = isMapped(type);
  const property = isPropertyConfigClass(type ?? '');
  const historical = isHistoricalPropertyConfigClass(type ?? '');
  const tile = h('span', { class: 'tile' }, svg(typeIcon(type)));
  if (historical) {
    tile.appendChild(h('span', {
      class: 'bdg-history',
      'aria-label': 'Historical property',
    }, svg(ICON_PROP_HISTORY)));
  }
  const badge = h('span', {
    class: [
      'bdg',
      property ? 'bdg-property' : '',
      historical ? 'bdg-historical' : '',
      opts.size === 'xs' ? 'xs' : '',
    ].filter(Boolean).join(' '),
    style: `--c:${getTypeColor(type)}`,
    title: type ?? '',
  },
    tile,
    h('span', { class: 'lbl' }, mapped ? getTypeAbbr(type) : 'OBJ'),
  );

  const hasSub = opts.sub && (opts.sub.code || opts.sub.ref);
  if (!hasSub) return badge;

  const row = h('span', { class: 'sbrow' });
  if (opts.sub!.code) {
    row.appendChild(h('span', { class: 'sq code', title: 'Carries Extended Code' }, svg(ICON_CODE)));
  }
  if (opts.sub!.ref) {
    row.appendChild(h('span', { class: 'sq ref', title: 'References other objects' }, svg(ICON_LINK)));
  }
  return h('span', { class: `bdg-stack${opts.size === 'xs' ? ' xs' : ''}` }, badge, row);
}
