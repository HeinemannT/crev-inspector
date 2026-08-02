/**
 * Inspect-mode projection for standalone BMP create/edit routes.
 *
 * Native `.property-editor` controls intentionally do not carry configuration
 * RIDs. The MAIN-world interceptor supplies each rendered field's stable
 * stream index, while the service worker resolves the owning EditPage's
 * ordered EditField identities. This module joins the two without mutating
 * BMP-owned data attributes.
 */

import type { ContentState, EditPageInspectField } from './content-state';
import type { AdditionalOverlayTarget } from './content-overlays';
import type { EditPageContext, InspectorMessage } from './lib/types';
import { readRenderedEditPage, renderedEditPageHosts, renderedEditPageSlots } from './lib/edit-page-dom';
import { sendRequest } from './lib/messaging';
import { isRidShaped } from './lib/rid-shape';

type InspectFieldsResult = Extract<InspectorMessage, { type: 'INSPECT_EDIT_PAGE_FIELDS_RESULT' }>;

function normalized(value: string | undefined): string {
  return (value ?? '').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

function renderedSlots(root: ParentNode): HTMLElement[] {
  const rendered = readRenderedEditPage(root);
  if (rendered) {
    return rendered.columns.flatMap(column =>
      column.slots.map(slot => slot.element as HTMLElement));
  }
  const host = renderedEditPageHosts(root)[0] as HTMLElement | undefined;
  if (host) return renderedEditPageSlots(host) as HTMLElement[];
  return [];
}

function renderedEditors(
  root: ParentNode,
  metadata: readonly NonNullable<EditPageContext['fields']>[number][],
): HTMLElement[] {
  const host = renderedEditPageHosts(root)[0];
  if (!host) return [];
  if (!metadata.length) {
    return [...host.querySelectorAll<HTMLElement>('.property-editor')]
      .filter(element => !element.parentElement?.closest('.property-editor'));
  }
  const candidates = renderedSlots(root);
  const unused = new Set(candidates);
  return metadata.flatMap(field => {
    const displayName = normalized(field.displayName);
    const textMatch = displayName
      ? candidates.find(candidate =>
          unused.has(candidate) && normalized(candidate.textContent ?? '').includes(displayName))
      : undefined;
    const styled = candidates.find(candidate =>
      unused.has(candidate)
      && (candidate.matches('.property-editor') || Boolean(candidate.querySelector('.property-editor'))));
    const element = textMatch ?? styled ?? candidates.find(candidate => unused.has(candidate));
    if (!element) return [];
    unused.delete(element);
    return [element];
  });
}

/** Pure DOM/configuration join, exported for regression tests. */
export function resolveEditPageOverlayTargets(
  context: EditPageContext | null,
  fields: readonly EditPageInspectField[],
  root: ParentNode = document,
): AdditionalOverlayTarget[] {
  if (!context) return [];
  const host = renderedEditPageHosts(root)[0];
  const targets: AdditionalOverlayTarget[] = host && !host.matches('.edit-page')
    ? [{
        element: host,
        rid: context.editPageRid,
        labelClassName: 'crev-inline-edit-page-label',
      }]
    : [];
  if (fields.length === 0) return targets;
  const metadata = context.fields ?? [];
  const editors = renderedEditors(root, metadata);
  const byStreamIndex = new Map(fields.map(field => [field.streamIndex, field]));
  const used = new Set<string>();

  targets.push(...editors.flatMap((element, domIndex) => {
    const fieldContext = metadata[domIndex];
    const byObject = fieldContext?.objectRef
      ? fields.find(field => field.rid === fieldContext.objectRef && !used.has(field.rid))
      : undefined;
    const byProperty = fieldContext?.propertyRef
      ? fields.find(field => field.property === fieldContext.propertyRef && !used.has(field.rid))
      : undefined;
    const byKey = fieldContext?.key === undefined ? undefined : byStreamIndex.get(fieldContext.key);
    const field = byObject
      ?? byProperty
      ?? (byKey && !used.has(byKey.rid) ? byKey : undefined)
      ?? fields.find((candidate, index) => index >= domIndex && !used.has(candidate.rid))
      ?? fields.find(candidate => !used.has(candidate.rid));
    if (!field?.rid) return [];
    used.add(field.rid);
    return [{
      element,
      rid: field.rid,
      labelClassName: 'crev-edit-field-label',
      ...(field.propertyObject ? { propertyTarget: field.propertyObject } : {}),
    }];
  }));
  return targets;
}

export function editPageOverlayTargets(s: ContentState): AdditionalOverlayTarget[] {
  if (s.editPageInspectRid !== s.editPageContext?.editPageRid) return [];
  return resolveEditPageOverlayTargets(s.editPageContext, s.editPageInspectFields);
}

/** Resolve the EditField identities once per rendered EditPage. Returns true
 *  when a fresh mapping landed and the caller should repaint overlays. */
export async function ensureEditPageInspection(s: ContentState): Promise<boolean> {
  const context = s.editPageContext;
  if (!s.inspectActive || !context) return false;
  if (s.editPageInspectRid === context.editPageRid) return false;
  if (s.editPageInspectLoadingRid === context.editPageRid) return false;
  if (Date.now() < s.editPageInspectRetryAt) return false;

  const request = ++s.editPageInspectRequest;
  s.editPageInspectLoadingRid = context.editPageRid;
  const response = await sendRequest<InspectFieldsResult>({
    type: 'INSPECT_EDIT_PAGE_FIELDS',
    editPageRid: context.editPageRid,
  });
  if (request !== s.editPageInspectRequest) return false;
  s.editPageInspectLoadingRid = null;
  if (!response?.ok) {
    s.editPageInspectRetryAt = Date.now() + 5_000;
    return false;
  }

  s.editPageInspectRid = context.editPageRid;
  s.editPageInspectFields = (response.fields ?? []).filter(field => isRidShaped(field.rid));
  s.editPageInspectRetryAt = 0;
  return s.inspectActive && s.editPageContext?.editPageRid === context.editPageRid;
}
