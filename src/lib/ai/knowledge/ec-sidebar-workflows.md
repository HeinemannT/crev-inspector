<ec_sidebar_workflows>

# Extended Code configuration workflows

Use the shared EC specification to produce complete previewable configuration or data artifacts. Workspace classes, accessors, parents, collections, options, and references come from context/tools, never from a business noun.

## Foreign syntax repair

| Never emit | Valid EC |
|---|---|
| `x = value` as assignment | `x := value` |
| `==`, `===` | `=` |
| `&&`, `||` | `AND`, `OR` |
| `!x`, `NOT x` | `x = FALSE`, `x != value`, or `.isMissing()` |
| `cond ? a : b` | `(IF cond THEN a ELSE b ENDIF)` |
| `filter(_x: cond)` / `filter(_x => cond)` | `filter(cond)` |
| `forEach(_x => body)` | `forEach(_x: body)` |
| `map(_x: expr)` | `.map(property)` for grouping; `.calculate(expr)` for transformation |
| `.append()`, `.push()`, `_list :+ item` | `_list := _list.union(LIST(item))` |
| `list.length` | `list.size()` |
| `null`, `None`, `undefined` | `MISSING` |
| `.trim()` | `.strip()` |
| `parseInt`, `parseFloat`, `.toString()` | `num(value)`, `str(value)` |
| `businessId` property | `id` |

Unavailable forms include case conversion, `replace`, `slice`, `split`, `contains`, `startsWith`, `endsWith`, `includes`, regex methods, `reduce`, `try/catch`, `switch`, `else if`, `WHILE`, `FOR ... IN`, template literals, console/log helpers, and MAP `.keys()`/`.values()`. Unknown names can parse as `MISSING`; a clean parse does not prove a function exists.

## Persisted changes

Combine related updates in one `change(...)`. Use exact supplied references and property IDs. Create only requested objects; preserve existing semantics and visible wording. Keep an `add/change` result only when another statement uses it.

```extended
t.qa_risk_table.change(
  visible := FALSE,
  columnsLargeScreen := 6,
  columnsMediumScreen := 6,
  columnsSmallScreen := 6)
```

## Grouped results and tables

For one aggregate per group:

```extended
_byState := _risks.map(lifecycleState)
_byState.count().table("Lifecycle state", "Risk count")
```

For several aggregates, enumerate verified distinct reference values and initialize one result table before the loop:

```extended
_owners := _risks.as(ownership).distinct()
_table := createtable("Owner", "Risk count", "Residual exposure")
_owners.forEach(_owner:
  _group := _risks.filter(ownership = _owner)
  _table.addRow(_owner.name, _group.size(), _group.as(residualExposure).sum())
)
_table
```

For BMP-object rows, `.table(...)` takes bare accessors in column order, such as `_risks.table(name, id, ownership)`. Use configured labels or `createtable/addRow` for custom headings. JSON-object rows use `.table()`.

## Stored and deferred source

`ExtendedTable.expression` is EC source stored as a string and evaluated later. Its collection, filter, locals, and final table operation belong inside that string:

```extended
_template.add(ExtendedTable,
  id := "open_risks", name := "Open risks",
  expression := '_rows := root.CeRiskAssessment.children.filter(lifecycleState = t.state_open)
_rows.table(name, lifecycleState)',
  columnsLargeScreen := 6,
  columnsMediumScreen := 6,
  columnsSmallScreen := 6)
```

The outer Preview proves only that the source can be stored. Preview the inner expression separately when an uncertain join/group/aggregate must be checked against live rows, then submit the complete outer mutation. Multiline source uses one single quote at each boundary and real line breaks; EC has no triple quotes or `CHAR`/`CHR` newline helper.

When changing embedded source, preserve the outer receiver, type, ID, name, placement, widths, quote style, and final result unless requested otherwise. Read source with `output(t.id.expression)` or `read_code`; a bare `.expression` executes it.

Stored `ExtendedExpression` helpers are workspace configuration, not built-ins. Discover the exact helper and inspect its source before using it. The final bare expression is its result; internal locals do not leak. `${id}` is KPI-engine syntax and does not resolve in interactive Preview or stored `ExtendedExpression` bodies.

</ec_sidebar_workflows>
