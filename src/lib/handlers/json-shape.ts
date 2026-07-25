import { register } from '../handler-registry'
import { getCtx } from '../sw-context'
import { errorMessage, log } from '../logger'
import { inferJsonShape } from '../json-shape'
import { parseSafeJsonReadExpression } from '../json-read-expression'

const DURATION_RE = /^\s*Duration\s*:/i
const RESULT_NOISE_RE = /^\s*(?:|0|true|false|missing|none)\s*$/i

register('JSON_SHAPE_READ', async (msg, respond) => {
  const safe = parseSafeJsonReadExpression(msg.source)
  if (!safe) {
    respond({ type: 'JSON_SHAPE_RESULT', ok: false, error: 'Unsupported JSON source' })
    return
  }

  const ctx = getCtx()
  if (!ctx.client) {
    respond({ type: 'JSON_SHAPE_RESULT', ok: false, error: 'Not connected' })
    return
  }

  const started = Date.now()
  try {
    const result = await ctx.client.executeEc(`output(${safe.normalized})`, msg.objectRid, false)
    if (!result.ok || result.hasError || result.hasWarning) {
      respond({ type: 'JSON_SHAPE_RESULT', ok: false, error: result.error ?? 'BMP could not read this JSON source' })
      return
    }

    const entries = result.outputEntries ?? []
    if (entries.some(entry => {
      const type = entry.logType.toUpperCase()
      return type === 'ERROR' || type === 'WARNING'
    })) {
      respond({ type: 'JSON_SHAPE_RESULT', ok: false, error: 'BMP reported a problem while reading this JSON source' })
      return
    }
    const meaningful = entries
      .filter(entry => !DURATION_RE.test(entry.message))
      .filter(entry => !(entry.result && RESULT_NOISE_RE.test(entry.message)))
      .filter(entry => entry.message.trim() !== '')

    if (meaningful.length !== 1) {
      respond({
        type: 'JSON_SHAPE_RESULT',
        ok: false,
        error: meaningful.length === 0 ? 'JSON source returned no value' : 'JSON source returned ambiguous output',
      })
      return
    }

    const raw = meaningful[0].message
    const shape = inferJsonShape(raw)
    log.debug('handler:jsonShape', `Read JSON shape (${new TextEncoder().encode(raw).byteLength} bytes, ${Date.now() - started}ms)`)
    respond({ type: 'JSON_SHAPE_RESULT', ok: true, shape })
  } catch (error) {
    respond({ type: 'JSON_SHAPE_RESULT', ok: false, error: errorMessage(error) })
  }
})
