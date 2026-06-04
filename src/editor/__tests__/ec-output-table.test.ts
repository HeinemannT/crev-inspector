/**
 * Stress tests for the box-drawing → HTML table normalization in
 * `ec-output.ts`.
 *
 * Motivation: BMP renders calc-table results as a monospace box-drawing
 * grid whose columns only line up in BMP's own font. In the extension's
 * font the raw ASCII looks misaligned, so the output panel normalizes it
 * into a real HTML <table> (font-independent). The old normalizer used
 * `.filter(c => c !== '')`, which collapsed SPARSE rows (e.g. the
 * `demo_table` hierarchy) leftward and destroyed column alignment. The
 * fix keeps interior empty cells via `splitTableRow`.
 *
 * @vitest-environment happy-dom
 */
import { describe, it, expect } from 'vitest';
import { splitTableRow, renderEcOutput, ecOutputToText, parseEcOutput, parseBmpDurationMs, formatRunTiming } from '../ec-output';

// ── splitTableRow (pure) ───────────────────────────────────────────

describe('splitTableRow', () => {
  it('drops the outer border fragments, keeps interior cells', () => {
    expect(splitTableRow('║ a │ b │ c ║')).toEqual([' a ', ' b ', ' c ']);
  });

  it('PRESERVES empty interior cells (the core fix)', () => {
    // demo_table L1: cols 0–1 empty, risk in 2–3, control cols empty.
    const cells = splitTableRow('║   │   │ risk │ rid │   │   ║');
    expect(cells).toHaveLength(6);
    expect(cells.map(c => c.trim())).toEqual(['', '', 'risk', 'rid', '', '']);
  });

  it('sparse rows keep the SAME cell count as a dense header', () => {
    const header = splitTableRow('║ name │ id │ risk name │ risk id │ control name │ control id ║');
    const l0 = splitTableRow('║ Ransomware ↔ EDR │ mit_x │   │   │   │   ║');
    const l1 = splitTableRow('║   │   │ Ransomware @ Apex │ loc_x │   │   ║');
    const l2 = splitTableRow('║   │   │   │   │ EDR — London │ cloc_x ║');
    expect(header).toHaveLength(6);
    expect(l0).toHaveLength(6);
    expect(l1).toHaveLength(6);
    expect(l2).toHaveLength(6);
  });

  it('handles ASCII │-bordered tables too', () => {
    expect(splitTableRow('│ a │ b │').map(c => c.trim())).toEqual(['a', 'b']);
  });

  it('does NOT drop real content when a border is missing (defensive)', () => {
    // No leading ║ — first fragment is real content, must survive.
    expect(splitTableRow('a │ b ║').map(c => c.trim())).toEqual(['a', 'b']);
    expect(splitTableRow('║ a │ b').map(c => c.trim())).toEqual(['a', 'b']);
  });

  it('does NOT split on a literal ASCII pipe inside a value', () => {
    // ASCII | (U+007C) is not a box char; "a|b" stays one cell.
    const cells = splitTableRow('║ a|b │ c ║');
    expect(cells.map(c => c.trim())).toEqual(['a|b', 'c']);
  });

  it('preserves unicode content verbatim', () => {
    expect(splitTableRow('║ Ransomware (UK-LON) ↔ EDR — x │ id ║').map(c => c.trim()))
      .toEqual(['Ransomware (UK-LON) ↔ EDR — x', 'id']);
  });

  it('degenerate inputs do not throw', () => {
    expect(splitTableRow('')).toEqual(['']);
    expect(splitTableRow('║║').map(c => c.trim())).toEqual(['']);
    expect(splitTableRow('no borders here')).toEqual(['no borders here']);
  });
});

// ── renderEcOutput → HTML table (DOM) ──────────────────────────────

/** The exact hierarchical shape of demo_table's output. */
const DEMO_TABLE = [
  'Message : Result : ',
  '╔══════════════════╤═════════╤═══════════════════╤═════════╤═══════════════╤═══════════╗',
  '║ name             │ id      │ risk name         │ risk id │ control name  │ control id║',
  '╠══════════════════╪═════════╪═══════════════════╪═════════╪═══════════════╪═══════════╣',
  '║ Ransomware ↔ EDR │ mit_x   │                   │         │               │           ║',
  '╟──────────────────┼─────────┼───────────────────┼─────────┼───────────────┼───────────╢',
  '║                  │         │ Ransomware @ Apex │ loc_x   │               │           ║',
  '╟──────────────────┼─────────┼───────────────────┼─────────┼───────────────┼───────────╢',
  '║                  │         │                   │         │ EDR — London  │ cloc_x    ║',
  '╚══════════════════╧═════════╧═══════════════════╧═════════╧═══════════════╧═══════════╝',
  'Message : Duration : 14ms',
].join('\n');

