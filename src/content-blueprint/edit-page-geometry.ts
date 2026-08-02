import { readRenderedEditPage } from '../lib/edit-page-dom';

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
  hostElement: Element;
  host: DOMRect;
  title?: EditPageBox;
  nav?: EditPageBox;
  pageTabs: EditPageBox[];
  content: EditPageBox;
  columns: EditPageLiveColumn[];
  rowGap: number;
  fallbackRowHeight: number;
}

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
  const rendered = readRenderedEditPage();
  if (!rendered) return null;
  const { host: hostElement, hostRect: host, contentRect } = rendered;
  const columns: EditPageLiveColumn[] = rendered.columns.map(column => ({
    ...relativeBox(column.rect, host),
    slots: column.slots.map(slot => relativeBox(slot.rect, host)),
  }));
  if (!columns.length) return null;

  const gaps = columns.flatMap(column =>
    column.slots.slice(1).map((slot, index) =>
      Math.max(0, slot.top - (column.slots[index].top + column.slots[index].height)),
    ),
  ).filter(gap => gap > 0);
  const heights = columns.flatMap(column => column.slots.map(slot => slot.height));
  const titleRect = hostElement.querySelector('h1')?.getBoundingClientRect();
  const navRect = rendered.nav?.rect;
  const pageTabs = rendered.pageTabs.map(tab => relativeBox(tab.rect, host));

  return {
    hostElement,
    host,
    ...(titleRect ? { title: relativeBox(titleRect, host) } : {}),
    ...(navRect ? { nav: relativeBox(navRect, host) } : {}),
    pageTabs,
    content: relativeBox(contentRect, host),
    columns,
    rowGap: median(gaps, 15),
    fallbackRowHeight: median(heights, 80),
  };
}
