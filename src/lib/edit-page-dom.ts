/**
 * Shared, read-only description of BMP's rendered standalone EditPage DOM.
 *
 * The MAIN-world context extractor, the isolated Inspect overlay, and
 * Blueprint must agree on which element is a field slot and which direct
 * children are responsive column wrappers. Keep that inference here so a BMP
 * DOM variation cannot make the three surfaces map different objects.
 */

export interface RenderedEditPageColumn {
  element: Element;
  rect: DOMRect;
  slots: Array<{ element: Element; rect: DOMRect }>;
}

export interface RenderedEditPageDom {
  host: Element;
  hostRect: DOMRect;
  content: Element;
  contentRect: DOMRect;
  columns: RenderedEditPageColumn[];
  pageTabs: Array<{ element: Element; rect: DOMRect }>;
  nav?: { element: Element; rect: DOMRect };
}

/**
 * BMP uses two host shapes for the same EditPage renderer:
 * - standalone create/edit routes: `.edit-page`
 * - an EditPage embedded by CreateObjectView: `.edit-page-main-container`
 *
 * The standalone wrapper already contains a main container, so exclude that
 * nested container to keep one host per rendered form.
 */
export function renderedEditPageHosts(root: ParentNode = document): Element[] {
  return [...root.querySelectorAll('.edit-page, .edit-page-main-container')]
    .filter(element =>
      element.matches('.edit-page')
      || !element.closest('.edit-page'),
    );
}

export function hasStandaloneEditPage(root: ParentNode = document): boolean {
  return Boolean(root.querySelector('.edit-page'));
}

function positiveRect(element: Element): DOMRect | null {
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0 ? rect : null;
}

function isVisibleHost(element: Element): DOMRect | null {
  const rect = positiveRect(element);
  return rect && rect.width > 120 ? rect : null;
}

function overlapY(a: DOMRect, b: DOMRect): number {
  return Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
}

/**
 * Column wrappers occupy different horizontal lanes and overlap vertically.
 * This remains true when every column contains only one field; child-count
 * heuristics do not.
 */
function directChildrenAreColumns(
  entries: Array<{ element: Element; rect: DOMRect }>,
): boolean {
  if (entries.length < 2) return false;
  return entries.some((entry, index) =>
    entries.slice(index + 1).some(other => {
      const laneDelta = Math.abs(entry.rect.left - other.rect.left);
      const minWidth = Math.min(entry.rect.width, other.rect.width);
      return laneDelta > Math.max(8, minWidth * 0.35)
        && overlapY(entry.rect, other.rect) > 8;
    }),
  );
}

export function readRenderedEditPageHost(host: Element): RenderedEditPageDom | null {
  const hostRect = isVisibleHost(host);
  if (!hostRect) return null;
  const content = host.querySelector('.edit-page-content');
  const contentRect = content ? positiveRect(content) : null;
  if (!content || !contentRect) return null;

  const direct = [...content.children].flatMap(element => {
    const rect = positiveRect(element);
    return rect ? [{ element, rect }] : [];
  });
  const columnElements = directChildrenAreColumns(direct)
    ? direct
    : [{ element: content, rect: contentRect }];
  const columns = columnElements.map(column => ({
    ...column,
    slots: [...column.element.children].flatMap(element => {
      const rect = positiveRect(element);
      return rect ? [{ element, rect }] : [];
    }),
  }));
  if (!columns.length) return null;

  const navElement = host.querySelector('[data-testid^="EDIT_PAGE_PAGINATION_STEPPER_ID_"]');
  const navRect = navElement ? positiveRect(navElement) : null;
  const stepRow = navElement?.firstElementChild;
  const pageTabs = stepRow
    ? [...stepRow.children].flatMap(element => {
        const rect = positiveRect(element);
        return rect && (element.textContent?.trim() ?? '') && rect.height > 10
          ? [{ element, rect }]
          : [];
      })
    : [];

  return {
    host,
    hostRect,
    content,
    contentRect,
    columns,
    pageTabs,
    ...(navElement && navRect ? { nav: { element: navElement, rect: navRect } } : {}),
  };
}

export function readRenderedEditPage(root: ParentNode = document): RenderedEditPageDom | null {
  for (const host of renderedEditPageHosts(root)) {
    const rendered = readRenderedEditPageHost(host);
    if (rendered) return rendered;
  }
  return null;
}

export function renderedEditPageSlots(host: Element): Element[] {
  const rendered = readRenderedEditPageHost(host);
  if (rendered) return rendered.columns.flatMap(column => column.slots.map(slot => slot.element));
  // Headless DOM tests and a form during its first React commit can expose the
  // structure before layout boxes are measurable. Preserve the same bounded
  // direct-child interpretation without pretending zero-sized elements are
  // live geometry.
  const content = host.querySelector('.edit-page-content');
  if (content) {
    const direct = [...content.children];
    const directField = direct.some(element =>
      element.matches('.property-editor,[data-test],[data-testid]'),
    );
    const wrappers = direct.length > 0
      && !directField
      && (
        direct.length === 1
        || direct.every(element => element.children.length > 0)
      );
    return wrappers ? direct.flatMap(column => [...column.children]) : direct;
  }
  return [...host.querySelectorAll('.property-editor')]
    .filter(element => !element.parentElement?.closest('.property-editor'));
}
