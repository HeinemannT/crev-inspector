/**
 * EC output parser + renderer — turns raw EC text into colored DOM elements.
 * Detects: Result/Duration metadata, warnings, errors, pipe-separated data, tables.
 */

import { h } from '../lib/dom';

type LineType = 'result' | 'duration' | 'warning' | 'error' | 'data' | 'text';

function classifyLine(line: string): LineType {
  const trimmed = line.trimStart();
  if (trimmed.startsWith('Result : ') || trimmed.startsWith('Result: ')) return 'result';
  // Flexible whitespace so it agrees with parseBmpDurationMs — otherwise a
  // `Duration  :  59ms` (odd padding) would parse into the pill yet survive
  // in the body, showing the number twice.
  if (/^Duration\s*:/.test(trimmed)) return 'duration';
  if (trimmed.startsWith('Warning : ') || trimmed.startsWith('Warning: ')) return 'warning';
  if (trimmed.startsWith('Error : ') || trimmed.startsWith('Error: ') || /Exception[:\s]/.test(trimmed)) return 'error';
  if (line.includes('|||')) return 'data';
  return 'text';
}

const LINE_CLASSES: Record<LineType, string> = {
  result: 'ec-out-meta',
  duration: 'ec-out-meta',
  warning: 'ec-out-warn',
  error: 'ec-out-error',
  data: 'ec-out-data',
  text: '',
};

/** Box Drawing Unicode block (U+2500–U+257F) — `║ │ ═ ╔` etc. A line
 *  containing any of these is BMP's monospace table art. */
const BOX_DRAWING_RE = /[─-╿]/;

/** Extract BMP's self-reported compute time (the `Duration : …` footer)
 *  from raw EC output, in milliseconds. This is BMP's server-side execution
 *  time — distinct from the editor's wall-clock round-trip (which also
 *  includes SW + network); the two are merged in the output pill.
 *
 *  Returns:
 *   - N    when BMP reports `Duration : Nms`
 *   - 0    when the footer is present but non-numeric (`Duration : no time`,
 *          which BMP emits for sub-millisecond runs) — i.e. "ran, <1ms"
 *   - null when there's no Duration footer at all
 *  Only matches the bare metadata line, not a `Duration` substring inside
 *  other output. */
export function parseBmpDurationMs(text: string): number | null {
  if (!text) return null;
  const line = text.match(/^\s*Duration\s*:\s*(.*)$/m);
  if (!line) return null;
  const ms = line[1].match(/(\d+)\s*ms/);
  return ms ? Number(ms[1]) : 0;
}

/** Format the editor's timing pill. `rttMs` is the editor's wall-clock
 *  round-trip (incl. SW + network + BMP); `bmpMs` is BMP's own compute from
 *  parseBmpDurationMs — N ms, 0 for a sub-millisecond "no time" run, or null
 *  when BMP reported no Duration. Returns the compact pill text plus a
 *  spelled-out tooltip. The "RTT" label only appears when there's a BMP
 *  figure to contrast it against. */
export function formatRunTiming(rttMs: number, bmpMs: number | null): { text: string; title: string } {
  if (bmpMs == null) {
    return { text: `${rttMs}ms`, title: `${rttMs}ms round-trip (RTT)` };
  }
  const bmp = bmpMs > 0 ? `${bmpMs}ms` : '<1ms';
  const bmpTitle = bmpMs > 0 ? `${bmpMs}ms` : 'sub-millisecond';
  return {
    text: `${rttMs}ms RTT · ${bmp} BMP`,
    title: `${rttMs}ms round-trip (RTT) · ${bmpTitle} BMP compute`,
  };
}

/** Decode JSON-style backslash escape sequences that BMP sometimes ships through
 *  (\n, \r, \t, \", \\, \/, \uXXXX). Only triggers when at least one such sequence
 *  is present so plain output is untouched. */
