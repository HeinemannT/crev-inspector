/**
 * Tests for the lightweight EC tokeniser (`tokenizeEcLine` plus its
 * `appendEcPreview` / `ecPreviewSpan` rendering wrappers).
 *
 * Three layers of assertions:
 *   1. The pure `tokenizeEcLine` returns the expected `TokKind`
 *      sequence per category (kw / ctx / bool / null / style / date /
 *      global / agg / tx / tbl / read / class / idspace / prop / expr /
 *      str / num / cmt / op).
 *   2. The tokeniser is loss-less — concatenated slices equal the input.
 *   3. `appendEcPreview` / `ecPreviewSpan` render the right DOM (span
 *      classes match, total textContent preserved).
 *
 * @vitest-environment happy-dom
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { tokenizeEcLine, appendEcPreview, ecPreviewSpan } from '../ec-format';
import type { TokKind } from '../ec-grammar';
import './chrome-mock';

/** Token kinds in order, omitting null-kinded slices for readability.
 *  The lossless test still covers the dropped slices. */
function colouredKinds(text: string): Array<TokKind> {
  return tokenizeEcLine(text).map(t => t.kind).filter((k): k is TokKind => k !== null);
}

function roundTrip(text: string): string {
  return tokenizeEcLine(text).map(t => text.slice(t.start, t.end)).join('');
}

describe('tokenizeEcLine — round-trip preservation', () => {
  it.each([
    '_v := SELECT CeRiskAssessment',
    't.foo.children(Initiative)',
    'output(_o.expression.whenMissing(""))',
    '// a comment that runs to end of line',
    '/* block */ _x := 1',
    'IF x NOT IN list THEN ENDIF',
    '_x := AGGAVG(_kpi, _list)',
    'period := 3M; offset := 1Y',
    '_o.name',
    '_o.name()',
    '_v := output(t.foo.expression).whenMissing("")',
    '_r := "Name: " + this.object.name + "\\n"',
    '_b := _a :+ "item"',
    '_o.change(name := "foo")',
  ])('reconstructs %j byte-for-byte', (text) => {
    expect(roundTrip(text)).toBe(text);
  });
});

