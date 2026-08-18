# Corporater BMP (platform basics)

Corporater BMP is a GRC (governance, risk, compliance) platform. Configurators
build dashboards and apps out of objects.

- **Templates** define a type of object (its properties, layout, and code).
  **Instances** are concrete objects created from a template. Editing a template
  changes every instance; editing an instance changes only that one object.
- Every object has a **businessId** (a short, stable id) and a **RID** (a
  64-bit numeric id). Persistent EC references use the appropriate business-ID
  namespace (`t.*`, `o.*`, or `r.*`); inspection tools may use a live numeric
  RID with `lookup(rid)`.
- **Widgets** (charts, tables, InputViews, CustomVisualizations, TextElements)
  render inside BMP's web portal. Their behaviour and content come from code
  properties: Extended Code expressions, or HTML/JavaScript for custom widgets.
- Code you write here runs server-side in BMP (Extended Code) or in the portal
  browser (a CustomVisualization's HTML + JavaScript).
- BMP's built-in Default card has the stable system reference
  `t._defaultCardId`. Assign it explicitly (`card := t._defaultCardId`).
  `card := MISSING` does not mean "reset to default" and may complete as a
  no-op, so it must not be used for that request.

## Object CLASS vs TEMPLATE (do not confuse these)

Every object has two orthogonal "type" notions:

- Its **class** — the built-in Java class: `Organisation`, `Scorecard`, `Task`,
  `CustomVisualization`, `ExtendedTable`, `InputView`, `TextElement`, … This is
  what `.className` returns and what a `descendants(Class)` filter matches.
- Its **template** — the configured object it was built from, reached via
  `linkedTo` (the Scorecard / widget link model) or `.template` (the enterprise
  object model). A template often carries the configurator-defined semantic
  meaning, but its name and class are workspace data and must be discovered.

**Do not infer the class from a semantic noun.** A workspace can model risks,
controls, processes, issues, and similar concepts as ordinary built-in objects
under a named template, or as a dedicated `Ce*` enterprise family. In
particular, “process” does not imply `Task`. Discover the class/template from
the effective page or query results first. Consequences:

- `descendants(SomeSemanticNoun)` fails unless `SomeSemanticNoun` is a real
  registered BMP class. A familiar business term is not evidence that it is.
- Template relationships are not uniform. Scorecard/widget models commonly use
  `linkedTo`; enterprise models use `template`. When semantic discovery must
  cover both, resolve per object: `_t := _o.linkedTo` then
  `IF _t = MISSING THEN _t := _o.template ENDIF`.
- Missing-value warnings are expected when probing either relationship across
  a mixed collection. They do not establish that the other relationship or a
  particular object family is absent.

Before assuming a class name exists, use live tool output: inspect the effective
page, read an exemplar, query by a user-supplied template term, or probe the
appropriate discovered root with `preview_ec`. The `<workspace>` map is only a
partial organisation-tree inventory.

## Web page ownership (the model behind what the user sees)

A rendered BMP page combines two object models:

- `TabSet`, `Tab`, and portal `Container` are shared portal/SharedWebItems
  structure.
- Widgets are organisation/page-model children of the effective page owner.
  Their `container` reference binds them into a portal Tab or Container.
- A direct page host such as a Scorecard owns its widgets. A linked Scorecard
  instance also owns its linked widget copies; do not redirect it to
  `.linkedTo` merely to read its visible page.
- A `Ce*` enterprise instance exposes `.template`; that EnterpriseTemplate is
  the effective owner of the rendered widgets. The viewed RID remains the
  instance, while page/layout inspection must resolve to its template.

For configuration changes, the normal configurator scope is broader than the
read owner rule: if a direct Scorecard instance is linked to a master, change
the master template by default so the configuration remains inherited. Change
the instance widget only when the user explicitly asks for a local or
instance-only override. `read_layout` exposes the linked page and widget RIDs;
use `lookup("RID")` for the selected 64-bit RID. A Ce* instance is
different: its EnterpriseTemplate is the actual page owner, so page widgets
cannot be added to the instance itself.

For an existing inherited widget, the exact target is its `linkedTo` widget on
the shared template—not the copied widget below the viewed instance and not
merely the template page owner. A normal “change this table/widget” request
changes the shared-template widget; only an explicit local or instance-only
request changes the instance copy. Select from the widget's `rid` and
`linkedTemplateRid`; do not substitute the page RID.

Enterprise families live below their class-specific roots (for example Ce*
roots), not universally below `root.organisation`. BPMN/process-management
objects live below `root.Processmanagement`. Use live discovery rather than
inventing a root or forcing everything through the organisation tree.

## Creating configuration objects (exact EC API)

Use the live tools to establish the parent, class, and property names first.
Then create with the built-in `add` method:

```extended
_page := o.verified_parent_bid.add(Scorecard,
  id := 'sc_example', name := 'Example')
_page.add(TextElement,
  id := 'txt_intro', name := 'Introduction',
  text := '<p>Short, sanitized HTML.</p>',
  columnsLargeScreen := 6, columnsMediumScreen := 6,
  columnsSmallScreen := 6)
_page.add(ExtendedTable,
  id := 'tbl_example', name := 'Data',
  expression := 'root.VerifiedClass.children.table(name, verifiedProperty)',
  columnsLargeScreen := 6, columnsMediumScreen := 6,
  columnsSmallScreen := 6)
```

- The API is `parent.add(Type, named arguments)`. Never invent
  `createChild`, `new`, constructors, or a generic create helper.
- A Scorecard is added below a verified Organisation. Its widgets are added
  directly below the returned Scorecard variable; a Container is only a visual
  reference assigned through `container`.
- The portal's CSS grid has 12 tracks, but BMP configuration uses a 0–6 scale.
  `columnsLargeScreen := 6` is full width (12 CSS tracks). Values 7–12 are
  invalid; never copy Bootstrap's 12 into any `columns*Screen` property.
- Keep a returned `add` object in a variable only when a later statement uses
  it, as `_page` is used above. Newly created IDs are not guaranteed to resolve
  through `t.*`/`o.*` until after commit.
- `TextElement.text` is the inline, visible HTML body. `longText` is collapsed
  behind “SHOW MORE”.
- An ExtendedTable's `expression` is source text and is evaluated later by the
  portal. Use only classes and table properties established by live schema or
  data. An empty scoped organisation query does not prove that a `Ce*` root is
  absent.
- Put a proposed table expression in the complete ticket as a static quoted
  string or quoted-string + chain. BMP executes that quoted expression later,
  when the table renders. Previewing only `add(..., expression := '...')`
  proves that the source can be stored; it does not execute the expression or
  prove that its rows and columns render correctly. For a Ce family, prefer the
  verified collection returned by `read_type`, then project only the columns
  the user requested. For an unspecified table, start with `table(name,
  verifiedProperty)` and omit `id`;
  never attach `.table(...)` to `root.organisation` in a `SELECT` expression.
- Read stored table source with `output(t.tbl_example.expression)`; a bare
  `.expression` executes it.

## Creating and linking templates (two different models)

First identify which template model the user means; they are not interchangeable.

**Linked Scorecard template:** create a master Scorecard with widgets below a
template-category Category, commit it, then create an organisation instance with
`_instance := o.verified_org_bid.link(t.master_scorecard_id)`. Never assign
`linkedTo` directly—it is read-only. Verify the persisted instance's
`linkedTo.rid` equals the master RID and each copied widget's `linkedTo` points
to its corresponding master widget. Browser-check one instance; editing the
master should propagate unless that field is overridden on the instance.

**Ce* EnterpriseTemplate lifecycle:** property definitions must be linked to the
Ce class first. In the first committed transaction, create the
`EnterpriseTemplate` under a category in `root.templatecategory`, create its
child view with `viewTypes := LIST(CeRiskAssessment)`, and create the Default as
the Ce class under a category in `root.defaults`:

```extended
_template := _templateCategory.add(EnterpriseTemplate,
  id := 'tpl_risk', name := 'Risk template')
_view := _template.add(DescriptionView,
  id := 'view_risk', name := 'Risk details',
  viewTypes := LIST(CeRiskAssessment))
_default := _defaultCategory.add(CeRiskAssessment,
  id := 'default_risk', name := 'Default risk')
```

The template object is `EnterpriseTemplate`; never substitute the enterprise
instance class there. The Default is the Ce class. Commit that foundation, then
re-resolve and bind them in a second transaction:

```extended
_default := root.defaults.descendants().filter(id = 'default_risk').first()
_default.change(template := t.tpl_risk)
```

Commit this binding before creating an instance or a CreateObjectView. Verify
all four edges independently: view `viewTypes` → class, Default `template` →
EnterpriseTemplate, CreateObjectView `objectType` → Default (when present), and
sample instance `template` → EnterpriseTemplate. “The template exists” alone
is never sufficient—it can still produce blank instance pages.

## Tables are code-driven

Layout inspection tells you that an `ExtendedTable` widget exists and where it
is placed; it does not reveal the table's runtime rows. Those come from the
widget's `expression`. Read the raw source with
`output(table.expression)`—a bare `.expression` evaluates it. In Inspector,
use `read_code` with the table's numeric RID and `property="expression"`.
