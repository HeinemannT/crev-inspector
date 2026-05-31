/**
 * Shared EC output parsers — consolidates pipe-delimited and separator-based parsing.
 */

const PIPE_SEP = '|||';

/** Parse pipe-delimited EC output lines into field arrays. Skips MISSING/SKIP RIDs and short lines. */
export function parsePipeLines(log: string, minFields: number): Array<string[]> {
  const results: Array<string[]> = [];
  for (const line of log.trim().split('\n')) {
    if (!line.includes(PIPE_SEP)) continue;
    const parts = line.split(PIPE_SEP);
    if (parts.length < minFields) continue;
    const rid = parts[0]?.trim();
    if (!rid || rid === 'MISSING' || rid === 'SKIP') continue;
    results.push(parts.map(p => p.trim()));
  }
  return results;
}

/** Parse <<<CREV_SEP>>>-wrapped property blocks from EC output. */
export function parseSepBlocks(log: string, sep: string): Record<string, string> {
  const out: Record<string, string> = {};
  const parts = log.split(sep);
  for (let i = 1; i < parts.length; i += 2) {
    const propName = parts[i];
    if (propName === 'DONE') break;
    const value = (parts[i + 1] ?? '').replace(/^\n/, '').replace(/\n$/, '');
    if (value) out[propName] = value;
  }
  return out;
}

/** Parse <<<CREV_SEP>>>-wrapped multi-object output (with OBJ markers) into per-RID property maps. */
export function parseSepMultiObject(log: string, sep: string): Map<string, Record<string, string>> {
  const result = new Map<string, Record<string, string>>();
  const parts = log.split(sep);
  let currentRid: string | null = null;
  let currentProps: Record<string, string> = {};

  for (let i = 1; i < parts.length; i += 2) {
    const marker = parts[i];
    if (marker === 'DONE') break;
    const value = (parts[i + 1] ?? '').replace(/^\n/, '').replace(/\n$/, '');

    if (marker === 'OBJ') {
      if (currentRid) result.set(currentRid, currentProps);
      currentRid = value.trim();
      if (currentRid === 'SKIP') currentRid = null;
      currentProps = {};
    } else if (currentRid) {
      if (value) currentProps[marker] = value;
    }
  }
  if (currentRid) result.set(currentRid, currentProps);

  return result;
}
