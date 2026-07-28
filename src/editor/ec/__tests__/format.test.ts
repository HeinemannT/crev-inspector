import { describe, expect, it } from 'vitest'
import { formatExtendedCode } from '../format'

const format = (source: string, width?: number): string => formatExtendedCode(source, width).code

describe('compact Extended Code formatter', () => {
  it('flattens an ELSE-only nested IF chain and compacts adjacent closers', () => {
    const source = `IF _a THEN
"A"
ELSE
IF _b THEN
"B"
ELSE
"C"
ENDIF
ENDIF`
    expect(format(source)).toBe(`IF _a THEN
     "A"
ELSE IF _b THEN
     "B"
ELSE
     "C"
ENDIF ENDIF`)
  })

  it('keeps a short nested value expression inline', () => {
    const source = '_label := (IF _a THEN "A" ELSE (IF _b THEN "B" ELSE "C" ENDIF) ENDIF)'
    expect(format(source)).toBe(source)
  })

  it('compacts a short SELECT and wraps a long SELECT once before WHERE', () => {
    expect(format(`_items := SELECT Organisation
FROM root.organisation
WHERE active = TRUE`)).toBe('_items := SELECT Organisation FROM root.organisation WHERE active = TRUE')

    const long = '_items := SELECT Organisation FROM root.organisation WHERE name = "*risk*" AND active = TRUE AND owner != MISSING'
    expect(format(long, 80)).toBe(`_items := SELECT Organisation FROM root.organisation
     WHERE name = "*risk*" AND active = TRUE AND owner != MISSING`)
  })

  it('compacts short method chains', () => {
    const source = `root.organisation.descendants()
.filter(name = "*risk*" AND active = TRUE)
.sort(name)
.first(20)`
    expect(format(source)).toBe('root.organisation.descendants() .filter(name = "*risk*" AND active = TRUE) .sort(name) .first(20)')
  })

  it('wraps long method chains at top-level method boundaries', () => {
    const source = 'root.organisation.descendants().filter(name = "*risk*" AND active = TRUE).sort(name).first(20)'
    const expected = `root.organisation.descendants()
     .filter(name = "*risk*" AND active = TRUE)
     .sort(name)
     .first(20)`
    expect(format(source, 70)).toBe(expected)
    expect(format(expected, 70)).toBe(expected)
  })

  it('compacts short change, LIST, and MAP argument blocks', () => {
    expect(format(`_o.change(
name := "Risk overview",
card := t.card_navigation
)`)).toBe('_o.change(name := "Risk overview", card := t.card_navigation)')
    expect(format(`_values := LIST(
t.first,
t.second,
t.third
)`)).toBe('_values := LIST(t.first, t.second, t.third)')
    expect(format(`_totals := MAP(
"Q1"; LIST(10, 20),
"Q2"; LIST(15, 25)
    )`)).toBe('_totals := MAP("Q1"; LIST(10, 20), "Q2"; LIST(15, 25))')
  })

  it('does not collapse parenthesized statement blocks without separators', () => {
    const source = `(
_first := 1
_second := 2
)`
    expect(format(source)).toBe(`(
     _first := 1
     _second := 2
)`)
  })

  it('wraps long comma-delimited calls and collections', () => {
    const change = '_o.change(name := "Risk overview with a long title", description := "Detailed risk overview", card := t.card_navigation)'
    const expectedChange = `_o.change(
     name := "Risk overview with a long title",
     description := "Detailed risk overview",
     card := t.card_navigation
)`
    expect(format(change, 70)).toBe(expectedChange)
    expect(format(expectedChange, 70)).toBe(expectedChange)

    const values = '_values := LIST(t.first_long_reference, t.second_long_reference, t.third_long_reference)'
    const expectedValues = `_values := LIST(
     t.first_long_reference,
     t.second_long_reference,
     t.third_long_reference
)`
    expect(format(values, 60)).toBe(expectedValues)
    expect(format(expectedValues, 60)).toBe(expectedValues)
  })

  it('wraps nested long calls fully in one idempotent pass', () => {
    const source = '_value := outer(first_long_reference, inner(second_long_reference, third_long_reference, fourth_long_reference))'
    const expected = `_value := outer(
     first_long_reference,
     inner(
          second_long_reference,
          third_long_reference,
          fourth_long_reference
     )
)`
    expect(format(source, 55)).toBe(expected)
    expect(format(expected, 55)).toBe(expected)
  })

  it('does not treat method calls inside brackets as top-level chain boundaries', () => {
    const source = '_value := _items[_factory.make().withValue()].resolve().asText()'
    expect(format(source, 40)).toBe(`_value := _items[_factory.make().withValue()].resolve()
     .asText()`)
  })

  it('wraps long SELECT conditions at clause boundaries', () => {
    const source = '_items := SELECT Organisation FROM root.organisation WHERE name = "*risk*" AND active = TRUE AND owner != MISSING ORDER BY name'
    const expected = `_items := SELECT Organisation FROM root.organisation
     WHERE name = "*risk*" AND active = TRUE AND owner != MISSING
     ORDER BY name`
    expect(format(source, 70)).toBe(expected)
    expect(format(expected, 70)).toBe(expected)
  })

  it('preserves JSON and comment contents', () => {
    const source = `_data := JSON("[{\\"id\\":\\"A ( B\\",\\"active\\":true}]")
// keep ( this JSON-looking comment exactly
_data`
    expect(format(source)).toBe(source)
  })

  it('indents forEach bodies without compacting callback statements', () => {
    const source = `_items.forEach(_item:
_name := _item.name
IF _name != "" THEN
output(_name)
ENDIF
)`
    expect(format(source)).toBe(`_items.forEach(_item:
     _name := _item.name
     IF _name != "" THEN
          output(_name)
     ENDIF
)`)
  })

  it('is idempotent for representative valid EC', () => {
    const source = `IF _a THEN
     _o.change(name := "A", card := t.card_navigation)
ELSE IF _b THEN
     _items := SELECT Organisation FROM root.organisation WHERE active = TRUE
ELSE
     _items := LIST(t.first, t.second)
ENDIF ENDIF`
    const once = format(source)
    expect(format(once)).toBe(once)
  })

  it('returns incomplete code untouched', () => {
    const source = 'IF _a THEN\n     output("unterminated)'
    expect(formatExtendedCode(source)).toEqual({ code: source, changed: false, safe: false })
  })

  it.each([
    'IF _a THEN\nELSE\nELSE\nENDIF',
    'IF _a THEN THEN\nENDIF',
    'IF _a ELSE\nENDIF',
    '_value := ([)]',
    '_value := {]',
  ])('returns structurally unsafe code untouched: %s', source => {
    expect(formatExtendedCode(source)).toEqual({ code: source, changed: false, safe: false })
  })

  it('leaves multiline lexical regions untouched rather than guessing their structure', () => {
    const source = '/* IF fake THEN\n   still a comment\n*/\noutput("safe")'
    expect(formatExtendedCode(source)).toEqual({ code: source, changed: false, safe: false })
  })
})
