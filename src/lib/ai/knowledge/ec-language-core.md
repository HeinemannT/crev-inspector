<ec_language_core>

# Extended Code language specification

Extended Code (EC) is Corporater BMP's standalone proprietary language. Treat
the rules and vocabulary below as a closed specification. Use a construct only
when this reference or the supplied source establishes it.

## Critical syntax boundary

- **Never write `(SELECT ...).method()` or continue a `SELECT` with dot
  notation.** `SELECT` is a statement: assign its list to a local on one line,
  then call `.first()`, `.last()`, or another list method on that local.

## Grammar and results

- Local variables begin with `_`. Assignment and named arguments use `:=`.
  Equality is `=`; inequality is `!=`; comparisons include `<`, `>`, `<=`,
  `>=`; Boolean operators are `AND` and `OR`.
- Values include `TRUE`, `FALSE`, and `MISSING`. Use `.whenMissing(fallback)`,
  `.isMissing()`, or comparison with `MISSING`. General `NOT condition` is not
  available; express negation with `!=`, `= FALSE`, or `.isMissing()`.
- Branch with `IF condition THEN ... ELSE ... ENDIF`; `ELSE` is optional. An IF
  used as a value must be parenthesized:
  `_label := (IF _active THEN "Open" ELSE "Closed" ENDIF)`.
- Iterate only with `list.forEach(_item: ... )`. The iterator shares flat local
  scope, so initialize accumulators before the loop.
- The final expression is the result; there is no `return`. `output(x)` logs a
  value and only the last output survives. Preserve an existing `output(...)`
  unless the task changes that behavior.
- Comments are `// line` and `/* block */`. Do not use semicolons between
  statements.

## Object and configuration semantics

- Preserve existing `t.`, `o.`, `r.`, and `root.` references byte-for-byte.
  `t.<id>` is a configured object/template; `o.` is Organisation; `r.` is a
  FileResource/ExternalResource. Never invent `o.<rid>`; BMP RIDs are not EC
  identifiers.
- An object's business ID property is `.id`, not `.businessId`. Properties have
  no parentheses (`_o.name`, `_o.className`); methods do (`_o.children()`,
  `_list.size()`). Enterprise class roots are different: preserve a supplied
  collection such as `root.CeRiskAssessment.children` without adding `()`.
- Persist configuration with `object.change(property := value, ...)`; direct
  dotted assignment such as `object.visible := FALSE` does not persist.
- Binding an already supplied EnterpriseTemplate to a Default uses
  `_default.change(template := _template)`; that relationship is not card
  assignment.
- Create with `parent.add(UnquotedType, id := "stable_id", ...)`; delete with
  `object.delete()`. BMP's Default card is `t._defaultCardId`.
- Responsive width is 1–6. Full width is 6 for each requested breakpoint:
  `columnsLargeScreen`, `columnsMediumScreen`, and `columnsSmallScreen`.
- `this.object` is the current calculation object (for a child widget it may be
  the owning page), `this.item` is the current item, and `this.user` is the
  logged-in user. `this.org` is the caller's viewing-organisation context and
  may be `MISSING`; use `this.object.organisation` for the object's own owning
  organisation. `this.object.org` does not exist.
- In row and `calculate(...)` expressions, `self` is the current item. In
  `forEach`, use the declared iterator variable instead.
- Bare `t.id.expression` evaluates a stored `ExtendedExpression` in an isolated
  scope which can read caller locals. Its final expression is its result and
  its internal locals do not leak back. `output(t.id.expression)` returns its
  source text without executing it. An embedded `ExtendedFunction` is different:
  it evaluates only where configured and is not a reusable helper.

## References and relationship navigation

- Read a forward reference as an ordinary property: `_risk.controlOwner`.
  A configured reverse-reference property is also read normally:
  `_control.relatedRisks`.
- Query indexed inbound references with `_target.rref(property)`, where
  `property` is an UNQUOTED accessor. For example,
  `_control.rref(linkedControl)` returns objects whose `linkedControl` points
  to `_control`. The result is a list and can be filtered or iterated.
- `_target.rref(property, startDate, endDate)` queries a dated reference.
  Parameterless `_target.rref()` returns all indexed inbound references and can
  be very large, so filter its result and avoid it when a verified named
  property is available.
- Correctly linked custom reference properties support named `rref`. Built-in
  properties are descriptor- and BMP-version-dependent: do not assume a fixed
  whitelist or blacklist, and verify the exact built-in property live.

## Transaction and action context

- Persisted object operations are exact methods: `change(...)`,
  `move(destination)`, `moveBefore(sibling)`, `moveAfter(sibling)`,
  `clear(property)`, and `delete()`. `link(templateObject)`,
  `affixLink(templateObject)`, and `unlink(templateObject)` manage BMP template
  links; they do not assign ordinary data-reference properties.
- Keep every object returned by `add(...)` in a local when the same transaction
  uses it again. A new business ID is not guaranteed to resolve through `t.*`
  or `o.*` until after commit.
- In an `initExpression`, `tba` is the not-yet-persisted object. In an
  `afterExpression`, `after` is the saved object, `before` is the pre-edit
  object and is `MISSING` on add, and `adding` / `draft` describe the save.
  Here `this.object` is the triggering widget or owning page, not the new
  object; use the supplied lifecycle variables rather than inventing a lookup.
- A value set by `tba.change(...)` for a field shown in the edit form can be
  overwritten by the form save. Use `initExpression` for hidden/computed
  prefill and `afterExpression` when a visible default must persist after save.

## Expression boundaries

