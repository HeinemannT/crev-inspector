export type PreviewReceiptEvent =
  | { kind: 'write'; object: string; property: string; value: string }
  | { kind: 'move'; object: string; relation: 'before' | 'after' | 'into'; target: string }
  | { kind: 'generated'; action: 'create' | 'edit'; code: string; target?: string }
  | { kind: 'result'; text: string };

export interface PreviewReceipt {
  events: PreviewReceiptEvent[];
  summary: string;
  raw: string;
  rawLineCount: number;
}

function cleanProtocolPrefix(line: string): string {
  return line.replace(/^\s*Message\s*:\s*/u, '').trim();
}

function generatedTarget(code: string): string | undefined {
  const name = /\bname\s*:=\s*(['"])(.*?)\1/u.exec(code)?.[2];
  if (name) return name;
  const ref = /^\s*(?:_\w+\s*:=\s*)?([^\s]+?)\.(?:add|change)\(/u.exec(code)?.[1];
  return ref?.replace(/^t\./u, '');
}

function countLabel(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function summarize(events: readonly PreviewReceiptEvent[]): string {
  const writes = events.filter(event => event.kind === 'write').length;
  const moves = events.filter(event => event.kind === 'move').length;
  const generated = events.filter(event => event.kind === 'generated').length;
  const results = events.filter(event => event.kind === 'result').length;
  return [
    writes ? countLabel(writes, 'change') : '',
    moves ? countLabel(moves, 'move') : '',
    generated ? countLabel(generated, 'generated script') : '',
    results ? countLabel(results, 'result') : '',
  ].filter(Boolean).join(' · ') || 'No output';
}

/** Convert BMP's mixed preview log into an ordered, presentation-only receipt.
 * Parsing never affects whether a preview is runnable; unknown output remains
 * available verbatim and falls back to a generic result row. */
export function parsePreviewReceipt(raw: string): PreviewReceipt {
  const normalized = raw.replace(/\r\n?/gu, '\n').trim();
  const sourceLines = normalized ? normalized.split('\n') : [];
  const events: PreviewReceiptEvent[] = [];
  const resultLines: string[] = [];
  let inResult = false;

  for (const sourceLine of sourceLines) {
    const line = cleanProtocolPrefix(sourceLine);
    if (!line) {
      if (inResult && resultLines.length) resultLines.push('');
      continue;
    }
    if (/^(?:Duration\s*:|\[PREVIEW\b)/iu.test(line)) continue;

    const write = /^Would write "([\s\S]*)" to property "([^"]+)" for object (.+)$/u.exec(line);
    if (write) {
      events.push({ kind: 'write', value: write[1], property: write[2], object: write[3].trim() });
      continue;
    }

    const siblingMove = /^Would move "([\s\S]+)" (before|after) "([\s\S]+)"\s*$/u.exec(line);
    if (siblingMove) {
      events.push({
        kind: 'move',
        object: siblingMove[1],
        relation: siblingMove[2] as 'before' | 'after',
        target: siblingMove[3],
      });
      continue;
    }

    const parentMove = /^Would move "([\s\S]+)" as child of\s+"([\s\S]+)"\s*$/u.exec(line);
    if (parentMove) {
      events.push({ kind: 'move', object: parentMove[1], relation: 'into', target: parentMove[2] });
      continue;
    }

    const resultStart = /^Result\s*:\s*(.*)$/u.exec(line);
    if (resultStart) {
      inResult = true;
      if (resultStart[1]) resultLines.push(resultStart[1]);
      continue;
    }
    if (inResult) resultLines.push(sourceLine.trimEnd());
  }

  const generatedLines = resultLines
    .map(line => line.trim())
    .filter(line => /\.(?:add|change)\(/u.test(line));
  for (const code of generatedLines) {
    events.push({
      kind: 'generated',
      action: /\.add\(/u.test(code) ? 'create' : 'edit',
      code,
      target: generatedTarget(code),
    });
  }

  if (!events.length) {
    const result = resultLines.map(line => line.trim()).filter(Boolean).join(' ')
      || sourceLines.map(cleanProtocolPrefix)
        .find(line => line && !/^(?:Duration\s*:|\[PREVIEW\b)/iu.test(line));
    if (result) events.push({ kind: 'result', text: result });
  }

  return {
    events,
    summary: summarize(events),
    raw: normalized,
    rawLineCount: sourceLines.filter(line => line.trim()).length,
  };
}
