/**
 * @vitest-environment happy-dom
 *
 * Locks the expanded type-badge coverage: every previously-uncovered BMP type now has a code + a
 * domain-band colour, and — critically — an entry in TYPE_ICON so `typeBadge` treats it as "mapped"
 * and renders its real 3-letter code instead of the generic `OBJ` fallback.
 */
import { describe, it, expect } from 'vitest';
import { getTypeAbbr, getTypeColor } from '../types';
import { typeBadge, typeIcon } from '../type-badge';
import { ICON_GRID_NINE, ICON_CHART } from '../icons';

// [className, code, colour] — the full set added on top of the original coverage.
const EXPECTED: [string, string, string][] = [
  // Scorecard-tree lists + objects (gold / orange)
  ['StrategicObjective', 'SOB', '#f5cd47'], ['Kpi', 'KPI', '#f5cd47'], ['TaskList', 'TSK', '#f5cd47'],
  ['CheckList', 'CHK', '#f5cd47'], ['Function', 'FUN', '#f5cd47'],
  ['RiskList', 'RKL', '#e8890c'], ['IndicatorList', 'INL', '#b28600'],
  // Tables (coral)
  ['ActionPlanTable', 'APT', '#ff8389'], ['RiskAssessmentTable', 'RAT', '#ff8389'], ['ReportsList', 'RPL', '#ff8389'],
  ['ProcessStatisticsTable', 'PST', '#ff8389'], ['UserTaskInstanceTable', 'UTI', '#ff8389'], ['BPMNModelTable', 'BMT', '#ff8389'],
  ['ProcessIncidentTable', 'PIT', '#ff8389'], ['ProcessInstanceTable', 'PIN', '#ff8389'], ['ProcessTable', 'PRC', '#ff8389'],
  // Forms (cyan)
  ['ContinuousForm', 'CFM', '#1192e8'], ['EPMForm', 'FRM', '#1192e8'], ['PeriodicFormPage', 'PFP', '#1192e8'],
  ['ScheduledForm', 'SFM', '#1192e8'], ['ScheduledFormPage', 'SFP', '#1192e8'],
  ['ScheduledFormDistributionList', 'SFD', '#1192e8'], ['FormSchedule', 'FSC', '#1192e8'],
  // Process / BPMN / flow (deep purple)
  ['BPMNView', 'BPM', '#6929c4'], ['HappyPathViewForProcessReference', 'HPP', '#6929c4'], ['RelationshipDiagram', 'RLD', '#6929c4'],
  ['FlowProject', 'FLP', '#6929c4'], ['FlowProjectGroup', 'FPG', '#6929c4'], ['TransformerSchedule', 'TRS', '#6929c4'], ['LogFolder', 'LOG', '#6929c4'],
  // Status (grey)
  ['Status', 'STS', '#8d8d8d'], ['SimpleStatus', 'SST', '#8d8d8d'], ['FunctionStatus', 'FST', '#8d8d8d'],
  // Views / media (brown)
  ['DescriptionView', 'DSV', '#d2a373'], ['ImageView', 'IMG', '#d2a373'], ['PdfView', 'PDF', '#d2a373'], ['Spacer', 'SPC', '#d2a373'],
  // Templates / misc
  ['EnterpriseTemplate', 'ETP', '#6fdc8c'], ['CustomVisualizationExpression', 'CVE', '#be95ff'],
  // Enterprise (Ce*) — shared teal
  ['CeAsset', 'AST', '#08bdba'], ['CeIncident', 'INC', '#08bdba'], ['CeRiskAssessment', 'RAS', '#08bdba'], ['CeControlMeasure', 'CTM', '#08bdba'],
  ['CeIssue', 'ISU', '#08bdba'], ['CeProcedure', 'PCD', '#08bdba'], ['CeComplianceRequirement', 'CMP', '#08bdba'], ['CeRegulation', 'REG', '#08bdba'],
  ['CeTIA', 'TIA', '#08bdba'], ['CePreScreening', 'PRS', '#08bdba'], ['CeWorkflow', 'WKF', '#08bdba'], ['CeService', 'SVC', '#08bdba'],
  ['CeQuestionnaire', 'QNR', '#08bdba'], ['CeTask', 'CTK', '#08bdba'], ['CeIndicator', 'CID', '#08bdba'], ['CeAssuranceActivity', 'ASA', '#08bdba'],
];

describe('expanded type-badge coverage', () => {
  it.each(EXPECTED)('%s → code %s, colour %s', (type, code, colour) => {
    expect(getTypeAbbr(type)).toBe(code);
    expect(getTypeColor(type)).toBe(colour);
  });

  it('every expanded type is "mapped" — the badge shows its code, not the OBJ fallback', () => {
    for (const [type, code] of EXPECTED) {
      const lbl = typeBadge(type).querySelector('.lbl')?.textContent;
      expect(lbl, type).toBe(code);
    }
  });

  it('expanded codes are unique and never reuse the existing OBJ / STA codes', () => {
    const codes = EXPECTED.map(e => e[1]);
    expect(new Set(codes).size).toBe(codes.length); // no duplicate within the new set
    expect(codes).not.toContain('OBJ');             // Objective keeps OBJ
    expect(codes).not.toContain('STA');             // StatusType keeps STA
  });
});

