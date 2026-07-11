/**
 * Minimal Server-Sent-Events reader shared by both provider dialects. Reads a
 * fetch Response body line by line and dispatches `{ event, data }` frames. It
 * does not interpret the payload — the caller (anthropic.ts / openai-compat.ts)
 * decides what each event means.
 *
 * SSE framing: lines beginning `event:` set the current event name; lines
 * beginning `data:` carry a payload; a blank line ends one event and resets the
 * event name to the default (empty string). Our providers emit one `data:` line
 * per event, so we dispatch on each `data:` line with the current event name.
 */

export interface SseFrame {
  event: string;
  data: string;
}

/** Read `response.body` as SSE, calling `onFrame` for every `data:` line.
 *  Honors an AbortSignal via the underlying fetch (the reader throws/settles
 *  when aborted). */
export async function readSse(response: Response, onFrame: (frame: SseFrame) => void): Promise<void> {
  const body = response.body;
  if (!body) throw new Error('Response has no body to stream');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let event = '';

  const flushLine = (raw: string) => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line === '') { event = ''; return; }
    if (line.startsWith(':')) return; // comment / keep-alive
    if (line.startsWith('event:')) { event = line.slice(6).trim(); return; }
    if (line.startsWith('data:')) { onFrame({ event, data: line.slice(5).trim() }); return; }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const raw = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      flushLine(raw);
    }
  }
  // Flush any trailing line (some servers omit a final newline).
  buffer += decoder.decode();
  if (buffer.length > 0) flushLine(buffer);
}
