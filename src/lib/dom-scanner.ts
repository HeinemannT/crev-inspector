import type { WidgetInfo } from './types';

/**
 * Scan the DOM for BMP elements containing RID information.
 * Sources: data-rid, data-object-rid, data-container-rid, href?rid= links, URL params.
 */

/** Extract RID and tab RID from the current page URL */
export function extractUrlRids(): { rid?: string; tabRid?: string } {
  const params = new URLSearchParams(window.location.search);
  const result: { rid?: string; tabRid?: string } = {};
  const rid = params.get('rid');
  const tabRid = params.get('tabrid') ?? params.get('tabRid');
  if (rid) result.rid = rid;
  if (tabRid) result.tabRid = tabRid;
  return result;
}

/** Result from scanning a DOM element for its RID */
interface RidElement {
  element: Element;
  rid: string;
}

/** Find all elements with any RID data attribute */
function findDataRidElements(): RidElement[] {
  const results: RidElement[] = [];
  const seen = new Set<Element>();

  for (const el of document.querySelectorAll('[data-rid],[data-object-rid],[data-container-rid]')) {
    if (seen.has(el)) continue;
    const rid = el.getAttribute('data-rid') ?? el.getAttribute('data-object-rid') ?? el.getAttribute('data-container-rid');
    if (rid) {
      results.push({ element: el, rid });
      seen.add(el);
    }
  }
  return results;
}

/** Find all anchor elements with rid in href */
function findRidLinks(): RidElement[] {
  const results: RidElement[] = [];
  for (const link of document.querySelectorAll<HTMLAnchorElement>('a[href*="rid="]')) {
    try {
      const url = new URL(link.href, window.location.origin);
      const rid = url.searchParams.get('rid');
      if (rid) results.push({ element: link, rid });
    } catch {
      // Invalid URL
    }
  }
  return results;
}

/**
 * Get ALL elements with detectable RIDs — for badge placement.
 * Returns deduplicated list (element + rid).
 */
export function getAllRidElements(includeLinks = true): RidElement[] {
  // findDataRidElements() already deduplicates by element
  const results = findDataRidElements();
  if (!includeLinks) return results;

  const seen = new Set<Element>();
  for (const r of results) seen.add(r.element);

  for (const item of findRidLinks()) {
    if (!seen.has(item.element)) {
      results.push(item);
      seen.add(item.element);
    }
  }

  return results;
}

/** Build a list of all widgets on the current page */
export function scanPageWidgets(): WidgetInfo[] {
  const widgets: WidgetInfo[] = [];
  const seen = new Set<string>();

  for (const { element, rid } of getAllRidElements()) {
    if (seen.has(rid)) continue;
    seen.add(rid);

    const rect = element.getBoundingClientRect();
    const testAttr = element.getAttribute('data-test');
    widgets.push({
      rid,
      name: testAttr ?? element.getAttribute('title') ?? undefined,
      element: element.tagName.toLowerCase(),
      rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
    });
  }

  return widgets;
}

/** Multi-signal BMP page detection result */
export interface DetectionResult {
  isBmp: boolean;
  confidence: number;
  signals: string[];
}

/** Minimum detection confidence to classify page as BMP */
export const BMP_CONFIDENCE_THRESHOLD = 0.5;

/** Detect if current page is BMP using weighted multi-signal scoring */
export function detectBmpPage(): DetectionResult {
  const signals: Array<{ name: string; weight: number }> = [];

  if (document.getElementById('epmapp'))
    signals.push({ name: '#epmapp container', weight: 0.35 });

  if (document.getElementById('corpo-app'))
    signals.push({ name: '#corpo-app root', weight: 0.35 });

  if (document.querySelector('[data-rid]'))
    signals.push({ name: 'data-rid attributes', weight: 0.25 });

  try {
    if ([...document.fonts].some(f => f.family.includes('LatoLatinWeb')))
      signals.push({ name: 'LatoLatinWeb font', weight: 0.2 });
  } catch { /* fonts API unavailable */ }

  if (/\/(Steadfast|corporater)(\/|$)/i.test(location.pathname))
    signals.push({ name: 'BMP URL path', weight: 0.25 });

  if (document.title.includes('Corporater'))
    signals.push({ name: 'BMP page title', weight: 0.2 });

  if (document.querySelector('.widget__body, .ag-root-wrapper'))
    signals.push({ name: 'BMP widget classes', weight: 0.15 });

  if (document.querySelector('link[href*="corporater"], script[src*="corporater"], link[href*="bmp-"]'))
    signals.push({ name: 'BMP assets', weight: 0.15 });

  const confidence = Math.min(1, signals.reduce((sum, s) => sum + s.weight, 0));
  return {
    isBmp: confidence >= BMP_CONFIDENCE_THRESHOLD,
    confidence,
    signals: signals.map(s => s.name),
  };
}