// Second wave — the addable widget types discovered from the BMP containment model.
const ADDABLE: [string, string, string][] = [
  // Tables / lists (coral)
  ['ActivityLogTable', 'ATL', '#ff8389'], ['DataTable', 'DTB', '#ff8389'], ['DataTableView', 'DTV', '#ff8389'],
  ['DatasetTableQueryView', 'DQV', '#ff8389'], ['NodeInputTable', 'NIT', '#ff8389'], ['StandardTable', 'STB', '#ff8389'],
  ['TablePivot', 'TPV', '#ff8389'], ['TableView', 'TVW', '#ff8389'], ['TreeTable', 'TTB', '#ff8389'],
  ['ScenarioTable', 'SCT', '#ff8389'], ['ViewCacheStatusTable', 'VCT', '#ff8389'], ['IncidentList', 'ICL', '#ff8389'],
  ['IssueList', 'ISL', '#ff8389'], ['PolicyAssetList', 'PAL', '#ff8389'], ['RiskEventList', 'REL', '#ff8389'],
  ['ShortcutList', 'SCL', '#ff8389'], ['TreatmentList', 'TML', '#ff8389'], ['LocalComments', 'LCM', '#ff8389'],
  ['AttachmentList', 'ATT', '#ff8389'],
  // Forms / enrollments (cyan)
  ['AnsweredReportFormEnrollment', 'ARE', '#1192e8'], ['Enrollment', 'ENR', '#1192e8'], ['Enrollments', 'ENS', '#1192e8'],
  ['FormResponses', 'FRS', '#1192e8'], ['ReportFormEnrollment', 'RFE', '#1192e8'], ['ReportFormEnrollments', 'RFS', '#1192e8'],
  ['ReportForms', 'RPF', '#1192e8'], ['TaskFormEnrollment', 'TFE', '#1192e8'],
  // Views / media (brown)
  ['URLView', 'URL', '#d2a373'], ['ExternalResourcesView', 'ERV', '#d2a373'], ['SpreadsheetView', 'SSV', '#d2a373'],
  // Process / diagram (deep purple)
  ['ProcessLandscapeView', 'PLV', '#6929c4'], ['LinkMap', 'LKM', '#6929c4'], ['BowtieDiagram', 'BOW', '#6929c4'],
  // Dashboards / BI (pink)
  ['Dashboard', 'DBD', '#ff7eb6'], ['PowerBi', 'PBI', '#ff7eb6'],
  // Charts (chart coral)
  ['StandardChart', 'SCH', '#ff8a80'], ['Trend', 'TRN', '#ff8a80'],
  // Structural (indigo)
  ['ButtonContainer', 'BCN', '#9aa3e8'], ['Section', 'SEC', '#9aa3e8'], ['WebChildReference', 'WCR', '#9aa3e8'],
  // Governance / metadata (grey)
  ['ObjectApproval', 'APR', '#8d8d8d'], ['ObjectClassification', 'CLS', '#8d8d8d'],
];

describe('addable-widget type-badge coverage', () => {
  it.each(ADDABLE)('%s → code %s, colour %s', (type, code, colour) => {
    expect(getTypeAbbr(type)).toBe(code);
    expect(getTypeColor(type)).toBe(colour);
  });

  it('every addable type renders "mapped" — its code, not the OBJ fallback', () => {
    for (const [type, code] of ADDABLE) {
      expect(typeBadge(type).querySelector('.lbl')?.textContent, type).toBe(code);
    }
  });

  it('addable codes are unique within this wave', () => {
    const codes = ADDABLE.map(e => e[1]);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('RiskChart now has its own glyph, distinct from the generic chart', () => {
    expect(typeIcon('RiskChart')).toBe(ICON_GRID_NINE);
    expect(typeIcon('RiskChart')).not.toBe(ICON_CHART);
    expect(typeIcon('BarChart')).toBe(ICON_CHART); // real charts still use the generic chart glyph
  });
});

// Flow-chain elements (blueprint flow editing) — InputSet fields, EditPage elements, breaks.
// EditPageValidation deliberately shares the VAL code with Validation (both are guard rows), so this
// wave does NOT assert code uniqueness.
const FLOW: [string, string, string][] = [
  ['EditField', 'EFD', '#78a9ff'], ['EditPageInfo', 'INF', '#78a9ff'], ['EditPageButton', 'EPB', '#78a9ff'],
  ['ListInput', 'LIN', '#78a9ff'], ['ButtonGroup', 'GRP', '#9aa3e8'],
  ['Validation', 'VAL', '#8d8d8d'], ['EditPageValidation', 'VAL', '#8d8d8d'],
  ['EditPageBreak', 'PBR', '#c3ccd8'], ['EditPageColumnBreak', 'CBR', '#c3ccd8'],
];

describe('flow-chain type-badge coverage', () => {
  it.each(FLOW)('%s → code %s, colour %s', (type, code, colour) => {
    expect(getTypeAbbr(type)).toBe(code);
    expect(getTypeColor(type)).toBe(colour);
  });

  it('every flow type renders "mapped" — its code, not the OBJ fallback', () => {
    for (const [type, code] of FLOW) {
      expect(typeBadge(type).querySelector('.lbl')?.textContent, type).toBe(code);
    }
  });
});
