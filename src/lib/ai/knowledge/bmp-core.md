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
