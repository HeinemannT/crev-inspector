import type { EditPageContext, EditPageFieldContext } from './types';
import { renderedEditPageHosts, renderedEditPageSlots } from './edit-page-dom';
import { isRidShaped } from './rid-shape';

interface FiberLike {
  memoizedProps?: Record<string, unknown>;
  pendingProps?: Record<string, unknown>;
  return?: FiberLike;
  child?: FiberLike;
  sibling?: FiberLike;
}

const MAX_UPWARD_DEPTH = 40;
const MAX_FIBERS = 500;

function reactFiber(element: Element): FiberLike | undefined {
  const key = Object.keys(element).find(candidate =>
    candidate.startsWith('__reactFiber$') || candidate.startsWith('__reactInternalInstance$'),
  );
  return key
    ? (element as unknown as Record<string, FiberLike>)[key]
    : undefined;
}

function optionalRid(value: unknown): string | undefined {
  return isRidShaped(value) ? value : undefined;
}

function optionalIndex(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 10_000
    ? value
    : undefined;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= 500 ? value : undefined;
}

function fieldContextFromProps(props: Record<string, unknown> | undefined): EditPageFieldContext | null {
  if (!props) return null;
  const nested = props.field;
  const nestedField = Boolean(nested && typeof nested === 'object');
  const raw = nestedField
    ? nested as Record<string, unknown>
    : props;
  const key = optionalIndex(raw.key);
  const name = optionalText(raw.name);
  const displayName = optionalText(raw.displayName ?? raw.label);
  const infoRef = nestedField && raw.displayName === undefined && optionalRid(name);
  const propertyRef = infoRef ? undefined : name;
  if (key === undefined && !propertyRef && !infoRef) return null;
  return {
    key,
    ...(propertyRef ? { propertyRef } : {}),
    ...(infoRef ? { objectRef: infoRef, kind: 'info' as const } : { kind: 'field' as const }),
    displayName,
    pageIndex: optionalIndex(raw.pageIndex),
    columnIndex: optionalIndex(raw.columnIndex),
  };
}

function renderedSlots(editPage: Element): Element[] {
  return renderedEditPageSlots(editPage);
}

function slotFiberAnchors(slot: Element): Element[] {
  const anchors = [slot];
  const queue = [...slot.children];
  while (queue.length && anchors.length < 12) {
    const element = queue.shift()!;
    anchors.push(element);
    queue.push(...element.children);
  }
  return anchors;
}

/** Join each rendered native editor to BMP's field-stream index. React keeps
 *  this on an `Editor` ancestor rather than consistently on a
 *  `.property-editor` DOM node. Reference/tag controls have no such class, so
 *  inspect the bounded direct field slots and use their fiber identity. */
function renderedFieldContexts(editPage: Element): EditPageFieldContext[] {
  const fields: EditPageFieldContext[] = [];
  for (const slot of renderedSlots(editPage)) {
    let fallback: EditPageFieldContext | null = null;
    let resolved: EditPageFieldContext | null = null;
    for (const anchor of slotFiberAnchors(slot)) {
      let fiber = reactFiber(anchor);
      for (let depth = 0; fiber && depth < MAX_UPWARD_DEPTH; depth++, fiber = fiber.return) {
        const context = fieldContextFromProps(fiber.memoizedProps ?? fiber.pendingProps);
        if (context?.key !== undefined) {
          resolved = context;
          break;
        }
        fallback ??= context;
      }
      if (resolved) break;
    }
    if (resolved || fallback) {
      fields.push(resolved ?? fallback!);
    } else if (slot.matches('.property-editor') || slot.querySelector('.property-editor')) {
      // Preserve one slot for a genuine, metadata-less editor. An Info slot
      // without React metadata cannot be inspected and is skipped.
      fields.push({});
    }
  }
  return fields;
}

function withRenderedFields(context: EditPageContext, editPage: Element): EditPageContext {
  // Identity is the load-bearing part of this probe. A transitional React
  // subtree can expose the EditionContext before every field slot has a stable
  // fiber; never discard the valid EditPage RID merely because optional field
  // metadata could not be joined during that render tick. Inspect can safely
  // fall back to the configuration stream's DOM order and retry on mutation.
  try {
    const fields = renderedFieldContexts(editPage);
    return fields.some(field => Object.keys(field).length > 0) ? { ...context, fields } : context;
  } catch {
    return context;
  }
}

