/**
 * BMP namespace resolution — maps className to ID-space prefix.
 *
 * A reference like "k.pMyProp" resolves to the property object with businessId "pMyProp"
 * under root.PROPERTY in any BMP workspace.
 *
 * Ported from crev/src/tools/transport-tool/lib/namespace.ts.
 * Used by: BMP object hover (pattern validation), future transport features.
 */

/** className → namespace prefix */
const NAMESPACE_MAP: Record<string, string> = {
  // Groups / Access / Roles
  Group: 'g', ROLE: 'role', ACCESSPROFILE: 'ap', DEFAULTS: 'd',

  // Resources
  FileResource: 'r', TranslationFile: 'r', APIResource: 'r', RemoteResource: 'r',
  APIEndpoint: 'r', APIClientAuthentication: 'r', EndpointParameter: 'r',
  LogFolder: 'r', CorpoLog: 'r', SqlResource: 'r', PowerBiResource: 'r',

  // Properties
  TextMethodConfig: 'k', ListMethodConfig: 'k', HistoricalListMethodConfig: 'k',
  HistoricalReferenceMethodConfig: 'k', HistoricalTextMethodConfig: 'k',
  RichTextMethodConfig: 'k', ExtendedMethodConfig: 'k', TokenMethodConfig: 'k',
  HistoricalRichTextMethodConfig: 'k', HistoricalDateMethodConfig: 'k',
  BooleanMethodConfig: 'k', ReferenceMethodConfig: 'k', UrlMethodConfig: 'k',
  FunctionMethodConfig: 'k', HistoricalNumberMethodConfig: 'k', NumberMethodConfig: 'k',
  DateMethodConfig: 'k', TagMethodConfig: 'k', HistoricalBooleanMethodConfig: 'k',
  ListPropertySet: 'k', ListPropertySetItem: 'k',

  // Categories / Templates / Portal
  Category: 't', ExtendedExpression: 't', ProcessDefinition: 't', ClassConfig: 't', Transformer: 't',

  // Enterprise objects
  CEVENDOR: 'ceven', CETASK: 'cetas', CECOMMENT: 'cecom', CEINCIDENT: 'ceinc',
  CEPROCEDURE: 'cepro', CEPOLICY: 'cepol', CECONTROLMEASURE: 'cecme',
  CEISSUE: 'ceiss', CEASSET: 'ceass', CESERVICE: 'ceser', CECONTRACT: 'cecot',
  CEPROJECT: 'ceprj', CEREGULATION: 'cereg', CECOMPLIANCEREQUIREMENT: 'cecor',
  CEINDICATOR: 'ceind', CEATTACHMENT: 'ceatt', CERISKASSESSMENT: 'ceras',
  CEPRODUCT: 'ceprd', CEPRESCREENING: 'cepsc', CEPRIVACY: 'ceprv',
  CEWORKFLOW: 'cewfl', CEDISTRIBUTION: 'cedis', CEINQUIRY: 'ceinq',
  CEQUESTIONNAIRE: 'ceqst', CEDPIA: 'cedpi', CETIA: 'cetia', CEASSURANCEACTIVITY: 'ceasa',
};

/** All valid namespace prefixes (for hover pattern validation) */
const VALID_PREFIXES = new Set(Object.values(NAMESPACE_MAP));
// Add prefixes that aren't derivable from the map
VALID_PREFIXES.add('t');   // default for most portal objects
VALID_PREFIXES.add('o');   // organisation space
VALID_PREFIXES.add('u');   // user space
VALID_PREFIXES.add('s');   // scorecard space
VALID_PREFIXES.add('p');   // legacy property space

// ── Copy strategy (shared across all copy surfaces) ──────────

export interface CopyableIdentity {
  rid: string;
  businessId?: string;
  type?: string;
  templateBusinessId?: string;
}

export type CopyModifier = 'plain' | 'shift' | 'ctrl' | 'alt';

/** Resolve what to copy based on modifier key. Used by overlay badges, detail view, quick inspector. */
export function resolveCopyText(
  identity: CopyableIdentity,
  modifier: CopyModifier,
): { text: string; label: string } {
  if (modifier === 'alt') {
    // Alt explicitly returns the raw RID. Useful for plumbing into ec_help,
    // server logs, or anywhere businessId can't be looked up. Falls back to
    // the businessId only when the RID is absent (shouldn't happen in practice).
    return { text: identity.rid || identity.businessId || '', label: 'RID' };
  }
  if (modifier === 'ctrl' && identity.businessId) {
    const ns = resolveNamespace(identity.type ?? '');
    return { text: `${ns}.${identity.businessId}`, label: 'ref' };
  }
  if (modifier === 'shift') {
    if (identity.templateBusinessId) {
      return { text: identity.templateBusinessId, label: 'Template ID' };
    }
    return { text: '', label: 'No template' };
  }
  return { text: identity.businessId ?? identity.rid, label: 'ID' };
}

/** Extract copy modifier from a mouse event. Alt takes precedence over Ctrl/Shift
 *  since the user explicitly wants the raw RID; mixed modifiers favor Alt. */
export function getModifier(e: MouseEvent): CopyModifier {
  if (e.altKey) return 'alt';
  if (e.ctrlKey || e.metaKey) return 'ctrl';
  if (e.shiftKey) return 'shift';
  return 'plain';
}

/** Standard tooltip text for copy buttons with modifier support. */
export const COPY_TOOLTIP = 'Copy ID (Alt: RID; Shift: template; Ctrl: reference)';

// ── Namespace validation ─────────────────────────────────────

/** Check if a prefix is a valid BMP namespace. */
export function isValidNamespace(prefix: string): boolean {
  return VALID_PREFIXES.has(prefix);
}

// Case-insensitive lookup table. BMP classNames are PascalCase
// (`CeRiskAssessment`), but the enterprise block of NAMESPACE_MAP was
// authored ALL-CAPS (`CERISKASSESSMENT`). A direct lookup therefore MISSED
// for every Ce* type and fell back to `t.`, producing dead references like
// `t.113` (correct: `ceras.113`) when ctrl-clicking a pill. Normalising both
// sides to upper-case fixes the whole enterprise block at once and is robust
// to className-vs-typeKey casing differences.
const NAMESPACE_MAP_UC: Record<string, string> = Object.fromEntries(
  Object.entries(NAMESPACE_MAP).map(([k, v]) => [k.toUpperCase(), v]),
);

/** Resolve a className to its namespace prefix (case-insensitive). */
export function resolveNamespace(className: string): string {
  return NAMESPACE_MAP_UC[className.toUpperCase()] ?? 't';
}

/** ClassNames that carry code properties (expression, html, javascript). */
export const CODE_BEARING_TYPES = new Set([
  'ExtendedMethodConfig', 'ExtendedTable', 'ExtendedExpression',
  'ReferenceMethodConfig', 'HistoricalReferenceMethodConfig',
  'CustomVisualization', 'DashboardHTML',
]);
