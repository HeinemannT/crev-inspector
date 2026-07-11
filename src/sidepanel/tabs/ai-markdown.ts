/**
 * Escape-safe markdown renderer for the AI chat tab. Extends the minimal
 * renderer that ai-assist.ts used for the (now-retired) Ask answer panel:
 * headings, **bold**, inline `code`, fenced code blocks, PLUS simple pipe
 * tables. No external dependency — every value is emitted as a DOM text node
 * or element, so it is escaped by construction.
 *
 * Fenced code blocks are delegated to the caller via `opts.codeBlock` so the
 * chat tab can weld its own header (language label + Apply / Preview / Copy)
 * and result strip onto each block. Everything else (prose, headings, tables)
 * is rendered here.
 */

import { h } from '../../lib/dom';

export interface MarkdownOptions {
  /** Build the element for one fenced code block. `lang` may be ''. */
  codeBlock: (lang: string, code: string) => HTMLElement;
}

export type MdBlock =
  | { kind: 'code'; lang: string; code: string }
  | { kind: 'text'; lines: string[] };

/** Split markdown into fenced-code blocks and interleaved text blocks. An
 *  unterminated trailing fence (mid-stream) is still surfaced as a code block
 *  so it renders monospaced while the answer is still streaming. Exported for
 *  tests. */
export function splitBlocks(text: string): MdBlock[] {
  const out: MdBlock[] = [];
  let inCode = false;
  let lang = '';
  let buf: string[] = [];
  const flushText = () => {
    if (buf.some(l => l.trim() !== '')) out.push({ kind: 'text', lines: buf });
    buf = [];
  };
  const flushCode = () => {
    out.push({ kind: 'code', lang, code: buf.join('\n').replace(/\n$/, '') });
    buf = [];
    lang = '';
  };
  for (const line of text.split('\n')) {
    if (line.startsWith('```')) {
      if (inCode) { flushCode(); inCode = false; }
      else { flushText(); inCode = true; lang = line.slice(3).trim(); }
      continue;
    }
    buf.push(line);
  }
  if (inCode) flushCode(); else flushText();
  return out;
}

/** True for a table separator row like `|---|:--:|` (the line under the
 *  header). Requires at least one pipe so a plain `---` horizontal rule never
 *  matches; single-column tables (`|---|`) do. */
export function isTableSeparator(line: string): boolean {
  const s = line.trim();
  if (!s.includes('-') || !s.includes('|')) return false;
  return /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(s);
}

/** Split one table row into trimmed cells, tolerating optional edge pipes. */
export function splitTableRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map(c => c.trim());
}

/** A plain line looks like a table row when it contains an unescaped pipe. */
function looksLikeRow(line: string): boolean {
  return line.includes('|') && line.trim() !== '';
}

/** Render the full markdown string into `container`, replacing its contents. */
export function renderMarkdown(container: HTMLElement, text: string, opts: MarkdownOptions): void {
  container.textContent = '';
  for (const block of splitBlocks(text)) {
    if (block.kind === 'code') {
      container.appendChild(opts.codeBlock(block.lang, block.code));
    } else {
      renderTextBlock(container, block.lines);
    }
  }
}

/** Render a text block: headings, pipe tables, and paragraphs (with inline
 *  spans). Paragraphs accumulate until a blank line or a structural element. */
function renderTextBlock(container: HTMLElement, lines: string[]): void {
  let para: string[] = [];
  const flushPara = () => {
    if (!para.length) return;
    const div = h('div', { class: 'ai-prose' });
    renderInline(div, para.join('\n'));
    container.appendChild(div);
    para = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Blank line closes a paragraph.
    if (line.trim() === '') { flushPara(); continue; }

    // Heading (# / ## / ###).
    const head = /^(#{1,3})\s+(.*)$/.exec(line);
    if (head) {
      flushPara();
      const el = h('div', { class: `ai-head ai-head--${head[1].length}` });
      renderInline(el, head[2]);
      container.appendChild(el);
      continue;
    }

    // Table: a header row immediately followed by a separator row.
    if (looksLikeRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
      flushPara();
      const header = splitTableRow(line);
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && looksLikeRow(lines[j]) && !isTableSeparator(lines[j])) {
        rows.push(splitTableRow(lines[j]));
        j++;
      }
      container.appendChild(buildTable(header, rows));
      i = j - 1;
      continue;
    }

    para.push(line);
  }
  flushPara();
}

/** Build a zebra-striped markdown table element. */
function buildTable(header: string[], rows: string[][]): HTMLElement {
  const thead = h('tr', null, ...header.map(cell => {
    const th = h('th');
    renderInline(th, cell);
    return th;
  }));
  const body = rows.map(cells => h('tr', null, ...cells.map(cell => {
    const td = h('td');
    renderInline(td, cell);
    return td;
  })));
  return h('table', { class: 'ai-md-table' }, thead, ...body);
}

/** Inline spans: `code` (literal) first, then **bold**. Code is matched first
 *  so bold markers inside a code span stay literal. Everything lands as text
 *  nodes / elements — escaped by construction. */
function renderInline(el: HTMLElement, text: string): void {
  for (const part of text.split(/(`[^`]+`)/g)) {
    if (part.length > 1 && part.startsWith('`') && part.endsWith('`')) {
      el.appendChild(h('code', { class: 'ai-inline-code' }, part.slice(1, -1)));
    } else if (part) {
      renderBold(el, part);
    }
  }
}

function renderBold(el: HTMLElement, text: string): void {
  for (const part of text.split(/(\*\*[^*]+\*\*)/g)) {
    if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) {
      el.appendChild(h('strong', null, part.slice(2, -2)));
    } else if (part) {
      el.appendChild(document.createTextNode(part));
    }
  }
}