describe('renderEcOutput — demo_table hierarchy', () => {
  it('renders exactly one HTML table with 6 columns', () => {
    const el = renderEcOutput(DEMO_TABLE);
    const tables = el.querySelectorAll('table.ec-out-table');
    expect(tables).toHaveLength(1);
    expect(tables[0].querySelectorAll('thead th')).toHaveLength(6);
    expect([...tables[0].querySelectorAll('thead th')].map(t => t.textContent))
      .toEqual(['name', 'id', 'risk name', 'risk id', 'control name', 'control id']);
  });

  it('every data row keeps all 6 columns (no leftward collapse)', () => {
    const el = renderEcOutput(DEMO_TABLE);
    const rows = el.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.querySelectorAll('td')).toHaveLength(6);
  });

  it('each hierarchy level lands in its OWN columns', () => {
    const el = renderEcOutput(DEMO_TABLE);
    const rows = [...el.querySelectorAll('tbody tr')].map(r =>
      [...r.querySelectorAll('td')].map(td => td.textContent!.replace(' ', '').trim()));
    // L0 mitigation → cols 0–1
    expect(rows[0]).toEqual(['Ransomware ↔ EDR', 'mit_x', '', '', '', '']);
    // L1 risk → cols 2–3  (THIS is what the old code broke)
    expect(rows[1]).toEqual(['', '', 'Ransomware @ Apex', 'loc_x', '', '']);
    // L2 control → cols 4–5
    expect(rows[2]).toEqual(['', '', '', '', 'EDR — London', 'cloc_x']);
  });

  it('empty cells render as nbsp, not omitted', () => {
    const el = renderEcOutput(DEMO_TABLE);
    const firstRowCells = [...el.querySelectorAll('tbody tr')][0].querySelectorAll('td');
    expect(firstRowCells[2].textContent).toBe(' ');
  });

  it('keeps the raw padded cell as the title tooltip', () => {
    const el = renderEcOutput(DEMO_TABLE);
    const td0 = el.querySelectorAll('tbody tr')[0].querySelectorAll('td')[0];
    expect(td0.getAttribute('title')).toContain('Ransomware ↔ EDR');
    expect(td0.textContent).toBe('Ransomware ↔ EDR'); // display trimmed
  });

  it('still renders the surrounding metadata lines (not swallowed by the table)', () => {
    // Real BMP prefixes these with "Message : ", so they render as plain
    // text lines — the point is the table extraction doesn't eat them.
    const el = renderEcOutput(DEMO_TABLE);
    const text = el.textContent ?? '';
    expect(text).toContain('Duration : 14ms');
    expect(text).toContain('Result :');
  });
});

