/**
 * Tests for the AI chat tab's escape-safe markdown renderer — block splitting
 * (fences, incl. an unterminated mid-stream fence), the pipe-table support
 * added for chat replies, inline spans, and DOM-level escaping.
 *
 * @vitest-environment happy-dom
 */
import { describe, it, expect } from 'vitest';
import { renderMarkdown, splitBlocks, isTableSeparator, splitTableRow } from '../ai-markdown';
import { h } from '../../../lib/dom';

function renderInto(text: string): HTMLElement {
  const el = document.createElement('div');
  renderMarkdown(el, text, {
    codeBlock: (lang, code) => h('pre', { class: 'test-code', 'data-lang': lang }, code),
  });
  return el;
}

describe('splitBlocks', () => {
  it('splits prose and fenced code, keeping the fence language', () => {
    const blocks = splitBlocks('hello\n```extended\noutput(1)\n```\nbye');
    expect(blocks).toEqual([
      { kind: 'text', lines: ['hello'] },
      { kind: 'code', lang: 'extended', code: 'output(1)' },
      { kind: 'text', lines: ['bye'] },
    ]);
  });

  it('treats an unterminated trailing fence as code (mid-stream rendering)', () => {
    const blocks = splitBlocks('para\n```js\nconst x = 1');
    expect(blocks[1]).toEqual({ kind: 'code', lang: 'js', code: 'const x = 1' });
  });

  it('drops whitespace-only text blocks', () => {
    expect(splitBlocks('```\na\n```\n\n  \n')).toEqual([{ kind: 'code', lang: '', code: 'a' }]);
  });
});

describe('table separator + row parsing', () => {
  it('recognises separator rows with and without edge pipes / alignment colons', () => {
    expect(isTableSeparator('|---|---|')).toBe(true);
    expect(isTableSeparator('| :--- | ---: |')).toBe(true);
    expect(isTableSeparator('--- | ---')).toBe(true);
    expect(isTableSeparator('| a | b |')).toBe(false);
    expect(isTableSeparator('plain text - with | pipe')).toBe(false);
  });

  it('splits rows tolerating optional edge pipes', () => {
    expect(splitTableRow('| a | b |')).toEqual(['a', 'b']);
    expect(splitTableRow('a | b')).toEqual(['a', 'b']);
  });
});

describe('renderMarkdown tables', () => {
  const md = [
    'Here are the rows:',
    '',
    '| Property | Type | Value |',
    '|---|---|---|',
    '| `impact_1` | Number | Insignificant |',
    '| `impact_2` | Number | Minor |',
    '',
    'Done.',
  ].join('\n');

  it('renders a zebra table with header + body rows', () => {
    const el = renderInto(md);
    const table = el.querySelector('table.ai-md-table')!;
    expect(table).toBeTruthy();
    expect(table.querySelectorAll('th')).toHaveLength(3);
    // 1 header row + 2 body rows
    expect(table.querySelectorAll('tr')).toHaveLength(3);
    expect(table.querySelectorAll('th')[0].textContent).toBe('Property');
    // Inline code inside a cell survives
    expect(table.querySelector('td code')?.textContent).toBe('impact_1');
  });

  it('keeps surrounding prose out of the table', () => {
    const el = renderInto(md);
    const prose = [...el.querySelectorAll('.ai-prose')].map(p => p.textContent);
    expect(prose).toEqual(['Here are the rows:', 'Done.']);
  });

  it('does not build a table without a separator row', () => {
    const el = renderInto('a | b\nc | d');
    expect(el.querySelector('table')).toBeNull();
  });

  it('stops the table at the first non-row line', () => {
    const el = renderInto('| a | b |\n|---|---|\n| 1 | 2 |\nplain after');
    expect(el.querySelectorAll('tr')).toHaveLength(2);
    expect(el.textContent).toContain('plain after');
  });
});

describe('renderMarkdown inline + escaping', () => {
  it('renders headings, bold, and inline code', () => {
    const el = renderInto('## Title\nSome **bold** and `code` here');
    expect(el.querySelector('.ai-head--2')?.textContent).toBe('Title');
    expect(el.querySelector('strong')?.textContent).toBe('bold');
    expect(el.querySelector('code')?.textContent).toBe('code');
  });

  it('escapes HTML in prose, cells, and code blocks (no element injection)', () => {
    const el = renderInto('<img src=x onerror=alert(1)>\n\n| h |\n|---|\n| <b>x</b> |\n\n```\n<script>evil()</script>\n```');
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('td b')).toBeNull();
    expect(el.querySelector('script')).toBeNull();
    expect(el.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(el.querySelector('td')?.textContent).toBe('<b>x</b>');
  });

  it('delegates fenced blocks to the caller with the language tag', () => {
    const el = renderInto('```extended\noutput(t.x.name)\n```');
    const pre = el.querySelector('pre.test-code')!;
    expect(pre.getAttribute('data-lang')).toBe('extended');
    expect(pre.textContent).toBe('output(t.x.name)');
  });
});
