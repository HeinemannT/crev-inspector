/**
 * editor-core / text-nav — small, framework-free text navigation helpers shared
 * by the editor surfaces. Pure (no CodeMirror / DOM), so they're trivially
 * testable and reusable by CodeSurface's load-time jump.
 */

/** Find the 1-based line whose text contains `needle`, nearest to `hint` (the
 *  line number a caller reported, e.g. from code search). Returns 0 when no
 *  line matches. Lands a jump on the real match even when the body is a few
 *  lines off from the search-side body, and resolves duplicate lines (e.g. a
 *  lone `}`) to the intended hit. `lineText` is 1-based. */
export function pickNearestLine(
  lineText: (oneBasedIndex: number) => string,
  lineCount: number,
  needle: string,
  hint?: number,
): number {
  if (!needle) return 0
  let best = 0
  let bestDist = Infinity
  for (let i = 1; i <= lineCount; i++) {
    if (!lineText(i).includes(needle)) continue
    const dist = hint ? Math.abs(i - hint) : i
    if (dist < bestDist) {
      bestDist = dist
      best = i
      if (dist === 0) break
    }
  }
  return best
}
