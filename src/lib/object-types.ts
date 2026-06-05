/**
 * Object-type taxonomy for the Browse tab's two type filters.
 *
 * BMP splits navigable content into two parallel families:
 *  - the Ce* ENTERPRISE objects (the GRC template-instance layer — risks,
 *    controls, issues, incidents, indicators, vendors, …), and
 *  - the classic WEB/scorecard MODEL objects (Scorecard, Task, Issue,
 *    Indicator, …) — note several names exist in BOTH families (Issue vs
 *    CeIssue), which is exactly why Browse offers one dropdown per family.
 *
 * Lists are derived from the live 5.6.10 type catalogue (1465 types) and kept
 * static here — they're stable platform types, not instance state. Each
 * dropdown is typable, so a long list is fine; if a workspace surfaces a type
 * we don't list, results still show under "All types".
 */

/** The 27 Ce* enterprise object types (idSpace TEMPLATECATEGORY). */
export const CE_TYPES: readonly string[] = [
  'CeAsset', 'CeAssuranceActivity', 'CeAttachment', 'CeComment',
  'CeComplianceRequirement', 'CeContract', 'CeControlMeasure', 'CeDistribution',
  'CeDPIA', 'CeIncident', 'CeIndicator', 'CeInquiry', 'CeIssue', 'CePolicy',
  'CePreScreening', 'CePrivacy', 'CeProcedure', 'CeProduct', 'CeProject',
  'CeQuestionnaire', 'CeRegulation', 'CeRiskAssessment', 'CeService', 'CeTask',
  'CeTIA', 'CeVendor', 'CeWorkflow',
];

/** Navigable non-Ce model / web objects — the scorecard-model layer. */
export const WEB_OBJECT_TYPES: readonly string[] = [
  'Scorecard', 'Organisation', 'Perspective', 'StrategicObjective', 'Kpi',
  'Indicator', 'Incident', 'Issue', 'Task', 'RiskAssessment', 'ControlMeasure',
  'Action', 'Page', 'ModelPage', 'EditPage', 'Dashboard', 'DashboardSet', 'Node',
];

