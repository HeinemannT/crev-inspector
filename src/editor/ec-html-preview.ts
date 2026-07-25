/**
 * HTML output detection + inert preview document builder.
 *
 * Detection uses BMP's structured EC log entries, not the editor source. That
 * keeps conditionals, concatenation and `this` resolution authoritative. The
 * flattened log is only a compatibility fallback for older mocked responses.
 */
import type { EcOutputEntry } from '../lib/bmp-types'
import { decodeEscapes } from './ec-output'

const HTML_ELEMENT_RE = /<(?:!doctype|a|abbr|article|aside|b|blockquote|body|br|button|caption|code|col|colgroup|dd|details|div|dl|dt|em|fieldset|figcaption|figure|footer|form|h[1-6]|header|hr|html|i|img|input|label|legend|li|main|mark|nav|ol|optgroup|option|p|picture|pre|progress|section|select|small|source|span|strong|style|sub|summary|sup|svg|table|tbody|td|textarea|tfoot|th|thead|time|tr|u|ul|video)\b/i
const DURATION_RE = /^\s*Duration\s*:/i
const RESULT_NOISE_RE = /^\s*(?:|0|true|false|missing|none)\s*$/i
const BLOCKED_ELEMENTS = 'script,iframe,object,embed,link,meta,base,form'
const URL_ATTRIBUTES = new Set(['href', 'xlink:href', 'action', 'formaction', 'poster', 'data'])

export function looksLikeHtmlOutput(value: string): boolean {
  return HTML_ELEMENT_RE.test(value)
}

/**
 * Pick an HTML value only when every meaningful MESSAGE/Result entry is HTML.
 * A scalar final result such as `0` is ignored so `output("<div>…")` works.
 * Mixed debug text intentionally stays raw rather than silently hiding logs.
 */
export function extractHtmlOutput(
  entries: readonly EcOutputEntry[] | undefined,
  flattenedLog: string,
  decode: boolean,
): string | null {
  if (entries?.length) {
    if (entries.some(entry => {
      const type = entry.logType.toUpperCase()
      return type === 'WARNING' || type === 'ERROR'
    })) return null

    const meaningful = entries
      .filter(entry => !DURATION_RE.test(entry.message))
      .filter(entry => !(entry.result && RESULT_NOISE_RE.test(entry.message)))
      .map(entry => decode ? decodeEscapes(entry.message) : entry.message)
      .filter(message => message.trim() !== '')

    if (meaningful.length > 0 && meaningful.every(looksLikeHtmlOutput)) {
      return meaningful.join('\n')
    }
    return null
  }

  // Compatibility for tests/older responses that only supplied the flattened
  // log. It is deliberately all-or-nothing: mixed text never becomes HTML.
  const fallback = flattenedLog
    .split('\n')
    .filter(line => !DURATION_RE.test(line))
    .join('\n')
    .trim()
  const value = decode ? decodeEscapes(fallback) : fallback
  return value.startsWith('<') && looksLikeHtmlOutput(value) ? value : null
}

/** Remove active/navigating content before it reaches the locked iframe. */
export function sanitizeHtmlPreview(value: string): string {
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

export function buildHtmlPreviewDocument(value: string): string {
  const safe = sanitizeHtmlPreview(value)
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
</style>
</head>
<body>${safe}</body>
</html>`
}
