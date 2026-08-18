import type { WidgetInfo } from './types';
import {
  ORGANISATION_NAV_PRESENTATION,
  PAGE_NAV_PRESENTATION,
  type OverlayPresentation,
} from './overlay-presentation';

/**
 * Scan the DOM for BMP elements containing RID information.
 * Sources: data-rid, data-object-rid, data-container-rid, href?rid= links, URL params.
 */

/** Pull the tabrid + display name from a single tab button. Single
 *  source of truth for parsing the BMP tab DOM — re-used by
 *  extractUrlRids, findActiveTabAnchor, and findAllTabAnchors so the
 *  three callers can't drift apart on selector / fallback rules. */
function parseTabButton(tab: HTMLElement): { element: HTMLAnchorElement; rid: string; name?: string } | null {
  const anchor = tab.matches('a[href]') ? (tab as HTMLAnchorElement) : tab.querySelector<HTMLAnchorElement>('a[href]');
  if (!anchor) return null;
  try {
    const u = new URL(anchor.href, window.location.origin);
    const tabrid = u.searchParams.get('tabrid') ?? u.searchParams.get('tabRid');
    if (!tabrid || !/^-?\d+$/.test(tabrid)) return null;
    const name = tab.getAttribute('data-title') ?? tab.getAttribute('aria-label') ?? undefined;
    return { element: anchor, rid: tabrid, name };
  } catch { return null; }
}

const SELECTED_TAB_SELECTOR = '.corpo-tabSet__tab--selected, [role="tab"][aria-selected="true"]';
const ANY_TAB_SELECTOR = '.corpo-tabSet__tab, [role="tab"]';

/** Extract the scorecard RID + (where possible) the active tab RID + the
 *  active tab's display name. BMP only puts `?tabrid=…` in the URL on
 *  deep-links — in-app tab clicks DON'T update the URL bar. We inspect
 *  the active tab button for the canonical href instead. Walks the
 *  deepest selected tab when nested (last match wins). */
export function extractUrlRids(): { rid?: string; tabRid?: string; tabName?: string } {
  const params = new URLSearchParams(window.location.search);
  const result: { rid?: string; tabRid?: string; tabName?: string } = {};
  const rid = params.get('rid');
  if (rid) result.rid = rid;
  const urlTabRid = params.get('tabrid') ?? params.get('tabRid');
  if (urlTabRid) result.tabRid = urlTabRid;
  for (const tab of document.querySelectorAll<HTMLElement>(SELECTED_TAB_SELECTOR)) {
    const parsed = parseTabButton(tab);
    if (parsed) { result.tabRid = parsed.rid; result.tabName = parsed.name; }
  }
  return result;
}

/** Active-tab anchor and its rid (the BMP Tab's RID, not the scorecard's).
 *  Walks to the DEEPEST selected tab in document order — same rule as
 *  extractUrlRids, so both surfaces agree on which tabrid is "active"
 *  when nested tabsets are involved. */
export function findActiveTabAnchor(): { element: HTMLElement; rid: string; name?: string } | null {
  let best: { element: HTMLElement; rid: string; name?: string } | null = null;
  for (const tab of document.querySelectorAll<HTMLElement>(SELECTED_TAB_SELECTOR)) {
    const parsed = parseTabButton(tab);
    if (parsed) best = parsed;
  }
  return best;
}

/** All tab anchors on the page (selected + inactive). Used by the inspect
 *  overlay so every tab button gets a pill — matches how widgets behave
 *  (overlay on every rid-bearing element, not just the focused one). */
export function findAllTabAnchors(): Array<{ element: HTMLElement; rid: string; name?: string }> {
  const results: Array<{ element: HTMLElement; rid: string; name?: string }> = [];
  const seen = new Set<Element>();
  for (const tab of document.querySelectorAll<HTMLElement>(ANY_TAB_SELECTOR)) {
    const parsed = parseTabButton(tab);
    if (parsed && !seen.has(parsed.element)) {
      seen.add(parsed.element);
      results.push(parsed);
    }
  }
  return results;
}

/** Normalise a tab label for fuzzy matching: lowercase, collapse
 *  whitespace, and strip leading emoji/symbol + space prefixes (BMP tab
 *  names routinely start with an icon glyph, e.g. "🔄 Process"). */
