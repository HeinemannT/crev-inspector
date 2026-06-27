/**
 * The one place that knows how to resolve an object's "template".
 *
 * A BMP object reaches its template two different ways depending on the model:
 *   - **linkedTo** — the Scorecard / SharedWebItems model: an instance created by `org.link(template)`
 *     carries `linkedTo` → its master (and each instance widget `linkedTo` → its template widget).
 *   - **template** — the EnterpriseTemplate model: CeIssue / CeRiskAssessment / … carry `.template`.
 * The resolution order is **linkedTo first, then .template** — verified live and used identically by
 * every caller. See skills/bmp-platform/reference/template-instance-architecture.md.
 *
 * This snippet was re-implemented in four places (resolveTemplate, batchEnrich, buildObjectPaneEc,
 * applyObjectChanges). Consolidated here so the fallback order lives once. Pure — emits EC text only.
 */

/**
 * EC lines assigning `outVar := <template of inVar>` (linkedTo, falling back to .template).
 * Returned as a line array so callers can spread it into their own builders at any nesting; `indent`
 * is prepended to each line for that. The IF is one-line — every consumer asserts via substring, so
 * the exact formatting is owned here.
 *
 * @example  [`_o := ${ref}`, ...ecResolveTemplate('_o', '_t'), `${'_t'}.rid…`]
 */
export function ecResolveTemplate(inVar: string, outVar: string, indent = ''): string[] {
  return [
    `${indent}${outVar} := ${inVar}.linkedTo`,
    `${indent}IF ${outVar} = MISSING THEN ${outVar} := ${inVar}.template ENDIF`,
  ];
}
