/**
 * EC output parser + renderer — turns raw EC text into colored DOM elements.
 * Detects: Result/Duration metadata, warnings, errors, pipe-separated data, tables.
 */

import { h } from '../lib/dom';

type LineType = 'result' | 'duration' | 'warning' | 'error' | 'data' | 'text';

function classifyLine(line: string): LineType {
  const trimmed = line.trimStart();
  if (trimmed.startsWith('Result : ') || trimmed.startsWith('Result: ')) return 'result';
  if (trimmed.startsWith('Duration : ') || trimmed.startsWith('Duration: ')) return 'duration';
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

/** Render EC output text into colored DOM elements.
 *  When tableMode is false, box-drawing tables are rendered as plain text. */
export function renderEcOutput(text: string, tableMode = true): HTMLElement {
  const container = h('div', { class: 'ec-output-parsed' });
  if (!text) return container;

  const lines = text.split('\n');
  let inTable = false;
  let tableRows: string[][] = [];
  let tableHeaders: string[] = [];

  for (const line of lines) {
    if (tableMode) {
      // Table detection (box-drawing characters)
      if (line.includes('╔') || line.includes('┌')) {
        inTable = true;
        tableRows = [];
        tableHeaders = [];
        continue;
      }
      if (inTable && (line.includes('╚') || line.includes('└'))) {
        inTable = false;
        if (tableHeaders.length > 0 || tableRows.length > 0) {
          container.appendChild(renderTable(tableHeaders, tableRows));
        }
        continue;
      }
      if (inTable && (line.includes('╠') || line.includes('├') || line.includes('═') || line.includes('─'))) {
        continue; // separator line
      }
      if (inTable && (line.includes('║') || line.includes('│'))) {
        const cells = line.split(/[║│]/).map(c => c.trim()).filter(c => c !== '');
        if (tableHeaders.length === 0) {
          tableHeaders = cells;
        } else {
          tableRows.push(cells);
        }
        continue;
      }
    }

    // Regular line
    const type = classifyLine(line);
    const cls = LINE_CLASSES[type];

    if (type === 'data') {
      // Pipe-separated → render as inline fields
      const parts = line.split('|||').map(p => p.trim());
      const row = h('div', { class: 'ec-out-line ec-out-data' },
        ...parts.flatMap((p, i) => i === 0
          ? [h('span', { class: 'ec-out-data-key' }, p)]
          : [h('span', { class: 'ec-out-data-sep' }, ' \u00b7 '), h('span', { class: 'ec-out-data-val' }, p)],
        ),
      );
      container.appendChild(row);
    } else {
      container.appendChild(
        h('div', { class: `ec-out-line${cls ? ' ' + cls : ''}` }, line),
      );
    }
  }

  // Flush unclosed table (partial output)
  if (inTable && (tableHeaders.length > 0 || tableRows.length > 0)) {
    container.appendChild(renderTable(tableHeaders, tableRows));
  }

  return container;
}

function renderTable(headers: string[], rows: string[][]): HTMLElement {
  return h('table', { class: 'ec-out-table' },
    headers.length > 0 && h('thead', null,
      h('tr', null, ...headers.map(hd => h('th', null, hd))),
    ),
    h('tbody', null,
      ...rows.map(row =>
        h('tr', null, ...row.map(cell => {
          const display = cell.trim() || '\u00a0';
          return h('td', { title: cell }, display);
        })),
      ),
    ),
  );
}