function normTabName(s: string): string {
  return s
    .replace(/^[^\p{L}\p{N}]+/u, '')   // drop leading non-alphanumeric (icons, arrows)
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/** Find the clickable tab element for a given Tab RID and/or display name.
 *
 *  This is the navigation counterpart to {@link findAllTabAnchors} and uses
 *  the SAME canonical parser, so it can't drift from how we DETECT tabs.
 *  BMP's real tab DOM is `.corpo-tabSet__tab > a[href*="tabrid="]` — matching
 *  by the `?tabrid=` in the href is exact and build-stable. RID wins; name is
 *  the fallback (exact-normalised, then unique contains-match for
 *  icon-prefixed labels). A final legacy pass covers older role="tab" builds
 *  that carry the rid as a data-attribute instead of an href.
 *
 *  Returns the element to `.click()` — clicking the anchor triggers BMP's own
 *  in-app tab switch (no page reload). */
export function findTabButton(tabRid?: string, tabName?: string): HTMLElement | null {
  const anchors = findAllTabAnchors();
  if (tabRid) {
    const hit = anchors.find(a => a.rid === tabRid);
    if (hit) return hit.element;
  }
  if (tabName) {
    const want = normTabName(tabName);
    const exact = anchors.find(a => a.name && normTabName(a.name) === want);
    if (exact) return exact.element;
    const loose = anchors.filter(a => a.name && normTabName(a.name).includes(want));
    if (loose.length === 1) return loose[0].element;
  }
  // Legacy fallback — older BMP builds expose tabs as role="tab" elements
  // carrying the rid as a data-attribute (no href anchor to parse).
  if (tabRid) {
    const escaped = tabRid.replace(/[^a-zA-Z0-9_-]/g, c => `\\${c}`);
    for (const sel of [`[role="tab"][data-rid="${escaped}"]`, `[data-tab-rid="${escaped}"]`, `[data-rid="${escaped}"][class*="tab" i]`]) {
      const el = document.querySelector<HTMLElement>(sel);
      if (el) return el.closest<HTMLElement>('[role="tab"], button, a') ?? el;
    }
  }
  return null;
}

/** Is this tab element (or its enclosing tab container) the selected one?
 *  Uses the canonical SELECTED_TAB_SELECTOR so it agrees with how we read
 *  the active tab elsewhere — BMP marks it `.corpo-tabSet__tab--selected`,
 *  which the old `classList.contains('selected')` check missed. */
export function isTabActive(el: HTMLElement): boolean {
  if (el.matches(SELECTED_TAB_SELECTOR)) return true;
  if (el.closest(SELECTED_TAB_SELECTOR)) return true;
  // Tolerate other builds' conventions.
  return el.matches('.selected, .active, .is-active, .is-selected, [aria-selected="true"], [data-active="true"]');
}

/** Result from scanning a DOM element for its RID */
interface RidElement extends OverlayPresentation {
  element: Element;
  rid: string;
}

function ridFromLink(link: HTMLAnchorElement | null): string | null {
  if (!link) return null;
  try {
    const url = new URL(link.href, window.location.origin);
    return url.searchParams.get('rid');
  } catch {
    return null;
  }
}

/**
 * BMP's breadcrumb is two semantic groups with identical link classes:
 * organizations first, pages second. Compare each group's current link with
 * the selected top-bar organization instead of treating every dropdown row as
 * a page. The DOM-order fallback covers builds without the top-bar test hook.
 */
function portalNavigationPresentation(link: HTMLAnchorElement): Readonly<OverlayPresentation> | undefined {
  if (!link.matches('.nav-bar-item-content, .dropdown-sibling-element')) return undefined;
  const group = link.closest('.page-location-element');
  // BMP's personal-page menu lives in the top bar rather than either
  // breadcrumb group, but its entries use the same dropdown link class.
  if (!group) {
    return link.closest('.topbar-placeholder-menu') ? PAGE_NAV_PRESENTATION : undefined;
  }

  const currentOrganisationRid = ridFromLink(
    document.querySelector<HTMLAnchorElement>('a.topbar-item-link[data-test="topbar-item-link"]'),
  );
  const groupRid = ridFromLink(group.querySelector<HTMLAnchorElement>('a.nav-bar-item-content'));
  if (currentOrganisationRid && groupRid === currentOrganisationRid) {
    return ORGANISATION_NAV_PRESENTATION;
  }

  const groups = Array.from(document.querySelectorAll('.page-location-element'));
  if (!currentOrganisationRid && groups.length > 1 && groups.indexOf(group) === 0) {
    return ORGANISATION_NAV_PRESENTATION;
  }
  return PAGE_NAV_PRESENTATION;
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
    // The organization logo and label are two adjacent links to the same RID
    // in BMP's global top bar. Badging both turns the brand into a pair of
    // floating green tiles. The breadcrumb below remains inspectable.
    if (link.matches('.topbar-item-link')) continue;
    try {
      const url = new URL(link.href, window.location.origin);
      const rid = url.searchParams.get('rid');
      if (rid) {
        const presentation = portalNavigationPresentation(link);
        results.push({
          element: link,
          rid,
          ...presentation,
        });
      }
    } catch {
      // Invalid URL
    }
  }
  return results;
}