describe('tokenizeEcLine — kind classification', () => {
  it('control keywords (IF / THEN / ENDIF) get kw', () => {
    const ks = colouredKinds('IF x THEN ENDIF');
    // x is unknown ident → null → filtered
    expect(ks).toEqual(['kw', 'kw', 'kw']);
  });

  it('context keywords (this / self) get ctx', () => {
    const ks = colouredKinds('this self');
    expect(ks).toEqual(['ctx', 'ctx']);
  });

  it('bool literals (TRUE / FALSE) get bool', () => {
    const ks = colouredKinds('TRUE FALSE');
    expect(ks).toEqual(['bool', 'bool']);
  });

  it('MISSING gets the null kind', () => {
    const ks = colouredKinds('MISSING');
    expect(ks).toEqual(['null']);
  });

  it('TODAY / BOP / EOP get date kind', () => {
    const ks = colouredKinds('TODAY BOP EOP');
    expect(ks).toEqual(['date', 'date', 'date']);
  });

  it('style constants (LEFT / RED / BOLD) get style', () => {
    const ks = colouredKinds('LEFT RED BOLD');
    expect(ks).toEqual(['style', 'style', 'style']);
  });

  it('global functions (LIST / JSON / output / when) get global', () => {
    const ks = colouredKinds('LIST JSON output when');
    expect(ks).toEqual(['global', 'global', 'global', 'global']);
  });

  it('aggregate functions (AGG / AGGAVG / PCmSUM / NOSO) get agg', () => {
    const ks = colouredKinds('AGG AGGAVG PCmSUM NOSO');
    expect(ks).toEqual(['agg', 'agg', 'agg', 'agg']);
  });

  it('SELECT + PascalCase class', () => {
    const ks = colouredKinds('_v := SELECT CeRiskAssessment');
    expect(ks).toEqual(['op', 'kw', 'class']);
  });

  it('SELECT + lowerCamel class (BMP normalises case)', () => {
    const ks = colouredKinds('_v := SELECT ceRiskAssessment');
    expect(ks).toEqual(['op', 'kw', 'class']);
  });

  it('ID-space prefix t.foo is one idspace token', () => {
    const tokens = tokenizeEcLine('t.foo');
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({ kind: 'idspace', start: 0, end: 5 });
  });

  it('ID-space prefix followed by a method chain', () => {
    const ks = colouredKinds('t.foo.children(Initiative)');
    // idspace(t.foo) · op(.) · read(children) · class(Initiative)
    expect(ks).toEqual(['idspace', 'op', 'read', 'class']);
  });

  it('bare .expression gets the expr (gotcha) tag', () => {
    const ks = colouredKinds('_o.expression');
    expect(ks).toEqual(['op', 'expr']);
  });

  it('.name (known property) gets prop', () => {
    const ks = colouredKinds('_o.name');
    expect(ks).toEqual(['op', 'prop']);
  });

  it('.size() (read method) keeps the read tag with or without parens', () => {
    expect(colouredKinds('_xs.size()')).toEqual(['op', 'read']);
    expect(colouredKinds('_xs.size')).toEqual(['op', 'read']);
  });

  it('.add (transactional method) gets tx', () => {
    const ks = colouredKinds('_o.add(Foo)');
    expect(ks).toEqual(['op', 'tx', 'class']);
  });

  it('.addColumn (table-builder method) gets tbl', () => {
    const ks = colouredKinds('_t.addColumn("h", _v)');
    expect(ks).toContain('tbl');
  });

  it(':= and :+ both get op', () => {
    expect(colouredKinds('_a := 1')).toEqual(['op', 'num']);
    expect(colouredKinds('_a :+ "x"')).toEqual(['op', 'str']);
  });

  it('NOT IN collapses into one kw token', () => {
    const text = 'x NOT IN list';
    const tokens = tokenizeEcLine(text);
    const kw = tokens.filter(t => t.kind === 'kw');
    expect(kw).toHaveLength(1);
    expect(text.slice(kw[0].start, kw[0].end)).toBe('NOT IN');
  });

  it('date duration suffix → date kind', () => {
    expect(tokenizeEcLine('3M')[0]).toMatchObject({ kind: 'date', start: 0, end: 2 });
    expect(tokenizeEcLine('1Y')[0]).toMatchObject({ kind: 'date', start: 0, end: 2 });
    expect(tokenizeEcLine('2W')[0]).toMatchObject({ kind: 'date', start: 0, end: 2 });
  });

  it('bare number stays num', () => {
    expect(tokenizeEcLine('42')[0]).toMatchObject({ kind: 'num', start: 0, end: 2 });
  });

  it('line comment is one cmt token covering the rest of the line', () => {
    const tokens = tokenizeEcLine('// hello world');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].kind).toBe('cmt');
  });

  it('block comment on one line', () => {
    const tokens = tokenizeEcLine('/* hi */');
    expect(tokens[0]).toMatchObject({ kind: 'cmt', start: 0, end: 8 });
  });

  it('unterminated block comment runs to end of line', () => {
    const tokens = tokenizeEcLine('/* no closing');
    expect(tokens[0].kind).toBe('cmt');
    expect(tokens[0].end).toBe('/* no closing'.length);
  });

  it('string literals with escaped quotes', () => {
    const tokens = tokenizeEcLine('"hello \\"world\\""');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].kind).toBe('str');
  });
});

describe('tokenizeEcLine — null / boundary', () => {
  it('empty input → no tokens', () => {
    expect(tokenizeEcLine('')).toHaveLength(0);
  });

  it('whitespace-only input → one null-kinded slice', () => {
    const tokens = tokenizeEcLine('   ');
    expect(tokens).toHaveLength(1);
    expect(tokens[0].kind).toBeNull();
  });

  it('punctuation preserved as plain', () => {
    expect(roundTrip('(a, b, c)')).toBe('(a, b, c)');
  });
});

describe('appendEcPreview / ecPreviewSpan — rendering', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('appendEcPreview emits a span per coloured kind + text node for plain', () => {
    const div = document.createElement('div');
    appendEcPreview(div, 'IF x THEN');
    // 'IF' → span.ec-tok-kw, ' ' → text, 'x' → text, ' ' → text, 'THEN' → span.ec-tok-kw
    expect(div.textContent).toBe('IF x THEN');
    const kwSpans = div.querySelectorAll('.ec-tok-kw');
    expect(kwSpans).toHaveLength(2);
  });

  it('total textContent preserved end-to-end', () => {
    const div = document.createElement('div');
    appendEcPreview(div, '_o.change(name := "foo")');
    expect(div.textContent).toBe('_o.change(name := "foo")');
  });

  it('ecPreviewSpan returns a div with merged classes', () => {
    const el = ecPreviewSpan('IF x THEN', 'flow-code-preview mono');
    expect(el.tagName).toBe('DIV');
    expect(el.className).toContain('ec-preview');
    expect(el.className).toContain('flow-code-preview');
    expect(el.className).toContain('mono');
  });
});
