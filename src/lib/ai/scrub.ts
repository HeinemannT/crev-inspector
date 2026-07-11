/**
 * Tool-markup scrubber for chat text deltas.
 *
 * When the orchestrator drops the `tools` param to force a final answer (tool
 * budget exhausted), some providers — notably DeepSeek — emit their tool-call
 * DSL as PLAIN TEXT instead of a structured tool call. Verbatim leaks seen in
 * the chat include DeepSeek's DSML family:
 *
 *   <｜｜DSML｜｜tool_calls>
 *   <｜｜DSML｜｜invoke name="search_objects">
 *   <｜｜DSML｜｜parameter name="query">risk<｜｜DSML｜｜/parameter>
 *   <｜｜DSML｜｜/tool_calls>
 *
 * These must never reach the transcript. This scrubber strips any DSML-style
 * fenced token — a `<｜…>` (fullwidth or ASCII vertical bar) marker — and
 * swallows the whole tool-call container (`tool_calls` / `function_calls` /
 * `invoke`) including the text between its open and close tokens.
 *
 * CRITICAL: markers split across stream chunks. The scrubber is stateful and
 * holds back a small suspicious tail (an incomplete token, or a lone trailing
 * `<`) rather than regexing each delta independently. `feed()` returns the
 * safe-to-emit text; `flush()` returns any remaining safe text at stream end
 * (and drops a dangling partial marker / unclosed block).
 */

/** Container tags whose open→close span (and inner text) is swallowed whole. */
const CONTAINER_RE = /(tool_calls|function_calls|tool_call|invoke)/i;

/** First index of a marker LEAD (`<` immediately followed by a vertical bar,
 *  fullwidth `｜` U+FF5C or ASCII `|`), or -1. */
function firstMarker(buf: string): number {
  const m = /<[｜|]/.exec(buf);
  return m ? m.index : -1;
}

/** Classify a complete DSML token `<｜…>`. */
function classify(token: string): 'open' | 'close' | 'other' {
  if (!CONTAINER_RE.test(token)) return 'other';
  return /\//.test(token) ? 'close' : 'open';
}

export class ToolMarkupScrubber {
  private buf = '';
  /** Container nesting depth — while > 0 all text is swallowed. */
  private depth = 0;

  /** Feed one raw delta; returns the text that is safe to emit now. */
  feed(delta: string): string {
    this.buf += delta;
    let out = '';
    for (;;) {
      const openIdx = firstMarker(this.buf);
      if (openIdx === -1) {
        // No marker start in the buffer. Emit everything except a possible
        // trailing `<` (which could become `<｜` on the next chunk).
        let end = this.buf.length;
        if (this.buf.endsWith('<')) end -= 1;
        if (this.depth === 0) out += this.buf.slice(0, end);
        this.buf = this.buf.slice(end);
        break;
      }
      // Text before the marker is safe (unless we're inside a container).
      if (this.depth === 0) out += this.buf.slice(0, openIdx);
      this.buf = this.buf.slice(openIdx);
      const gt = this.buf.indexOf('>');
      if (gt === -1) break; // incomplete token — hold and wait for more.
      const token = this.buf.slice(0, gt + 1);
      const kind = classify(token);
      if (kind === 'open') this.depth++;
      else if (kind === 'close') this.depth = Math.max(0, this.depth - 1);
      // Every DSML token itself is dropped, never emitted.
      this.buf = this.buf.slice(gt + 1);
    }
    return out;
  }

  /** End of stream — emit any remaining safe text; drop a dangling partial
   *  marker or the tail of an unclosed container. */
  flush(): string {
    let out = '';
    if (this.depth === 0) {
      const partial = this.buf === '<' || /^<[｜|]/.test(this.buf);
      if (!partial) out = this.buf;
    }
    this.buf = '';
    this.depth = 0;
    return out;
  }
}

/** One-shot scrub of a complete string (defence for already-committed text). */
export function scrubToolMarkup(text: string): string {
  const s = new ToolMarkupScrubber();
  return s.feed(text) + s.flush();
}
