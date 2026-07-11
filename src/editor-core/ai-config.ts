/**
 * Lightweight AI-config probe, split out from ai-assist.ts on purpose.
 *
 * ai-assist.ts statically pulls in `@codemirror/merge` (~270 KB, the edit-diff
 * overlay). Editor / studio surfaces must be able to ASK whether AI is
 * configured without paying that cost, then dynamically import ai-assist only
 * when a provider key actually exists. Keeping fetchAiConfig here — with no
 * merge dependency — is what makes that lazy load possible.
 */

import { sendRequest } from '../lib/messaging'

export interface AiConfigInfo {
  configured: boolean
  provider?: string
  model?: string
}

/** One-shot config probe so a surface knows whether to render its entry point. */
export async function fetchAiConfig(): Promise<AiConfigInfo> {
  const r = await sendRequest({ type: 'AI_GET_CONFIG' })
  return r?.type === 'AI_CONFIG_DATA'
    ? { configured: r.configured, provider: r.provider, model: r.model }
    : { configured: false }
}
