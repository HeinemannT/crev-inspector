# TextElement HTML bodies (`text` / `longText`)

A TextElement widget has two HTML properties: `text` (shown inline) and
`longText` (shown behind BMP's native SHOW MORE toggle). Both are HTML fragments
that render inside BMP's widget container.

## Rules
- **BMP sanitizes this HTML on save.** It runs a strict whitelist and strips
  style properties it does not allow — notably `border-radius`, gradients,
  box shadows, transforms, and most positioning. Do not rely on those; they will
  silently disappear after saving.
- Keep the markup simple: headings, paragraphs, lists, tables, spans, basic
  inline styles (color, font-weight, text-align, padding, background). Inline
  `style="..."` on elements is the reliable way to style.
- The body **inherits** the container's `font-family` (LatoLatinWeb), `12px`
  font size, and `#343536` text color. Only set these when deviating.
- No `<script>`, no external resources, no CDN links — content is static HTML.
- The extension's preview shows the RAW draft. What BMP stores after its
  sanitizer runs may differ; the save path reports what was rewritten.

## Example
```html
<div style="padding:8px 0">
  <p style="font-weight:700;color:#5c5c5c">Summary</p>
  <p>Plain paragraph text inherits the BMP font and color.</p>
</div>
```
