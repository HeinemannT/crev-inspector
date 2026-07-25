/**
 * Shared renderer for HTML previews that must never execute or navigate.
 *
 * Callers still place the result in an iframe with `sandbox=""`. The
 * sanitizer and CSP are defence in depth: they remove active content before
 * it reaches the frame and keep the generated document self-contained.
 */
const BLOCKED_ELEMENTS = 'script,iframe,object,embed,link,meta,base,form'
const URL_ATTRIBUTES = new Set(['href', 'xlink:href', 'action', 'formaction', 'poster', 'data'])

export interface InertHtmlDocumentOptions {
  html: string
  /** Trusted CSS owned by the extension, never user-provided CSS text. */
  contentCss?: string
}

/** Remove executable, navigating and remote-loading content. */
export function sanitizeInertHtml(value: string): string {
  const template = document.createElement('template')
  template.innerHTML = value
  template.content.querySelectorAll(BLOCKED_ELEMENTS).forEach(node => node.remove())
  template.content.querySelectorAll('*').forEach(element => {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase()
      if (name.startsWith('on') || name === 'srcdoc' || URL_ATTRIBUTES.has(name)) {
        element.removeAttribute(attribute.name)
        continue
      }
      if ((name === 'src' || name === 'srcset') && !attribute.value.trim().toLowerCase().startsWith('data:image/')) {
        element.removeAttribute(attribute.name)
      }
    }
  })
  return template.innerHTML
}

export function buildInertHtmlDocument({ html, contentCss = '' }: InertHtmlDocumentOptions): string {
  const safe = sanitizeInertHtml(html)
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'">
<style>
  * { box-sizing: border-box; }
  html, body { min-height: 100%; }
  body {
    margin: 0;
    padding: 12px 14px;
    color: #343536;
    background: #fff;
    font: 12px/1.45 Lato, "Helvetica Neue", sans-serif;
  }
  table { border-collapse: collapse; }
  th, td { padding: 5px 8px; border: 1px solid #e2e2e2; text-align: left; }
  tbody tr:nth-child(even) { background: #f7f7f8; }
  a { color: #5f2bbf; text-decoration: underline; pointer-events: none; }
  ${contentCss}
</style>
</head>
<body>${safe}</body>
</html>`
}
