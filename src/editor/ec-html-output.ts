/**
 * HTML output detection for Extended Code results.
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
