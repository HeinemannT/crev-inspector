/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest'
import { buildInertHtmlDocument, sanitizeInertHtml } from '../inert-html'

describe('inert HTML preview', () => {
  it('removes executable, navigating and remote-loading content', () => {
    const safe = sanitizeInertHtml(`
      <script>alert(1)</script>
      <iframe srcdoc="<script>alert(2)</script>"></iframe>
      <form action="https://example.com"><button onclick="go()">Go</button></form>
      <a href="https://example.com" onmouseover="go()">Link</a>
      <img src="https://example.com/a.png" onerror="go()">
      <img src="data:image/png;base64,AAAA">
    `)
    expect(safe).not.toContain('<script')
    expect(safe).not.toContain('<iframe')
    expect(safe).not.toContain('<form')
    expect(safe).not.toContain('onclick')
    expect(safe).not.toContain('onmouseover')
    expect(safe).not.toContain('onerror')
    expect(safe).not.toContain('https://')
    expect(safe).toContain('data:image/png;base64,AAAA')
  })

  it('builds a BMP-styled document with a restrictive CSP and trusted caller styles', () => {
    const doc = buildInertHtmlDocument({
      html: '<strong>Ready</strong>',
      contentCss: '.example { display: block; }',
    })
    expect(doc).toContain("default-src 'none'")
    expect(doc).toContain("form-action 'none'")
    expect(doc).toContain('font: 12px/1.45 Lato')
    expect(doc).toContain('.example { display: block; }')
    expect(doc).toContain('<strong>Ready</strong>')
  })
})