export function decodeEscapes(text: string): string {
  if (!text || !/\\(?:[nrt"\\/]|u[0-9a-fA-F]{4})/.test(text)) return text;
  return text.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_, esc: string) => {
    if (esc[0] === 'u') {
      const cp = parseInt(esc.slice(1), 16);
      return Number.isFinite(cp) ? String.fromCharCode(cp) : `\\${esc}`;
    }
    switch (esc) {
      case 'n': return '\n';
      case 'r': return '\r';
      case 't': return '\t';
      case '"': return '"';
      case '\\': return '\\';
      case '/': return '/';
      default: return `\\${esc}`;
    }
  });
}

/** Split one box-drawing table row into its interior cells.
 *
 *  BMP draws rows as `║ c0 │ c1 │ … │ cN ║` (or `│ … │` for ASCII
 *  tables). Splitting on the box characters yields the N+1 interior
 *  cells plus an empty fragment OUTSIDE each border. We drop only those
 *  outer fragments (and only when empty, so a row that's missing a
 *  border doesn't lose real content) and KEEP every interior cell —
 *  including the empty ones.
 *
 *  Keeping empty interior cells is what makes sparse / hierarchical
 *  tables render correctly: `demo_table` positions each tree level in a
 *  different column by padding the others with `""`. The previous
 *  `.filter(c => c !== '')` collapsed those rows leftward, dumping every
 *  value into columns 1–2 under a 6-column header. Cells are returned
 *  UNTRIMMED so the renderer can show clean text while keeping the raw
 *  padded cell as the `title` tooltip.
 *
 *  Only the box-drawing characters U+2551/U+2502 split — a literal ASCII
 *  `|` inside a cell value is left intact. */
export function splitTableRow(line: string): string[] {
  let cells = line.split(/[║│]/);
  if (cells.length > 1 && cells[0].trim() === '') cells = cells.slice(1);
  if (cells.length > 1 && cells[cells.length - 1].trim() === '') cells = cells.slice(0, -1);
  return cells;
}

/** One logical unit of parsed EC output: a normalized table, or a single
 *  classified line. Table cells are UNTRIMMED so callers can trim for
 *  display / TSV while keeping the raw padded text for tooltips. */
export type OutputBlock =
  | { kind: 'table'; headers: string[]; rows: string[][] }
  | { kind: 'line'; type: LineType; text: string };

/** Parse raw EC output into ordered blocks. Shared by the DOM renderer
 *  and the clipboard serializer so the two can never drift.
 *  When tableMode is false, box-drawing tables are left as plain lines.
 *  When decode is true, JSON-style escape sequences are unescaped first. */
export function parseEcOutput(text: string, tableMode = true, decode = true): OutputBlock[] {
  const blocks: OutputBlock[] = [];
  if (!text) return blocks;
  if (decode) text = decodeEscapes(text);

  let inTable = false;
  let headers: string[] = [];
  let rows: string[][] = [];
  const flushTable = () => {
    if (headers.length > 0 || rows.length > 0) blocks.push({ kind: 'table', headers, rows });
    headers = [];
    rows = [];
  };

  for (const line of text.split('\n')) {
    if (tableMode) {
      // Table detection (box-drawing characters)
      if (line.includes('╔') || line.includes('┌')) { inTable = true; headers = []; rows = []; continue; }
      if (inTable && (line.includes('╚') || line.includes('└'))) { inTable = false; flushTable(); continue; }
      if (inTable && (line.includes('╠') || line.includes('├') || line.includes('═') || line.includes('─'))) {
        continue; // separator line
      }
      if (inTable && (line.includes('║') || line.includes('│'))) {
        // Keep interior empty cells — see splitTableRow.
        const cells = splitTableRow(line);
        if (headers.length === 0) headers = cells; else rows.push(cells);
        continue;
      }
    }
    const type = classifyLine(line);
    // The Duration metadata line is surfaced in the output pill (round-trip
    // + BMP compute), so drop it from the parsed body — no point showing
    // the same number twice. Other meta (Result, Warning) stays.
    if (type === 'duration') continue;
    blocks.push({ kind: 'line', type, text: line });
  }
  if (inTable) flushTable(); // unclosed / truncated table
  return blocks;
}

/** Render EC output text into colored DOM elements.
 *  When tableMode is false, box-drawing tables are rendered as plain text.
 *  When decode is true, JSON-style escape sequences in the raw text are unescaped. */
export function renderEcOutput(text: string, tableMode = true, decode = true): HTMLElement {
  const container = h('div', { class: 'ec-output-parsed' });
  for (const block of parseEcOutput(text, tableMode, decode)) {
    if (block.kind === 'table') {
      container.appendChild(renderTable(block.headers, block.rows));
      continue;
    }
    if (block.type === 'data') {
      // Pipe-separated (|||) → inline key · value fields.
      const parts = block.text.split('|||').map(p => p.trim());
      container.appendChild(
        h('div', { class: 'ec-out-line ec-out-data' },
          ...parts.flatMap((p, i) => i === 0
            ? [h('span', { class: 'ec-out-data-key' }, p)]
            : [h('span', { class: 'ec-out-data-sep' }, ' · '), h('span', { class: 'ec-out-data-val' }, p)],
          ),
        ),
      );
      continue;
    }
    // Plain line. A box-drawing row is only reachable here when tableMode
    // is off (the raw fallback); `ec-out-raw` switches it to
    // `white-space: pre` so the row stays intact and the panel scrolls
    // horizontally instead of wrapping the art into nonsense.
    const cls = LINE_CLASSES[block.type];
    const raw = BOX_DRAWING_RE.test(block.text) ? ' ec-out-raw' : '';
    container.appendChild(
      h('div', { class: `ec-out-line${cls ? ' ' + cls : ''}${raw}` }, block.text),
    );
  }
  return container;
}

/** Serialize EC output to clipboard-friendly text, mirroring what the
 *  panel shows: normalized tables become TAB-separated rows (so they
 *  paste cleanly into a spreadsheet) while every other line is kept
 *  verbatim. With tableMode off, tables stay as their raw box-drawing
 *  lines — you copy exactly what you see. */
export function ecOutputToText(text: string, tableMode = true, decode = true): string {
  return parseEcOutput(text, tableMode, decode)
    .map((block) => block.kind === 'table'
      ? [block.headers, ...block.rows].map((r) => r.map((c) => c.trim()).join('\t')).join('\n')
      : block.text)
    .join('\n');
}

function renderTable(headers: string[], rows: string[][]): HTMLElement {
  return h('table', { class: 'ec-out-table' },
    headers.length > 0 && h('thead', null,
      h('tr', null, ...headers.map(hd => h('th', { title: hd }, hd.trim()))),
    ),
    h('tbody', null,
      ...rows.map(row =>
        h('tr', null, ...row.map(cell => {
          const display = cell.trim() || ' ';
          return h('td', { title: cell }, display);
        })),
      ),
    ),
  );
}
