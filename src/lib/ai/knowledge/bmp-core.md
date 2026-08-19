# Corporater BMP platform facts

Corporater BMP configurators build pages from configured objects. Workspace-specific classes, templates, properties, IDs, roots, and references must come from attached context or live tools.

## Identity and object models

- A **class** is a built-in Java type such as `Organisation`, `Scorecard`, `ExtendedTable`, `InputView`, `TextElement`, or a registered `Ce*` class. A **template** is configured workspace data reached through `linkedTo` (Scorecard/widget model) or `template` (enterprise model). Never infer either from a business noun; “process” does not imply `Task`.
- Every object has a stable business ID and a 64-bit numeric RID. Preserve verified `t.*`, `o.*`, `r.*`, and `root.*` references. For a RID-selected executable reference use `lookup("RID")` with quotes; `[[object:RID]]` is display syntax only.
- Enterprise roots are class-specific, not universally `root.organisation`. Preserve a verified collection such as `root.CeRiskAssessment.children`. BPMN/process objects live under `root.Processmanagement`.
- The built-in Default card is `t._defaultCardId`. Assign it explicitly; `card := MISSING` is a no-op, not “reset to default”.

## Page ownership and placement

A rendered page combines two models:

- `TabSet`, `Tab`, and portal `Container` are shared portal structure.
- Widgets are children of the effective page host. Their `container` property places them in portal structure.
- A direct Scorecard owns its widgets. For a linked Scorecard, normal configuration changes target the shared master/page widget; only an explicit local/this-copy request targets the instance copy.
- A `Ce*` enterprise instance renders widgets owned by its `EnterpriseTemplate`. The viewed instance is context, not the add receiver.
- For an existing inherited widget, use its verified linked-template widget, not the page RID. For a local override, use the verified instance widget.

## Configuration API and layout

Create with `parent.add(UnquotedType, named arguments)`, update with `object.change(...)`, delete with `object.delete()`. Never invent constructors, `new`, `createChild`, or a generic create helper. Keep an `add(...)` result in a local only when later statements reuse it; new IDs may not resolve through `t.*`/`o.*` until commit.

Widgets are added to the verified Scorecard/EnterpriseTemplate. A Container is only placement, and an existing sibling is only an ordering anchor:

```extended
_table := _page.add(ExtendedTable,
  id := "risk_scores", name := "Risk scores",
  container := _content,
  expression := 'root.CeRiskAssessment.children.table(name, calculatedRiskScore)',
  columnsLargeScreen := 6,
  columnsMediumScreen := 6,
  columnsSmallScreen := 6)
_table.moveBefore(_reports)
```

If no placement or ordering was requested, add directly to the verified page host without inventing a Container or sibling.

Reusable portal tabs are created under the verified shared Tabs category, then nested structurally. A page does not own this scaffold:

```extended
_tabSet := t.swi_default_tabs.add(TabSet, id := "page_tabs", name := "Page tabs")
_tab := _tabSet.add(Tab, id := "overview", name := "Overview")
_container := _tab.add(Container, id := "overview_content", name := "Overview content")
```

Use only `TabSet`, `Tab`, and `Container`, never `DashboardTabSet`/`DashboardTab`. If page widgets will reference newly created Containers, commit the scaffold first and add widgets in a later ticket.

BMP responsive widths use 0–6, not 12. Zero is class-dependent and must be reported as-is. Authored full width is all three explicit values: `columnsLargeScreen := 6`, `columnsMediumScreen := 6`, `columnsSmallScreen := 6`.

Moving an existing widget is `widget.change(container := target)` with operation `move`; do not clone it. Moving a newly created widget relative to a sibling uses the returned widget's `moveBefore(sibling)` or `moveAfter(sibling)`.

`TextElement.text` is visible inline HTML; write finished structural markup, normally at least a `<p>`. `longText` is collapsed behind “SHOW MORE”. TextElement/InputSet HTML is sanitized: use `div`, `p`, headings, `strong`, `em`, `span`, `br`, and lists, with no script, style, event attributes, active URLs, forms, or iframes.
When wording is not business-critical, write short neutral finished copy; never leave bracketed placeholders or “insert text” instructions.

`EditPage.sortVisibility` is an ordered list of string property IDs, for example `LIST("code", "lifecycleState", "ownership")`.
When the request/context supplies that complete desired list, assign it directly without reading the old value. Read the current list only when unspecified entries must be preserved.

## Tables

An `ExtendedTable` gets rows and columns from its stored `expression`; it has no substitute `headers` or `fields` configuration. Use real verified collections, never sample rows.

- A BMP-object list uses bare accessors: `collection.table(name, ownership, calculatedRiskScore)`. BMP supplies configured labels. Do not quote headings or alternate headings and accessors.
- Exact custom headings require `createtable("Risk", "Owner", ...)` followed by `addRow(...)` values in the same order.
- Add only requested columns. If unspecified, prefer `name` plus the verified property needed for the requested filter/meaning; do not invent code, owner, score, KPI, or detail-card columns.
- Add filters only when requested and verified. EC filters are `.filter(property = value)`, never callbacks or display-string guesses.
- A stored expression owns its row variables. Keep its collection, filter, and final table operation inside the quoted expression; do not evaluate those rows in the outer configuration action.

Reading `table.expression` executes it. To inspect source use `output(table.expression)` or Inspector's `read_code`. Previewing an outer `add/change(... expression := '...')` proves only that the source can be stored; Preview an uncertain deferred join/group/aggregate separately when runtime row shape matters.

## Template creation

**Linked Scorecard:** create the master Scorecard and widgets below a verified template category, commit, then create an organisation instance with `organisation.link(masterScorecard)`. `linkedTo` is read-only. Each copied widget should link to its corresponding master widget.

**EnterpriseTemplate:** use two committed phases. First create the `EnterpriseTemplate`, compatible view, and Ce-class Default:

```extended
_template := _templateCategory.add(EnterpriseTemplate,
  id := "risk_template", name := "Risk template")
_view := _template.add(DescriptionView,
  id := "risk_view", name := "Risk details",
  viewTypes := LIST(CeRiskAssessment))
_default := _defaultCategory.add(CeRiskAssessment,
  id := "risk_default", name := "Default risk")
```

After commit, re-resolve and bind `_default.change(template := _template)`. When verified Default and EnterpriseTemplate references already exist, bind only those objects; do not create replacements. A complete model has the view `viewTypes`, Default `template`, optional CreateObjectView `objectType`, and sample instance `template` edges.
