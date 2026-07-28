# Extended Code (EC) — the rules

EC is Corporater BMP's own language. It is NOT JavaScript, NOT Python, NOT SQL.
Do not fill gaps with syntax from those languages — it parses wrong or fails
silently. Every method and pattern below was verified against a live BMP
5.6.10.0 workspace. If a method is not listed as existing, assume it does NOT
exist.

## HARD NO-GO — these do not exist in EC (they are JavaScript/Python)

All of the following were verified to FAIL on live BMP. Never emit them.

Parse errors (`Encountered "("` / `Encountered ":"` etc.):
- `.upper()` `.lower()` `.toUpper()` `.toLower()` `.toUpperCase()`
  `.toLowerCase()` — NO case conversion method exists at all
- `.replace()` `.trim()` `.slice()` `.length()` `.toString()`
- Lambda/arrow callbacks: `list.filter(_x: cond)` and `list.filter(_x => cond)`
  → `Encountered ":"` / `Encountered ">"`. `filter()` takes a BARE condition,
  never an iterator variable: `list.filter(name = "*risk*")`.
- `list.map(_x: expr)` `list.reduce(...)` `forEach(_x => ...)` — forEach uses a
  COLON: `list.forEach(_x: ...)`
- `cond ? a : b` (ternary) — use `(IF cond THEN a ELSE b ENDIF)`
- `==` `===` `&&` `||` — use `=` `AND` `OR`
- `x = value` for assignment — assignment is `:=`
- `_list :+ item` — the documented `:+` append operator is a PARSE ERROR on
  5.6.10.0 in every form. Append with `_list := _list.union(LIST(item))`.
- `NOT cond` — general negation does not exist (`IF NOT _x.isMissing() THEN`
  is a parse error). Only `NOT IN` and `NOT CONTAINS` exist. Negate with
  `!=`, `= FALSE`, or `.isMissing()`.
- `_map.keys()` / `_map.values()` — MAPs support only `.get(key)`, `.size()`
  and aggregate/table methods. To enumerate group keys, go back to the list:
  `list.as(prop).distinct()`.

Runtime errors (`wrong number of arguments: 0 expected: 1`):
- `.split(",")` `.contains(s)` `.startsWith(s)` `.endsWith(s)` — parse but
  always throw at runtime

SILENT traps — no error, just a wrong result plus a "Missing value" warning:
- `.includes()` `.match()` `.find()` `.push()` — evaluate to garbage
- `null` / `None` / `undefined` — treated as an unknown name → MISSING. The
  null value is `MISSING`.
- `"string" CONTAINS "sub"` → silently `false`. CONTAINS is list-membership
  (exact element match), NOT substring. Substring test: `.indexOf(sub)` or
  wildcard compare `name = "*sub*"`.
- `list.length` → MISSING. Always use `.size()`.
- `FOR _x IN list DO ... ENDFOR` — parses WITHOUT error but the body never
  runs (verified: accumulator stays 0, only "Missing value" warnings). The
  only loop is `list.forEach(_x: ...)`.
- Any unknown function name — `organisation("4761")`, `find(...)` — parses
  and silently evaluates to MISSING; downstream guards then "work" on garbage.
  If a function is not listed here, it does not exist.

Also nonexistent: `return`, `print()`, `log()`, `console.log()`,
`try/catch`, `switch/case`, `else if`, `for x in y`, template literals
`` `x ${y}` ``, semicolons as separators, `x.append()`, `x.type`,
`x.getClass()` (use `x.className`), `parseInt`/`parseFloat` (use `num()`),
`WHILE` / `ENDWHILE`. The only loop is `.forEach(_item: ...)`.

## Non-negotiables

- **Assignment is `:=`** (never `=`). `=` is equality comparison. Persisted
  object properties must be changed through `_o.change(property := value)`;
  never write `_o.property := value`. `change()` accepts multiple properties.
- **Object references:** `t.<businessId>` for templates/objects (e.g.
  `t.sc_risk`), `r.<businessId>` for FileResource / ExternalResource. NEVER
  `o.<rid>` — RIDs do not work in EC. Other spaces: `o.` Organisation,
  `u.` User, `g.` Group, `k.` custom property.
- **Business id lookups:** an object's business id is its `id` property
  (`_o.id`). There is NO `businessId` property — `.filter(businessId = "x")`
  parses, warns "Missing value" once per object, and matches nothing.
  To fetch one object by business id, reference it directly (`t.<businessId>`);
  never scan descendants for it.
