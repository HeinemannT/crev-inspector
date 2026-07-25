/** @vitest-environment happy-dom */
import { describe, expect, it } from 'vitest'
import { STUDIO_MODES } from '../studio-mode'

describe('TextElement preview', () => {
  it('uses an inert native disclosure without executable controls', () => {
    const doc = STUDIO_MODES.text.buildPreviewDoc?.({
      text: '<strong>Summary</strong><script>alert(1)</script>',
      longText: '<em>Details</em>',
    }) ?? ''

    expect(doc).toContain("default-src 'none'")
    expect(doc).toContain('<details class="te-details">')
    expect(doc).toContain('<summary>')
    expect(doc).toContain('<strong>Summary</strong>')
    expect(doc).toContain('<em>Details</em>')
    expect(doc).not.toContain('<script')
    expect(doc).not.toContain('onclick')
  })

  it('omits the disclosure when long text is empty', () => {
    const doc = STUDIO_MODES.text.buildPreviewDoc?.({
      text: '<p>Only summary</p>',
      longText: '  ',
    }) ?? ''

    expect(doc).not.toContain('<details')
  })
})