describe('renderEcOutput — regressions & edges', () => {
  it('dense tables are unaffected', () => {
    const dense = ['╔═╤═╗', '║ a │ b ║', '╠═╪═╣', '║ 1 │ 2 ║', '╚═╧═╝'].join('\n');
    const el = renderEcOutput(dense);
    const row = el.querySelectorAll('tbody tr')[0].querySelectorAll('td');
    expect([...row].map(td => td.textContent)).toEqual(['1', '2']);
  });

  it('pipe (|||) data lines still render as inline fields', () => {
    const el = renderEcOutput('foo ||| bar ||| baz');
    expect(el.querySelector('.ec-out-data')).not.toBeNull();
    expect(el.querySelector('.ec-out-data-key')!.textContent).toBe('foo');
  });

  it('non-table text renders as plain lines', () => {
    const el = renderEcOutput('just some text\nsecond line');
    expect(el.querySelectorAll('.ec-out-line').length).toBe(2);
    expect(el.querySelector('table')).toBeNull();
  });

  it('renders multiple tables in one output', () => {
    const t = ['╔═╗', '║ a ║', '╚═╝'].join('\n');
    const el = renderEcOutput(t + '\nbetween\n' + t);
    expect(el.querySelectorAll('table.ec-out-table')).toHaveLength(2);
  });

  it('flushes an unclosed (truncated) table', () => {
    const partial = ['╔═╤═╗', '║ a │ b ║', '╠═╪═╣', '║ 1 │ 2 ║'].join('\n'); // no ╚ footer
    const el = renderEcOutput(partial);
    expect(el.querySelectorAll('table.ec-out-table')).toHaveLength(1);
    expect(el.querySelectorAll('tbody tr')).toHaveLength(1);
  });

  it('tableMode=false leaves the raw ASCII as text (font-dependent fallback)', () => {
    const el = renderEcOutput(DEMO_TABLE, false);
    expect(el.querySelector('table')).toBeNull();
    expect(el.querySelectorAll('.ec-out-line').length).toBeGreaterThan(5);
  });

  it('empty / whitespace input does not throw', () => {
    expect(() => renderEcOutput('')).not.toThrow();
    expect(() => renderEcOutput('\n\n')).not.toThrow();
    expect(renderEcOutput('').querySelector('table')).toBeNull();
  });

  it('stress: a 500-row sparse table renders every row with full width', () => {
    const lines = ['╔═╤═╤═╗', '║ a │ b │ c ║', '╠═╪═╪═╣'];
    for (let i = 0; i < 500; i++) {
      // alternate which column is populated to exercise sparse paths
      lines.push(i % 2 === 0 ? `║ v${i} │   │   ║` : `║   │   │ v${i} ║`);
    }
    lines.push('╚═╧═╧═╝');
    const el = renderEcOutput(lines.join('\n'));
    const rows = el.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(500);
    for (const r of rows) expect(r.querySelectorAll('td')).toHaveLength(3);
    // spot-check a sparse row keeps its value in the right column
    const last = rows[499].querySelectorAll('td');
    expect([...last].map(td => td.textContent!.replace(' ', '').trim()))
      .toEqual(['', '', 'v499']);
  });
});

// ── raw fallback (tableMode off) ───────────────────────────────────

describe('renderEcOutput — raw fallback no-wrap', () => {
  it('box-drawing rows get ec-out-raw (white-space:pre) when tableMode is off', () => {
    const el = renderEcOutput(DEMO_TABLE, false);
    const raw = el.querySelectorAll('.ec-out-raw');
    expect(raw.length).toBeGreaterThan(0);
    // every raw line is still a normal output line
    for (const r of raw) expect(r.classList.contains('ec-out-line')).toBe(true);
  });

  it('plain text lines do NOT get ec-out-raw', () => {
    const el = renderEcOutput('just text\nanother line', false);
    expect(el.querySelectorAll('.ec-out-raw').length).toBe(0);
  });

  it('with tableMode ON, box rows are consumed by the table (no raw lines)', () => {
    const el = renderEcOutput(DEMO_TABLE, true);
    expect(el.querySelectorAll('.ec-out-raw').length).toBe(0);
  });
});

// ── ecOutputToText (clipboard) ─────────────────────────────────────

describe('ecOutputToText — clipboard serialization', () => {
  it('serializes a table to TAB-separated rows', () => {
    const tsv = ecOutputToText(DEMO_TABLE);
    const tableLines = tsv.split('\n').filter(l => l.includes('\t'));
    expect(tableLines[0]).toBe('name\tid\trisk name\trisk id\tcontrol name\tcontrol id');
    // L1 risk row: empty fields preserved as empty TSV columns
    expect(tableLines).toContain('\t\tRansomware @ Apex\tloc_x\t\t');
  });

  it('every TSV data row has the same column count as the header', () => {
    const tsv = ecOutputToText(DEMO_TABLE);
    const tableLines = tsv.split('\n').filter(l => l.includes('\t'));
    const cols = tableLines.map(l => l.split('\t').length);
    expect(new Set(cols).size).toBe(1); // all rows identical width
    expect(cols[0]).toBe(6);
  });

  it('keeps surrounding non-table lines verbatim', () => {
    const tsv = ecOutputToText(DEMO_TABLE);
    expect(tsv).toContain('Message : Duration : 14ms');
  });

  it('tableMode off → raw box-drawing lines copied verbatim (no tabs)', () => {
    const tsv = ecOutputToText(DEMO_TABLE, false);
    expect(tsv).toContain('║');
    expect(tsv.split('\n').some(l => l.includes('\t'))).toBe(false);
  });

  it('honours the decode toggle', () => {
    expect(ecOutputToText('a\\nb', true, true)).toBe('a\nb');
    expect(ecOutputToText('a\\nb', true, false)).toBe('a\\nb');
  });

  it('|||  data lines are kept as-is (not tabbed)', () => {
    expect(ecOutputToText('foo ||| bar')).toBe('foo ||| bar');
  });

  it('empty input → empty string', () => {
    expect(ecOutputToText('')).toBe('');
  });
});