- **Object card:** `.card` is a reference property pointing to a `Card` object
  used to present the object in mouseovers, `ExtendedTable`, and
  `RelationshipView`; enterprise instances may inherit it from their template.
- **Widget visibility:** after locating the widget with `read_layout`, preview
  the exact widget once (replace the example RID):

  ```
  _w := lookup(1234567890123456789)
  output("visible=" + _w.visible.whenMissing("") + "|L=" + _w.shownOnLargeDisplay.whenMissing("") + "|M=" + _w.shownOnMediumDisplay.whenMissing("") + "|S=" + _w.shownOnSmallDisplay.whenMissing(""))
  ```

  Treat `visible=false` or `L=false|M=false|S=false` as hidden.
- **Null is `MISSING`.** Guard with `.whenMissing(fallback)`; test with
  `.isMissing()` or `= MISSING`.
- **`forEach` uses a colon:** `list.forEach(_item: ... )`.
- **`IF cond THEN ... ELSE ... ENDIF`** — `ENDIF` is mandatory; `ELSE` is
  optional as a statement. To use IF as a VALUE, parenthesize it — bare IF on
  a right-hand side is a parse error:
  `_x := (IF a THEN 1 ELSE 0 ENDIF)` works; `_x := IF a THEN...` fails.
  No `else if` — nest a new IF inside the ELSE branch.
- **The last expression is the output.** No `return`, no `print`; the final
  line's value is the result. `output(x)` logs a value — only the LAST
  `output()` survives, so concatenate diagnostics into one string.
  If the last statement is an IF whose taken branch contains multiple
  statements, the script returns a LIST of every statement's value in that
  branch (verified: `IF FALSE THEN "a" ELSE _x := 1  _y := 2  "z" ENDIF`
  → `[1, 2, z]`). Assign inside the branch and put the bare variable after
  ENDIF when you need a scalar result.
- **Read code as text vs evaluate — the OPPOSITE of what output() suggests:**
  bare `t.calc.expression` RUNS the stored code and yields its result;
  `output(t.calc.expression)` yields the raw source TEXT without running it.
  output() here is not "print the evaluated value". When asked to *show* a
  stored expression, always wrap it in output(); when asked to *run* it,
  use it bare. Never explain these two the other way around.
- **Properties have no parens; methods do.** `_o.name`, `_o.id`,
  `_o.className` (properties) vs `_o.children()`, `_l.size()` (methods).
  `root` is a keyword, not `root()`.
- **Variables:** prefix locals with `_` (house style). Scoping is completely
  FLAT — forEach iterator variables overwrite same-named outer variables;
  initialize accumulators before the loop.
- **`this.object`** = the context object; **`self`** = current item in
  `calculate()` / table rows.
- Comments: `// line` and `/* block */`.

## Chaining limits (parse errors, verified)

1. **Never chain a method onto a FUNCTION call result:**
   `str(_x).indexOf("4")` → parse error. Assign first:
   `_t := str(_x)` then `_t.indexOf("4")`.
2. **Never compare a chained expression inline:**
   `list.filter(...).size() > 0` → parse error `Encountered ">"`.
   Assign first: `_n := list.filter(...).size()` then `IF _n > 0 THEN ...`.
   Plain chains without a trailing operator are fine:
   `list.filter(...).size()` and `list.filter(...).as(name).join(" | ")` work.
3. Inside a forEach body, chaining a method onto a FUNCTION-call result or
   comparing a chained expression inline breaks exactly as above; plain
   property/method chains (`_o.linkedTo.name.whenMissing("")`) are fine.

## Strings — verified vocabulary

Exists (nothing else does):

