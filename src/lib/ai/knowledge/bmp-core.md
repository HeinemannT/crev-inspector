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

Enterprise families live below their class-specific roots (for example Ce*
roots), not universally below `root.organisation`. BPMN/process-management
objects live below `root.Processmanagement`. Use live discovery rather than
inventing a root or forcing everything through the organisation tree.

## Tables are code-driven

Layout inspection tells you that an `ExtendedTable` widget exists and where it
is placed; it does not reveal the table's runtime rows. Those come from the
widget's `expression`. Read the raw source with
`output(table.expression)`—a bare `.expression` evaluates it. In Inspector,
use `read_code` with the table's numeric RID and `property="expression"`.