// ── parseEcOutput (shared parser) ──────────────────────────────────

describe('parseEcOutput — block model', () => {
  it('emits one table block + surrounding line blocks in order', () => {
    const blocks = parseEcOutput(DEMO_TABLE);
    const kinds = blocks.map(b => b.kind);
    expect(kinds.filter(k => k === 'table')).toHaveLength(1);
    expect(blocks[0].kind).toBe('line'); // "Message : Result :" line
    const tableIdx = blocks.findIndex(b => b.kind === 'table');
    expect(tableIdx).toBeGreaterThan(0);
    expect(tableIdx).toBeLessThan(blocks.length - 1);
  });

  it('tableMode off → no table blocks, all lines', () => {
    const blocks = parseEcOutput(DEMO_TABLE, false);
    expect(blocks.every(b => b.kind === 'line')).toBe(true);
  });

  it('render and copy agree on table count (shared parser, no drift)', () => {
    const el = renderEcOutput(DEMO_TABLE);
    const domTables = el.querySelectorAll('table.ec-out-table').length;
    const parsedTables = parseEcOutput(DEMO_TABLE).filter(b => b.kind === 'table').length;
    expect(domTables).toBe(parsedTables);
  });

  it('strips the bare "Duration : Nms" line — it lives in the output pill now', () => {
    const blocks = parseEcOutput('hello\nResult : 0\nDuration : 59ms');
    const lines = blocks.filter(b => b.kind === 'line').map(b => (b as { text: string }).text);
    expect(lines).toContain('hello');
    expect(lines).toContain('Result : 0'); // other meta stays
    expect(lines.some(l => l.startsWith('Duration'))).toBe(false);
  });

  it('strips a Duration line with odd whitespace padding (agrees with parseBmpDurationMs)', () => {
    const blocks = parseEcOutput('hello\nDuration  :  59ms');
    const lines = blocks.filter(b => b.kind === 'line').map(b => (b as { text: string }).text);
    expect(lines).toContain('hello');
    expect(lines.some(l => /Duration/.test(l))).toBe(false);
  });

  it('keeps a "Duration"-bearing line that is not pure metadata', () => {
    // "Message : Duration : 14ms" is a text line, not the meta footer.
    const blocks = parseEcOutput('Message : Duration : 14ms');
    expect((blocks[0] as { text: string }).text).toBe('Message : Duration : 14ms');
  });
});

describe('parseBmpDurationMs', () => {
  it('extracts BMP compute ms from the Duration footer', () => {
    expect(parseBmpDurationMs('Result : 0\nDuration : 59ms')).toBe(59);
    expect(parseBmpDurationMs('Duration: 3ms')).toBe(3); // no space variant
    expect(parseBmpDurationMs('   Duration : 120ms  ')).toBe(120); // indented
  });

  it('returns 0 for a present-but-non-numeric footer (BMP "no time" = sub-ms)', () => {
    expect(parseBmpDurationMs('probe\nDuration : no time')).toBe(0);
  });

  it('returns null when absent or not the metadata line', () => {
    expect(parseBmpDurationMs('hello world')).toBe(null);
    expect(parseBmpDurationMs('')).toBe(null);
    expect(parseBmpDurationMs('Message : Duration : 14ms')).toBe(null);
  });
});

describe('formatRunTiming', () => {
  it('shows RTT + BMP compute when BMP reported a time', () => {
    const t = formatRunTiming(648, 2);
    expect(t.text).toBe('648ms RTT · 2ms BMP');
    expect(t.title).toBe('648ms round-trip (RTT) · 2ms BMP compute');
  });

  it('renders a sub-millisecond BMP run as <1ms', () => {
    const t = formatRunTiming(362, 0);
    expect(t.text).toBe('362ms RTT · <1ms BMP');
    expect(t.title).toContain('sub-millisecond');
  });

  it('drops the RTT label when there is no BMP figure to contrast', () => {
    const t = formatRunTiming(120, null);
    expect(t.text).toBe('120ms');
    expect(t.title).toBe('120ms round-trip (RTT)');
  });
});