| Method / op | Behaviour |
|---|---|
| `+` | concatenation (numbers auto-stringify) |
| `.indexOf(sub)` | index of first occurrence, **MISSING if absent** (not -1). Case-SENSITIVE. Guard: `.whenMissing(-1)` |
| `.size()` | length in UTF-16 code units (emoji = 2) |
| `.substring(start, end)` | `[start, end)`, 0-based |
| `.strip()` | remove leading/trailing whitespace (this is EC's "trim") |
| `str(x)` / `num(s)` | to-string / to-number conversions |
| `s = "*pat*"` | wildcard compare — see below |

Strings are not iterable: `_s.forEach(...)` does not walk characters. Remove
outside whitespace with `_s.strip()`; for parsing, combine `indexOf()` and
two-argument `substring(start, end)` with intermediate variables.

**Case-insensitive matching — the ONLY idiom.** There is no case conversion,
but wildcard `=` comparison with `*` is CASE-INSENSITIVE (verified:
`"Risk Management" = "*risk*"` → true, `"ABC" = "*abc*"` → true, `= "*xyz*"`
→ false). Multiple wildcards work: `name = "*RISK*MENT*"`. Use it directly in
conditions and `filter()`:

```
root.organisation.descendants().filter(name = "*risk*")
```

For case-SENSITIVE substring tests use `.indexOf(sub)` (MISSING when absent).
There is no `.replace()` and no working `.split()` — do not attempt string
rewriting; restructure with `substring()`/`indexOf()` if unavoidable.

## Lists — verified vocabulary

Create: `LIST()`, `LIST(1, 2, 3)`, `LIST(t.a, t.b)`.

| Method | Behaviour |
|---|---|
| `.size()` / `.count()` | element count (never `.length`) |
| `.filter(condition)` | bare condition on element properties — NO iterator var, NO colon: `.filter(name = "*risk*")`, `.filter(className = "Kpi")` |
| `.forEach(_x: body)` | iterate; colon syntax; returns last iteration's value |
| `.as(prop)` | extract ONE property → list: `.as(name)`. Complex expressions silently degrade — use `.calculate()` |
| `.calculate(expr)` | per-item expression → list: `.calculate(id + " -> " + name)` |
| `.first()` / `.last()` / `.item(n)` | scalar access, `item` is 0-based |
| `.join(sep)` | list → string |
| `.sum()` `.avg()` `.max()` `.min()` | numeric aggregates |
| `.distinct()` | dedupe |
| `.sort()` / `.sort(prop)` / `.sortReverse(prop)` | sort (chronological for dates) |
| `.merge(other)` | combine + DEDUPE (set semantics) |
| `.union(other)` | combine, KEEPS duplicates — note: opposite of usual naming |
| `.map(prop)` | GROUP-BY → MAP (not a transform!): `.map(className).get("Kpi")` returns the matching objects |
| `x IN list` / `list CONTAINS x` | membership operators (exact match) |

Append idiom (since `:+` is broken): `_l := _l.union(LIST(_item))`.

Tree navigation: `_o.children()` (direct), `_o.descendants()` (recursive),
both accept an UNQUOTED class filter: `_o.descendants(Organisation)`,
`_o.children(Kpi)`. Upward: `_o.parent`, `_o.ancestor(Scorecard)` (singular,
unquoted class, argument required).

Queries — always scope with FROM (a bare `SELECT Type` can return 0 or hang):

```
_r := SELECT Organisation FROM root.organisation WHERE name = "*group*"
_r.size()
```

WHERE supports `=` (with wildcards) `!=` `<` `>` `AND` `OR` `IN` `CONTAINS`.
Model roots: `root.organisation`, `root.node`, `root.portal`,
`root.expression`, `root.property`, `root.user`, `root.group`, ...

## JSON — constructor, wrappers, mutation

The ONLY parser is uppercase `JSON(string)`. There is no `json()`,
`jsonDecode()`, `json_set(...)` function, JS object literal `{key: value}`, or
array indexing with `[]`.

JSON object properties are clean native values: `_o.name`, `_o.score`, nested
`_o.meta.version`. Object arrays support `size`, `item`, `forEach`, `filter`,
`sort`, `as`, `calculate`, `union`, and `merge`. But primitive-array items
are wrapped NodeValues:

```
_numbers := JSON("[7, 11, 13]")
_total := 0
_numbers.forEach(_wrapped:
     _raw := str(_wrapped)
     _total := _total + num(_raw)
)
_total
```

- Never call `sum/avg/min/max` directly on a JSON primitive-number array.
- `str()` on a JSON primitive-string item still includes its surrounding `"`;
  clean it with `_raw.substring(1, _raw.size() - 1)` before joining.
- `list.map(...)` does NOT work on JSON objects; use `forEach` accumulation.
- After filtering a JSON object array, `.table()` renders empty. Reparse first:
  `_safe := JSON(str(_filtered))`, then `_safe.table()` (sorting may precede it).

Stored ExtendedExpression utilities are workspace-authored configuration, not
EC built-ins. Never assume that a `t.<id>` helper exists or that its scope
variables and return contract match another workspace. If the user or live
context explicitly identifies a stored helper, inspect its raw source with
`output(t.<id>.expression)`, verify its final expression and scope variables,
then preview the call. Otherwise write platform-native EC.

For JSON escaping, iterate characters and finish with the accumulator. Obtain a
backslash and double quote safely (literal `"\\"` is a lexical trap):

```
_BS := JSON("{\"c\":\"\\\\\"}").c
_DQ := JSON("{\"c\":\"\\\"\"}").c
```

For a bounded character loop, build a sufficiently large duplicate-preserving
range with `LIST("")`, repeated `.union(_range)`, then `_range.first(_n)`:

```
_n := _raw.size()
_range := LIST("")
_range := _range.union(_range)
_range := _range.union(_range)
_range := _range.union(_range)
_range := _range.union(_range)
_range := _range.union(_range)
_range := _range.first(_n)
_escaped := ""
_pos := 0
_range.forEach(_:
     _ch := _raw.substring(_pos, _pos + 1)
     IF _ch = _DQ THEN
          _escaped := _escaped + _BS + _DQ
     ELSE
          IF _ch = _BS THEN
               _escaped := _escaped + _BS + _BS
          ELSE
               IF _ch = "\n" THEN
                    _escaped := _escaped + _BS + "n"
               ELSE
                    _escaped := _escaped + _ch
               ENDIF
          ENDIF
     ENDIF
     _pos := _pos + 1
)
_escaped
```

## MAPs and tables

MAP syntax uses `;` between each key and value, comma between pairs. MAPs are
immutable; there is no `{...}` literal, `.keys()`, useful per-key `forEach`, or
`.filter()`. Aggregate methods work on LIST-valued entries:

```
_m := MAP("Q1"; LIST(10, 20, 30), "Q2"; LIST(15, 25))
_m.sum().table("Quarter", "Total")
```

Real table constructors are lowercase `createtable(...)`, list/JSON `.table(...)`,
and `.addRow(...)`. There is no `TABLE`, `ROW`, `ROWS`, or `COLUMNS`, and a nested
LIST is not a rendered table. Table property arguments are BARE properties:
`.table(id, score, active)`, never quoted strings. Use `.table()` for all JSON
object fields.

```
_rows := JSON("[{\"id\":\"A\",\"amount\":12.5},{\"id\":\"B\",\"amount\":7.25}]")
_table := createtable("ID", "Amount")
_rows.forEach(_row:
     _table.addRow(str(_row.id), _row.amount)
)
_table
```

For a heterogeneous BMP-object list, avoid `.table().addColumn(prop)`: it binds
the first row's concrete property getter and throws on another class. Use the
class-safe positional form:

```
_mixed.table(className, id, name, parent.name)
```

## Canonical recipes (all run clean on live BMP)

Count matching objects:

```
root.organisation.descendants().filter(name = "*risk*").size()
```

Branch on a count (assign before comparing — chaining limit #2):

```
_n := root.organisation.descendants(Organisation).filter(name = "*risk*").size()
IF _n > 0 THEN "has risk orgs" ELSE "none" ENDIF
```

Build a joined string:

```
root.organisation.descendants(Organisation)
     .filter(name = "*ltd*")
     .as(name)
     .join(" | ")
```

forEach accumulation (when filter conditions aren't expressive enough):

```
_count := 0
_names := ""
root.organisation.descendants().forEach(_o:
     IF _o.name = "*risk register*" THEN
          _count := _count + 1
          _names := _names + _o.name + "; "
     ENDIF
)
"count=" + _count + " names=" + _names
```

Perf: touch a string accumulator ONCE per iteration (build the line in a
local first) — every extra `+` term on the accumulator rescans the whole
string (quadratic; measured 52s → 8.6s on ~2000 lines).

Read a property with fallback:

```
_name := t.folder_template_org.name.whenMissing("(unnamed)")
```

Per-item transform:

```
root.organisation.descendants(Organisation).calculate(id + " -> " + name)
```

Read a stored expression's source text: `output(t.<id>.expression)`.

## Formatting

One statement per line. Indent forEach/IF bodies 5 spaces (Config Studio tab
width). Keywords uppercase: `IF THEN ELSE ENDIF SELECT FROM WHERE AND OR`.
Never write one-liner EC.