- A function-call result likewise cannot be followed directly by another
  method call. Assign the function result first:
  ```extended
  _text := str(_risk.name)
  _clean := _text.strip()
  ```
- Do not compare a chained expression inline. Assign the chain, then compare:
  `_count := _rows.filter(active = TRUE).size()` followed by
  `IF _count > 0 THEN ... ENDIF`.
- This also applies to a method on a plain variable. `IF _rows.size() > 0` is
  not the safe form; assign `_count := _rows.size()` and compare `_count`.
- `string.indexOf(text)` returns `MISSING` when absent. For numeric comparison,
  normalize and assign the result before comparing:
  ```extended
  _position := _name.indexOf("Risk").whenMissing(-1)
  IF _position >= 0 THEN "match" ELSE "other" ENDIF
  ```
  This two-step form is required: never compare the chained `indexOf` /
  `whenMissing` expression inline, and never repeat the unnormalized call in
  the IF.

## Strings

- Concatenate with `+`. Convert with `str(value)` and `num(text)`.
- Available string methods are `.indexOf(text)`, `.size()`,
  `.substring(start, end)`, and `.strip()`. `substring` is zero-based and its
  end is exclusive.
- Case-insensitive substring matching uses wildcard equality:
  `name = "*risk*"`. For case-sensitive matching, use `indexOf` with the
  `MISSING` handling above.
- There is no case-conversion API and no working `replace`, `trim`, `split`,
  `contains`, `startsWith`, or `endsWith` string method.

## Lists and navigation

- Create lists with `LIST()` or `LIST(a, b)`. Important methods:
  `.size()`/`.count()`, `.filter(condition)`, `.forEach(_x: body)`, `.first()`,
  `.last()`, `.item(index)`, `.join(separator)`, `.distinct()`, `.sort()`,
  `.sort(property)`, `.sortReverse(property)`, `.sum()`, `.avg()`, `.min()`,
  and `.max()`.
- `filter` takes a bare element-property condition, never a callback:
  `_rows.filter(lifecycleState = t.state_open)`.
- `.as(property)` extracts one property. Use `.calculate(expression)` for a
  computed per-item value such as `id + " - " + name`.
- `.union(other)` combines lists and keeps duplicates. Use
  `_list := _list.union(LIST(_item))` to append. `.merge(other)` combines and
  removes duplicates.
- `.map(property)` groups a list into a MAP; it is not transformation. Its
  argument is the bare grouping property: never write `.map(_item: ...)` and
  never invent `groupBy`.
- There is no `groupBy`. One count per group is the exact pipeline
  `_grouped := _rows.map(property)`, then
  `_grouped.count().table("Group", "Count")`.
- Object navigation is `_o.children()`, `_o.descendants()`, `_o.parent`, and
  `_o.ancestor(UnquotedType)`. The child methods may take an unquoted class.
- Scope SELECT queries with FROM, for example
  `SELECT Organisation FROM root.organisation WHERE name = "*risk*"`.
  Membership is `value IN list` or `list CONTAINS value`; `CONTAINS` is exact
  list membership, not substring matching.

## JSON

- Parse with uppercase `JSON(text)`. Do not use object literals, bracket array
  indexing, `parseJson`, or `jsonDecode`.
- JSON object properties are native values. Items of primitive JSON arrays are
  wrappers: use `num(str(_item))` for a number. For a primitive string, assign
  `_raw := str(_item)` and remove its wrapper quotes with
  `_raw.substring(1, _raw.size() - 1)`.
- Do not aggregate a primitive-number JSON array directly; convert each item in
  a `forEach` accumulator. For an average, keep both conversion and denominator
  explicit:
  ```extended
  _total := 0
  _values.forEach(_value:
       _number := num(str(_value))
       _total := _total + _number
  )
  _count := _values.size()
  IF _count > 0 THEN _total / _count ELSE 0 ENDIF
  ```
- A filtered JSON-object list must be serialized and reparsed before table
  rendering. Complete every filter and sort first, then make reparse the final
  transformation: `_safe := JSON(str(_sorted))`, then call `_safe.table()`
  directly. Do not filter or sort again between that reparse and `table()`.
- JSON object arrays support the normal list methods except that `.map(...)`
  is not reliable; use `forEach` accumulation.

## MAPs and tables

- MAP literal syntax is `MAP("Q1"; LIST(10, 20), "Q2"; LIST(30))`: semicolons
  separate each key from its value and commas separate pairs. MAPs support
  `.get(key)`, `.size()`, aggregates, and table conversion. They do not expose
  keys/values enumeration or mutation methods.
- Grouped list MAPs can aggregate and render, for example
  `_grouped.sum().table("Quarter", "Total")`.
- Build tables with lowercase `createtable("Header", ...)` plus
  `_table.addRow(...)`, or return `collection.table(property, ...)`. Table
  property arguments are bare accessors, not quoted headers. JSON objects can
  use `.table()` for all fields.
- `TABLE`, `ROW`, `ROWS`, and `COLUMNS` are not EC constructors.

## Performance

- Repeated multi-term concatenation onto a growing string is expensive. Inside
  a large loop, preserve the loop and string accumulator, build the complete
  row in a small local, then touch the accumulator once:
  ```extended
  _log := ""
  _objects.forEach(_item:
       _line := _item.id + "|" + _item.name + "|" + _item.className + "\n"
       _log := _log + _line
  )
  _log
  ```
  Preserve the exact output format. Do not replace this measured repair with a
  LIST/union accumulator, calculate/join rewrite, or per-row `output()` calls.

</ec_language_core>
