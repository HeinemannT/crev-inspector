/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest'
import type { EcOutputEntry } from '../../lib/bmp-types'
import {
  extractHtmlOutput,
  looksLikeHtmlOutput,
} from '../ec-html-output'

const entry = (
  message: string,
  options: Partial<EcOutputEntry> = {},
): EcOutputEntry => ({
  logType: 'MESSAGE',
  result: false,
  message,
  ...options,
})

describe('HTML output detection', () => {
  it('recognizes meaningful elements without treating comparisons as HTML', () => {
    expect(looksLikeHtmlOutput('<div>Ready</div>')).toBe(true)
    expect(looksLikeHtmlOutput('Name: <strong>Ready</strong>')).toBe(true)
    expect(looksLikeHtmlOutput('if a < b then')).toBe(false)
    expect(looksLikeHtmlOutput('plain text')).toBe(false)
  })

  it('uses the authoritative result and ignores a scalar EC result', () => {
    const entries = [
      entry('<span>Open</span>'),
      entry('0', { result: true }),
      entry('Duration : 4ms'),
    ]
    expect(extractHtmlOutput(entries, '', true)).toBe('<span>Open</span>')
  })

  it('joins several HTML fragments in server order', () => {
    const entries = [
      entry('<style>.x{color:red}</style>'),
      entry('<div class="x">Risk</div>'),
      entry('0', { result: true }),
    ]
    expect(extractHtmlOutput(entries, '', true))
      .toBe('<style>.x{color:red}</style>\n<div class="x">Risk</div>')
  })

  it('decodes escaped line breaks only when the Output preference is on', () => {
    const entries = [entry('<div>One\\nTwo</div>', { result: true })]
    expect(extractHtmlOutput(entries, '', true)).toBe('<div>One\nTwo</div>')
    expect(extractHtmlOutput(entries, '', false)).toBe('<div>One\\nTwo</div>')
  })

  it('refuses mixed debug text and any warning/error output', () => {
    expect(extractHtmlOutput([
      entry('debug: branch A'),
      entry('<div>A</div>', { result: true }),
    ], '', true)).toBeNull()
    expect(extractHtmlOutput([
      entry('<div>A</div>', { result: true }),
      entry('Check this', { logType: 'WARNING' }),
    ], '', true)).toBeNull()
  })

  it('supports the flattened-log compatibility path conservatively', () => {
    expect(extractHtmlOutput(undefined, '<p>Legacy</p>\nDuration : 2ms', true))
      .toBe('<p>Legacy</p>')
    expect(extractHtmlOutput(undefined, 'debug\n<p>Legacy</p>', true)).toBeNull()
  })
})
