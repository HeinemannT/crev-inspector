/** Bounded spelling recovery for row-type discovery. This module turns noisy
 * configurator vocabulary into search hypotheses; live BMP results remain the
 * authority for the actual class name. */

const BUSINESS_TYPE_TERMS = [
  'risk', 'assessment', 'control', 'measure', 'indicator', 'action', 'issue',
  'process', 'asset', 'service', 'report', 'audit', 'requirement', 'threat',
  'vulnerability', 'task', 'scorecard',
] as const;

function normalized(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function humanize(value: string): string {
  return normalized(value
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' '))
    .replace(/^ce\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True for an exact occurrence or one insertion/deletion/substitution/
 * adjacent transposition inside a compact source token. */
function approximatelyContains(source: string, term: string): boolean {
  if (source.includes(term)) return true;
  for (let length = Math.max(2, term.length - 1); length <= term.length + 1; length++) {
    for (let start = 0; start + length <= source.length; start++) {
      const candidate = source.slice(start, start + length);
      if (oneEditApart(candidate, term)) return true;
    }
  }
  return false;
}

function oneEditApart(left: string, right: string): boolean {
  if (left === right) return true;
  if (left.length === right.length) {
    const differing: number[] = [];
    for (let index = 0; index < left.length; index++) {
      if (left[index] !== right[index]) differing.push(index);
      if (differing.length > 2) return false;
    }
    if (differing.length === 1) return true;
    return differing.length === 2
      && differing[1] === differing[0] + 1
      && left[differing[0]] === right[differing[1]]
      && left[differing[1]] === right[differing[0]];
  }
  const [shorter, longer] = left.length < right.length ? [left, right] : [right, left];
  if (longer.length - shorter.length !== 1) return false;
  let shortIndex = 0;
  let longIndex = 0;
  let skipped = false;
  while (shortIndex < shorter.length && longIndex < longer.length) {
    if (shorter[shortIndex] === longer[longIndex]) {
      shortIndex++;
      longIndex++;
    } else if (skipped) {
      return false;
    } else {
      skipped = true;
      longIndex++;
    }
  }
  return true;
}

/** Original query first, followed by at most two bounded recovery queries. */
export function rowTypeSearchQueries(value: string): string[] {
  const original = value.trim();
  if (!original) return [];
  const readable = humanize(original);
  const compact = readable.replace(/\s+/g, '').replace(/^ce/, '');
  const matched = BUSINESS_TYPE_TERMS.filter(term => approximatelyContains(compact, term));
  const inferred = matched
    .filter(term => !matched.some(longer => longer.length > term.length && approximatelyContains(longer, term)))
    .join(' ');
  return [...new Set([original, inferred, readable].filter(Boolean))].slice(0, 3);
}
