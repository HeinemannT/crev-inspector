# CustomVisualization (CVO) — HTML + JavaScript

A CVO is a BMP widget with an `html` body and a `javascript` body. BMP injects
the HTML into the widget container, fetches data, then runs the JavaScript.

## Runtime contract
- `_data` — an object of expression results, keyed by each
  CustomVisualizationExpression's `key`. Example: `_data.expressions.foo`,
  `_data.tables.bar`, `_data.serverConnections.baz`.
- `_data.element` — the CVO's container DOM element. Query inside it:
  `_data.element.querySelector('#chart')`. Do not touch `document` outside it.
- `window.Highcharts` — the charting library, already global WHEN the page also
  renders a native chart widget. On a CVO-only page it is `undefined`. Always
  guard: `if (window.Highcharts) { ... } else { /* HTML fallback */ }`.
- `axios` is available for HTTP. Full BMP React app scope is reachable.

## Inherit, do not redeclare
The widget container already sets, and the CVO inherits:
`font-family: LatoLatinWeb`, `font-size: 12px`, `color: #343536`,
`background: #fff`. NEVER set these unless you are deliberately deviating
(e.g. `font-weight: 700` for bold, `24px` for a KPI number, a muted `#8e969f`).

## BMP color tokens (only when you must set a value)
- Backgrounds: `#ffffff` base, `#f7f7f8` zebra/alt row, `#f2faff` hover,
  `#f5f7f7` panel.
- Text: `#343536` primary (inherited), `#5c5c5c` secondary, `#8e969f` muted.
- Borders: `#e2e2e2` default, `#dee1e5` header, `#bdc3c7` strong.
- Theme1 chart palette (use for all series, in this order — Blue, Red, Green,
  Purple, Turquoise, Orange):
  `['#4572A7','#AA4643','#89A54E','#71588F','#4198AF','#DB843D']`.

## Table pattern (declare only what differs from inherited)
```css
table { width: 100%; border-collapse: collapse; }
th { background: #f5f7f7; border-bottom: 2px solid #dee1e5; padding: 8px 12px;
     font-weight: 700; font-size: 11px; color: #5c5c5c; text-transform: uppercase; }
td { padding: 6px 12px; border-bottom: 1px solid #e2e2e2; }
tr:nth-child(even) { background: #f7f7f8; }
tr:hover { background: #f2faff; }
```

## Highcharts usage (when loaded)
```js
Highcharts.chart(_data.element.querySelector('#chart'), {
  chart: { type: 'column', backgroundColor: 'transparent' },
  colors: ['#4572A7','#AA4643','#89A54E','#71588F','#4198AF','#DB843D'],
  credits: { enabled: false },
});
```

## Anti-patterns
- No external fonts, CDN scripts, or `<link>`/`<script src>` — BMP may be
  air-gapped; use only what is already loaded.
- No dark backgrounds (the portal is white-based).
- No non-Theme1 chart colors.
- No fixed pixel heights on the outer container; the widget body resizes.
- Keep animations minimal.
