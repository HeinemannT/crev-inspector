/**
 * CVO dependency detection — find the BMP FileResource libraries a CVO loads,
 * so the studio can fetch their bytes (via the SW) and inject them into the
 * sandbox preview before the CVO runs (mirroring how the real CVO loads them
 * same-origin in the portal). Pure + framework-free → unit-tested.
 *
 * Two shapes are recognised, both pointing at a FileResource by rid:
 *   1. A download URL the CVO builds: /web/download?propName=content&rid=<rid>
 *      (the ERMQ host injects exactly this as a <script src>).
 *   2. A bootstrap global carrying the rid, e.g.
 *      window.__ERMQ_ECHARTS_RID = "5824982079220987066"
 *      (the rid is then used to build the download URL at runtime).
 *
 * Rids are returned as STRINGS (Java longs — never JS numbers).
 */

const DOWNLOAD_RID = /\/web\/download\?[^"'`\s]*\brid=(\d{6,})/g
const BOOTSTRAP_RID = /__[A-Za-z0-9_]*RID[A-Za-z0-9_]*\s*=\s*["'](\d{6,})["']/g

/** Unique FileResource rids referenced by a CVO's html + javascript. */
export function detectFileResourceRids(...sources: string[]): string[] {
  const rids = new Set<string>()
  const blob = sources.join('\n')
  for (const re of [DOWNLOAD_RID, BOOTSTRAP_RID]) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(blob)) !== null) rids.add(m[1])
  }
  return [...rids]
}
