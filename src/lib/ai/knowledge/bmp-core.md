# Corporater BMP (platform basics)

Corporater BMP is a GRC (governance, risk, compliance) platform. Configurators
build dashboards and apps out of objects.

- **Templates** define a type of object (its properties, layout, and code).
  **Instances** are concrete objects created from a template. Editing a template
  changes every instance; editing an instance changes only that one object.
- Every object has a **businessId** (a short, stable, human-readable id such as
  `sc_risk` or `cecme.123`) and a **RID** (a 64-bit numeric id). In code you
  reference objects by businessId, never by RID.
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
  object model). A template carries the *semantic* type (e.g. a "Risk Register"
  or "§ Draft Risks" template).

**GRC objects are usually NOT their own class.** Verified live: a workspace
models its risks / controls / issues as ordinary `Task`, `Scorecard`, or
`Organisation` objects built from a NAMED TEMPLATE — there is no `Risk`,
`Control`, or `EnterpriseObject` class. Consequences (all verified with
ec_preview on 5.6.10.0):

- `root.organisation.descendants(Risk).size()` → **error** `Type Risk not
  found`. Likewise `descendants(EnterpriseObject)` → `Type EnterpriseObject not
  found`. A class filter only accepts a REAL registered class.
- To find template-built objects, filter by the template name instead:
  `root.organisation.descendants().filter(linkedTo.name = "*risk*")` → returns
  the matching objects (benign "Missing value" warnings for objects with no
  `linkedTo` are expected and harmless).
- A bare `.filter(template.name = "*risk*")` returns **0** here — the widget /
  scorecard model uses `linkedTo`, not `.template`. When you need to cover both
  models, resolve per object: `_t := _o.linkedTo` then
  `IF _t = MISSING THEN _t := _o.template ENDIF`.

Before assuming a class name exists, check the `<workspace>` map, read one
exemplar object, or run a tiny `descendants().filter(linkedTo.name = "*…*")`
probe with preview_ec.
