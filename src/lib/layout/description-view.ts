import type { LModel, LNode } from './types';

/** Resolve the object class whose property schema a DescriptionView uses.
 *  Enterprise templates carry an explicit Ce* `viewTypes` value (defaulted from the viewed instance);
 *  classic pages use the concrete page object class itself. */
export function descriptionViewSourceType(model: LModel, node: LNode): string {
  if (node.className !== 'DescriptionView') return '';
  // Classic views are fixed to the concrete page class. Ignore a stale/malformed viewTypes value
  // rather than letting enterprise-only state change both the schema and the UI contract.
  if (model.pageClass !== 'EnterpriseTemplate') return model.pageClass;
  return node.viewTypes?.[0] ?? model.enterpriseObjectType ?? '';
}

/** Only Enterprise DescriptionViews expose a writable source selector. Classic views still expose
 *  their individual properties, but BMP fixes their source to the current page object. */
export function hasEditableDescriptionViewSource(model: LModel, node: LNode): boolean {
  return node.className === 'DescriptionView' && model.pageClass === 'EnterpriseTemplate';
}
