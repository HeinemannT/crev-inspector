import { readFileSync } from 'node:fs'

export interface IntegrationTarget {
  bridgeUrl: string
  bmpUrl: string
  bmpUser: string
  bmpPass: string
}

interface ServersFile {
  activeIds?: Record<string, string>
  servers?: Array<{ id?: string; bmpUrl?: string }>
  credentials?: Record<string, Record<string, { bmpUser?: string; bmpPass?: string }>>
}

const withSlash = (url: string): string => url.endsWith('/') ? url : `${url}/`

/**
 * Resolve the live integration target without embedding credentials in this public repository.
 * Either provide CREV_BMP_URL/USER/PASS directly, or point CREV_SERVERS_FILE at CREV's ignored
 * servers.json and select a server/actor. Missing configuration is a hard error: an integration
 * command must never pass by silently skipping the live contract.
 */
export function integrationTarget(): IntegrationTarget {
  const bridgeUrl = process.env.CREV_BRIDGE_URL || 'http://127.0.0.1:4100'
  const envUrl = process.env.CREV_BMP_URL
  const envUser = process.env.CREV_BMP_USER
  const envPass = process.env.CREV_BMP_PASS
  if (envUrl && envUser && envPass) {
    return { bridgeUrl, bmpUrl: withSlash(envUrl), bmpUser: envUser, bmpPass: envPass }
  }

  const file = process.env.CREV_SERVERS_FILE
  if (file) {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as ServersFile
    const serverId = process.env.CREV_SERVER_ID || 'steadfast'
    const server = parsed.servers?.find(s => s.id === serverId)
    const actors = parsed.credentials?.[serverId]
    const actor = process.env.CREV_SERVER_ACTOR || parsed.activeIds?.[serverId] || (actors ? Object.keys(actors)[0] : undefined)
    const credential = actor ? actors?.[actor] : undefined
    if (server?.bmpUrl && credential?.bmpUser && credential.bmpPass) {
      return {
        bridgeUrl,
        bmpUrl: withSlash(server.bmpUrl),
        bmpUser: credential.bmpUser,
        bmpPass: credential.bmpPass,
      }
    }
    throw new Error(`CREV_SERVERS_FILE has no complete ${serverId}/${actor ?? '(no actor)'} target`)
  }

  throw new Error(
    'Live integration target missing. Set CREV_BMP_URL, CREV_BMP_USER and CREV_BMP_PASS, '
    + 'or set CREV_SERVERS_FILE (plus optional CREV_SERVER_ID/CREV_SERVER_ACTOR).',
  )
}

export interface DiscoveryRow {
  rid: string
  businessId: string
  type: string
  name: string
}

const DELIM = '|||'

export function buildDiscoveryEc(className: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(className)) throw new Error(`Unsafe BMP class name: ${className}`)
  return [
    `_list := SELECT ${className} FROM root`,
    '_r := ""',
    '_list.forEach(_o:',
    `  _r := _r + _o.rid + "${DELIM}" + _o.id.whenMissing("") + "${DELIM}" + _o.className.whenMissing("") + "${DELIM}" + _o.name.whenMissing("") + "\\n"`,
    ')',
    '_r',
  ].join('\n')
}

export function parseDiscoveryRows(log: string | null | undefined): DiscoveryRow[] {
  if (!log) return []
  const rows: DiscoveryRow[] = []
  for (const raw of log.split('\n')) {
    const line = raw.replace(/^Message\s*:\s*Result\s*:\s*/, '').trim()
    if (!line.includes(DELIM)) continue
    const [rid, businessId, type, ...name] = line.split(DELIM)
    if (!/^\d+$/.test(rid ?? '') || !type) continue
    rows.push({ rid, businessId: businessId ?? '', type, name: name.join(DELIM) })
  }
  return rows
}

interface BridgeResponse {
  ok?: boolean
  error?: string
  result?: { log?: string | string[]; has_error?: boolean }
}

/** Match BmpClient.parseEcResults(): the bridge exposes display-formatted log
 * lines, while the extension consumes each LogEntry's decoded message and
 * removes BMP's `Result : ` wrapper. */
function normalizeBridgeLog(log: string | string[] | undefined): string {
  const raw = Array.isArray(log) ? log.join('\n') : log ?? ''
  return raw.split(/\r?\n/).map(line => line
    .replace(/^(?:Message|Warning|Error|Soft error)\s*:\s*/, '')
    .replace(/^Result\s*:\s*/, '')
  ).join('\n')
}

export async function bridgePreview(target: IntegrationTarget, code: string): Promise<string> {
  let lastError = 'Bridge preview failed'
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${target.bridgeUrl}/extended`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code,
          bmp_url: target.bmpUrl,
          bmp_user: target.bmpUser,
          bmp_pass: target.bmpPass,
          transactional: false,
        }),
      })
      const data = await res.json() as BridgeResponse
      if (res.ok && data.ok && !data.result?.has_error) {
        return normalizeBridgeLog(data.result?.log)
      }
      lastError = data.error || (Array.isArray(data.result?.log) ? data.result.log.join('\n') : data.result?.log) || `Bridge HTTP ${res.status}`
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    // Live previews are read-only, so one retry is safe. Keep it restricted to
    // transport interruptions; BMP/EC contract errors must fail immediately.
    if (attempt === 0 && /premature eof|connection reset|timed? out|fetch failed/i.test(lastError)) continue
    throw new Error(lastError)
  }
  throw new Error(lastError)
}
