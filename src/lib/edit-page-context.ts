import type { EditPageContext } from './types';
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
export function extractEditPageContext(root: ParentNode = document): EditPageContext | null {
  const editPage = root.querySelector('.edit-page');
  if (!editPage) return null;

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
        return found;
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
    if (found) return found;
    if (fiber.child) queue.push(fiber.child);
    if (fiber.sibling) queue.push(fiber.sibling);
  }
  return null;
}
