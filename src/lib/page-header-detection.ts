/**
 * Locate BMP's page-title heading without depending on generated class names.
 *
 * The detector deliberately considers only level-one heading candidates, then
 * combines semantic, structural, positional, and identity signals. It fails
 * closed when two candidates remain similarly plausible; attaching an object
 * action to the wrong heading is worse than showing no in-page badge.
 */

export interface PageHeaderMatch {
  element: HTMLElement;
  score: number;
  signals: string[];
}

export interface PageHeaderDetectionOptions {
  expectedName?: string;
}

const CANDIDATE_SELECTOR = 'h1, [role="heading"][aria-level="1"]';
const EXCLUDED_ANCESTOR_SELECTOR = [
  'dialog',
  '[role="dialog"]',
  '[aria-modal="true"]',
  'nav',
  '[role="navigation"]',
  '[data-rid]',
  '[data-object-rid]',
  '[data-container-rid]',
  '#crev-tooltip',
  '.crev-eo-host',
].join(',');

function normaliseHeadingText(value: string): string {
  return value
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase();
}

function isVisible(element: HTMLElement): boolean {
  if (element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
  const style = getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function appRootFor(element: HTMLElement): HTMLElement | null {
  const roots = document.querySelectorAll<HTMLElement>('#epmapp, #corpo-app, #root');
  for (const root of roots) {
    if (root.contains(element)) return root;
  }
  return null;
}

function scoreCandidate(
  element: HTMLElement,
  expectedName: string | undefined,
  visibleCandidateCount: number,
): PageHeaderMatch | null {
  if (!isVisible(element) || element.closest(EXCLUDED_ANCESTOR_SELECTOR)) return null;

  const root = appRootFor(element);
  // Once BMP exposes a recognised app root, a heading outside it belongs to
  // browser chrome, a host shell, or another embedded application.
  if (document.querySelector('#epmapp, #corpo-app') && !root) return null;

  const rect = element.getBoundingClientRect();
  const signals: string[] = [];
  let score = 0;

  if (element.tagName === 'H1') {
    score += 5;
    signals.push('semantic-h1');
  } else {
    score += 4;
    signals.push('aria-level-1');
  }

  if (root) {
    score += 2;
    signals.push('inside-app-root');
  }

  if (element.closest('main, [role="main"]')) {
    score += 2;
    signals.push('inside-main');
  }

  // Page titles live near the top of BMP's content viewport. This remains a
  // supporting signal rather than a hard requirement so a scrolled page can
  // still retain a previously selected, connected heading.
  const topBand = Math.max(240, window.innerHeight * 0.35);
  if (rect.top >= 0 && rect.top <= topBand) {
    score += 2;
    signals.push('top-content-band');
  }

  if (visibleCandidateCount === 1) {
    score += 1;
    signals.push('only-level-one-heading');
  }

  const wanted = expectedName ? normaliseHeadingText(expectedName) : '';
  const actual = normaliseHeadingText(element.textContent ?? '');
  if (wanted && actual === wanted) {
    score += 5;
    signals.push('exact-page-name');
  } else if (wanted && actual && (actual.startsWith(wanted) || wanted.startsWith(actual))) {
    score += 2;
    signals.push('compatible-page-name');
  }

  return { element, score, signals };
}

/**
 * Return a high-confidence page heading, or null when the DOM is ambiguous.
 * Complexity is O(number of level-one headings), normally one or two.
 */
export function detectPageHeader(options: PageHeaderDetectionOptions = {}): PageHeaderMatch | null {
  const visibleCandidates = Array.from(document.querySelectorAll<HTMLElement>(CANDIDATE_SELECTOR))
    .filter(isVisible);
  const matches = visibleCandidates
    .map(element => scoreCandidate(element, options.expectedName, visibleCandidates.length))
    .filter((match): match is PageHeaderMatch => match !== null)
    .sort((a, b) => b.score - a.score || a.element.getBoundingClientRect().top - b.element.getBoundingClientRect().top);

  const best = matches[0];
  if (!best || best.score < 8) return null;
  const runnerUp = matches[1];
  if (runnerUp && best.score - runnerUp.score < 2 && !best.signals.includes('exact-page-name')) return null;
  return best;
}