function contextFromProps(
  props: Record<string, unknown> | undefined,
  surrounding: Record<string, unknown> | undefined,
): EditPageContext | null {
  const edition = props?.editionContext;
  if (!edition || typeof edition !== 'object') return null;
  const raw = edition as Record<string, unknown>;
  const editPageRid = optionalRid(raw.editPageRid);
  if (!editPageRid) return null;
  return {
    editPageRid,
    initializerRid: optionalRid(raw.initializerRid ?? surrounding?.initializerRid),
    templateRid: optionalRid(raw.templateRid ?? surrounding?.templateRid),
    webParentRid: optionalRid(raw.webParentRid ?? surrounding?.webParentRid),
    parentRid: optionalRid(raw.parentRid ?? surrounding?.parentRid),
    objectRid: optionalRid(raw.objectRid ?? surrounding?.objectRid),
    objectName: typeof raw.objectName === 'string' ? raw.objectName : undefined,
    objectType: typeof raw.type === 'string'
      ? raw.type
      : typeof surrounding?.type === 'string' ? surrounding.type : undefined,
  };
}

/** Read BMP's create/edit form identity from the React data already mounted on
 * the page. Work is bounded independently of page size: semantic form anchors,
 * at most 40 ancestors, then at most 500 fiber nodes as a fallback. */
function extractFromHost(editPage: Element): EditPageContext | null {
  const anchors: Element[] = [];
  const propertyEditor = editPage.querySelector('.property-editor');
  if (propertyEditor) anchors.push(propertyEditor);
  anchors.push(editPage);
  // Do not use querySelectorAll('*').slice(...): querySelectorAll still walks
  // the whole subtree before slicing, which is exactly what large edit forms
  // must avoid. This breadth-first fallback visits at most 50 DOM nodes.
  const domQueue: Element[] = [editPage];
  while (domQueue.length && anchors.length < 50) {
    const element = domQueue.shift()!;
    for (const child of element.children) {
      if (anchors.length >= 50) break;
      anchors.push(child);
      domQueue.push(child);
    }
  }

  const starts: FiberLike[] = [];
  for (const anchor of anchors) {
    const start = reactFiber(anchor);
    if (!start) continue;
    starts.push(start);
    let fiber: FiberLike | undefined = start;
    let surrounding: Record<string, unknown> | undefined;
    for (let depth = 0; fiber && depth < MAX_UPWARD_DEPTH; depth++, fiber = fiber.return) {
      const props = fiber.memoizedProps ?? fiber.pendingProps;
      const found = contextFromProps(props, surrounding);
      if (found) {
        // Some carriers keep templateRid one level above editionContext.
        if (!found.templateRid) {
          let parent = fiber.return;
          for (let i = 0; parent && i < 8; i++, parent = parent.return) {
            const parentProps = parent.memoizedProps ?? parent.pendingProps;
            const templateRid = optionalRid(parentProps?.templateRid);
            if (templateRid) { found.templateRid = templateRid; break; }
          }
        }
        return withRenderedFields(found, editPage);
      }
      surrounding = props ?? surrounding;
    }
  }

  // Zero-field and transitional forms may put editionContext below the first
  // attached fiber rather than above it. Search the fiber graph with a hard cap.
  const queue = [...starts];
  const seen = new Set<FiberLike>();
  for (let visited = 0; queue.length && visited < MAX_FIBERS; visited++) {
    const fiber = queue.shift()!;
    if (seen.has(fiber)) continue;
    seen.add(fiber);
    const props = fiber.memoizedProps ?? fiber.pendingProps;
    const found = contextFromProps(props, props);
    if (found) return withRenderedFields(found, editPage);
    if (fiber.child) queue.push(fiber.child);
    if (fiber.sibling) queue.push(fiber.sibling);
  }
  return null;
}

export function extractEditPageContext(root: ParentNode = document): EditPageContext | null {
  for (const editPage of renderedEditPageHosts(root)) {
    const context = extractFromHost(editPage);
    if (context) return context;
  }
  return null;
}