/**
 * Get ALL elements with detectable RIDs — for badge placement.
 * Returns deduplicated list (element + rid). Tab anchors (which have no
 * `data-rid` of their own — only `?tabrid=` in their href) are included
 * regardless of the `includeLinks` flag so tabs get the same overlay
 * treatment as widgets. Without this, the user couldn't right-click /
 * pick / inspect the tabs they navigate through.
 */
export function getAllRidElements(includeLinks = true): RidElement[] {
  const results = findDataRidElements();
  const seen = new Set<Element>();
  for (const r of results) seen.add(r.element);

  // Tab anchors first — always include. Tab is the navigation context;
  // hiding it behind `includeLinks=false` (which the widget-list path
  // uses) would still leave tabs invisible there.
  for (const t of findAllTabAnchors()) {
    if (!seen.has(t.element)) {
      results.push({ element: t.element, rid: t.rid });
      seen.add(t.element);
    }
  }

  if (!includeLinks) return results;

  for (const item of findRidLinks()) {
    if (!seen.has(item.element)) {
      results.push(item);
      seen.add(item.element);
    }
  }

  return results;
}

/** Minimum visible rectangle to count as a "widget" — anything smaller is
 *  treated as a label / chip / table cell and excluded so the Page-tab list
 *  doesn't drown in row-link rids on a dense table page (e.g. Risk Register
 *  with 200+ rows would push the real widgets off-screen). 100×40 keeps the
 *  smallest real widgets (ButtonInput, ChoiceInput) while dropping inline
 *  rid-bearing links. */
const WIDGET_MIN_W = 100;
const WIDGET_MIN_H = 40;

/** Build a list of all widgets on the current page — the Page tab consumes
 *  this. Returns visible, widget-sized data-rid elements only; tiny inline
 *  links carrying rids (table-row navigation) are filtered out.
 *
 *  Tabs are prepended (in tab-strip order) and exempt from the size
 *  filter — tab buttons are routinely narrower than 100px. They're
 *  marked `type: 'Tab'` so the Page tab can render them with the
 *  layout colour and the user can click into them as first-class
 *  objects. */
export function scanPageWidgets(): WidgetInfo[] {
  const widgets: WidgetInfo[] = [];
  const seen = new Set<string>();

  // Tabs first — order by DOM position, mark each with type='Tab'.
  for (const t of findAllTabAnchors()) {
    if (seen.has(t.rid)) continue;
    seen.add(t.rid);
    const rect = t.element.getBoundingClientRect();
    widgets.push({
      rid: t.rid,
      name: t.name,
      type: 'Tab',
      element: 'a',
      rect: rect.width || rect.height
        ? { top: rect.top, left: rect.left, width: rect.width, height: rect.height }
        : undefined,
    });
  }

  // includeLinks=false: rid-bearing anchor tags are row navigation, not
  // widgets. They'd dominate the list on data tables and aren't what the
  // user means by "widgets on this page."
  for (const { element, rid } of getAllRidElements(/* includeLinks */ false)) {
    if (seen.has(rid)) continue;
    const rect = element.getBoundingClientRect();
    // Skip off-screen / hidden elements (rect = 0×0 for display:none).
    if (rect.width === 0 && rect.height === 0) continue;
    // Skip elements smaller than the widget threshold.
    if (rect.width < WIDGET_MIN_W || rect.height < WIDGET_MIN_H) continue;
    seen.add(rid);

    const testAttr = element.getAttribute('data-test');
    const typeAttr = element.getAttribute('data-rid-type')
      ?? element.getAttribute('data-object-type')
      ?? undefined;
    widgets.push({
      rid,
      name: testAttr ?? element.getAttribute('title') ?? undefined,
      type: typeAttr,
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
    signals.push({ name: '#epmapp container', weight: 0.55 });

  if (document.getElementById('corpo-app'))
    signals.push({ name: '#corpo-app root', weight: 0.55 });

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
