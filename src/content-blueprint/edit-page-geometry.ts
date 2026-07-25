export interface EditPageBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface EditPageLiveColumn extends EditPageBox {
  slots: EditPageBox[];
}

export interface EditPageLiveGeometry {
  host: DOMRect;
  title?: EditPageBox;
  nav?: EditPageBox;
  content: EditPageBox;
  columns: EditPageLiveColumn[];
  rowGap: number;
  fallbackRowHeight: number;
}

const visibleRect = (element: Element): DOMRect | null => {
  const rect = element.getBoundingClientRect();
  return rect.width > 120 && rect.height > 0 ? rect : null;
};

const relativeBox = (rect: DOMRect, host: DOMRect): EditPageBox => ({
  left: rect.left - host.left,
  top: rect.top - host.top,
  width: rect.width,
  height: rect.height,
});

const median = (values: number[], fallback: number): number => {
  if (!values.length) return fallback;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

/** Read the current BMP form as layout metrics, never as object identity.
 *
 * BMP exposes no RID on property editors, but its stable `.edit-page`,
 * `.edit-page-content`, and direct column/item structure gives us exact live
 * width, column positions, row heights, and gaps. The model remains the source
 * of object identity and ordering; these boxes only make its projection trace
 * the rendered form instead of inventing a second rhythm. */
export function readEditPageLiveGeometry(): EditPageLiveGeometry | null {
  const hosts = [...document.querySelectorAll('.edit-page')]
    .map(element => ({ element, rect: visibleRect(element) }))
    .filter((entry): entry is { element: Element; rect: DOMRect } => Boolean(entry.rect));
  const entry = hosts[0];
  if (!entry) return null;

  const { element: hostElement, rect: host } = entry;
  const contentElement = hostElement.querySelector('.edit-page-content');
  const contentRect = contentElement ? visibleRect(contentElement) : null;
  if (!contentElement || !contentRect) return null;

  const directChildren = [...contentElement.children].filter(child => visibleRect(child));
  const directChildrenAreEditors = directChildren.some(child =>
    child.matches('.property-editor,[data-test],[data-testid]'),
  );
  const hasColumnWrappers = !directChildrenAreEditors && directChildren.some(child =>
    [...child.children].filter(grandchild => visibleRect(grandchild)).length > 1,
  );
  const columnElements = hasColumnWrappers ? directChildren : [contentElement];
  const columns: EditPageLiveColumn[] = columnElements.flatMap(column => {
    const columnRect = visibleRect(column);
    if (!columnRect) return [];
    const itemElements = [...column.children].filter(child => visibleRect(child));
    const slots = itemElements.flatMap(item => {
      const rect = visibleRect(item);
      return rect ? [relativeBox(rect, host)] : [];
    });
    return [{ ...relativeBox(columnRect, host), slots }];
  });
  if (!columns.length) return null;

  const gaps = columns.flatMap(column =>
    column.slots.slice(1).map((slot, index) =>
      Math.max(0, slot.top - (column.slots[index].top + column.slots[index].height)),
    ),
  ).filter(gap => gap > 0);
  const heights = columns.flatMap(column => column.slots.map(slot => slot.height));
  const titleRect = hostElement.querySelector('h1')?.getBoundingClientRect();
  const navRect = hostElement
    .querySelector('[data-testid^="EDIT_PAGE_PAGINATION_STEPPER_ID_"]')
    ?.getBoundingClientRect();

  return {
    host,
    ...(titleRect ? { title: relativeBox(titleRect, host) } : {}),
    ...(navRect ? { nav: relativeBox(navRect, host) } : {}),
    content: relativeBox(contentRect, host),
    columns,
    rowGap: median(gaps, 15),
    fallbackRowHeight: median(heights, 80),
  };
}
