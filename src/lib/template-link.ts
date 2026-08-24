/**
 * The one place that knows how to resolve an object's "template".
 *
 * A BMP object reaches its template three different ways depending on the model:
 *   - **linkedTo** — the Scorecard / SharedWebItems model: an instance created by `org.link(template)`
 *     carries `linkedTo` → its master (and each instance widget `linkedTo` → its template widget).
 *   - **template** — the EnterpriseTemplate model in simple mode: CeIssue / CeRiskAssessment / …
 *     carry `.template`.
 *   - **templateExpression** — the EnterpriseTemplate model in advanced mode: BMP evaluates the
 *     referenced ExtendedExpression and uses its EnterpriseTemplate result instead of `.template`.
 * The resolution order is **linkedTo first, then the effective enterprise template** — verified live
 * and used identically by every caller. See skills/bmp-platform/reference/page-hosting.md.
 *
 * This snippet was re-implemented in four places (resolveTemplate, batchEnrich, buildObjectPaneEc,
 * applyObjectChanges). Consolidated here so the fallback order lives once. Pure — emits EC text only.
 */

/**
 * EC lines assigning `outVar := <template of inVar>` (linkedTo, falling back to BMP's effective
 * enterprise-template rule). `advancedMode=true` deliberately ignores `.template`: this mirrors
 * `HasEnterpriseTemplate.resolveTemplate()`, including the case where the expression is absent.
 * Returned as a line array so callers can spread it into their own builders at any nesting; `indent`
 * is prepended to each line for that. Every consumer asserts via substring, so the exact formatting
 * is owned here.
 *
 * @example  [`_o := ${ref}`, ...ecResolveTemplate('_o', '_t'), `${'_t'}.rid…`]
 */
export function ecResolveTemplate(inVar: string, outVar: string, indent = ''): string[] {
  return [
    `${indent}${outVar} := ${inVar}.linkedTo`,
    `${indent}IF ${outVar} = MISSING THEN`,
    ...ecResolveEnterpriseTemplate(inVar, outVar, `${indent}     `),
    `${indent}ENDIF`,
  ];
}

/** Resolve only the HasEnterpriseTemplate side of the model. Unlike `ecResolveTemplate`, this does
 * not inspect `.linkedTo`, so callers classifying page ownership cannot mistake a linked Scorecard
 * instance for an EnterpriseTemplate-backed Ce* page. */
export function ecResolveEnterpriseTemplate(inVar: string, outVar: string, indent = ''): string[] {
  const expressionVar = `${outVar}Expression`;
  return [
    `${indent}IF ${inVar}.advancedMode.whenMissing(false) = true THEN`,
    `${indent}     ${expressionVar} := ${inVar}.templateExpression`,
    `${indent}     IF ${expressionVar} = MISSING THEN ${outVar} := MISSING ELSE ${outVar} := ${expressionVar}.expression ENDIF`,
    `${indent}     IF ${outVar}.className.whenMissing("") = "EnterpriseTemplate" THEN ${outVar} := ${outVar} ELSE ${outVar} := MISSING ENDIF`,
    `${indent}ELSE`,
    `${indent}     ${outVar} := ${inVar}.template`,
    `${indent}ENDIF`,
  ];
}
