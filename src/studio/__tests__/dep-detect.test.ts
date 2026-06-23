/**
 * Detection of the FileResource libraries a CVO loads — drives the studio's
 * dependency loader (fetch the bytes, inject before the CVO).
 */
import { describe, it, expect } from 'vitest'
import { detectFileResourceRids, detectCdnUrls } from '../dep-detect'

describe('detectFileResourceRids', () => {
  it('finds rids in /web/download?propName=content&rid= script srcs', () => {
    const js = `frame.innerHTML='<script src="/Steadfast/web/download?propName=content&rid=5824982079220987066"></scr'+'ipt>'`
    expect(detectFileResourceRids(js)).toEqual(['5824982079220987066'])
  })

  it('finds rids in bootstrap globals (window.__*_RID = "...")', () => {
    expect(detectFileResourceRids(`window.__ERMQ_ECHARTS_RID="5824982079220987066";`)).toEqual(['5824982079220987066'])
  })

  it('dedupes across html + js and both shapes', () => {
    const html = `<img src="/ws/web/download?propName=content&rid=111111111111">`
    const js = `__FOO_RID = "111111111111"; __BAR_RID="222222222222";`
    expect(detectFileResourceRids(html, js).sort()).toEqual(['111111111111', '222222222222'])
  })

  it('ignores short numbers and matches nothing when absent', () => {
    expect(detectFileResourceRids('rid=42 and __X_RID="9" and plain text')).toEqual([])
  })
})

describe('detectCdnUrls', () => {
  it('flags external http(s) script sources, deduped', () => {
    const html = `<script src="https://cdn.jsdelivr.net/npm/echarts/dist/echarts.min.js"></script>`
    const js = `s.src='https://cdn.jsdelivr.net/npm/echarts/dist/echarts.min.js'; t.src="http://x.com/a.js"`
    expect(detectCdnUrls(html, js).sort()).toEqual([
      'http://x.com/a.js',
      'https://cdn.jsdelivr.net/npm/echarts/dist/echarts.min.js',
    ])
  })

  it('does not flag the same-origin download servlet', () => {
    expect(detectCdnUrls(`<script src="/ws/web/download?propName=content&rid=111111111111">`)).toEqual([])
  })
})
