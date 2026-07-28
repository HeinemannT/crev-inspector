const INDENT = '     '

export interface FormatExtendedResult {
  code: string
  changed: boolean
  safe: boolean
}

interface ScannedLine {
  mask: string
  parenDelta: number
  minParenDelta: number
  bracketDelta: number
  minBracketDelta: number
  braceDelta: number
  minBraceDelta: number
  hasComment: boolean
}

/** Replace literals/comments with spaces while retaining structural offsets. */
function scanLine(line: string): ScannedLine | null {
  let mask = ''
  let quote: '"' | "'" | null = null
  let blockComment = false
  let parenDelta = 0
  let minParenDelta = 0
  let bracketDelta = 0
  let minBracketDelta = 0
  let braceDelta = 0
  let minBraceDelta = 0
  let hasComment = false

  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    const next = line[i + 1]
    if (blockComment) {
      mask += ' '
      if (char === '*' && next === '/') {
        mask += ' '
        blockComment = false
        i++
      }
      continue
    }
    if (quote) {
      mask += ' '
      if (char === '\\' && next !== undefined) {
        mask += ' '
        i++
      } else if (char === quote) {
        quote = null
      }
      continue
    }
    if (char === '/' && next === '/') {
      hasComment = true
      mask += ' '.repeat(line.length - i)
      break
    }
    if (char === '/' && next === '*') {
      hasComment = true
      blockComment = true
      mask += '  '
      i++
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      mask += ' '
      continue
    }
    mask += char
    if (char === '(') parenDelta++
    else if (char === ')') {
      parenDelta--
      minParenDelta = Math.min(minParenDelta, parenDelta)
    } else if (char === '[') bracketDelta++
    else if (char === ']') {
      bracketDelta--
      minBracketDelta = Math.min(minBracketDelta, bracketDelta)
    } else if (char === '{') braceDelta++
    else if (char === '}') {
      braceDelta--
      minBraceDelta = Math.min(minBraceDelta, braceDelta)
    }
  }

  // Multiline strings/comments are legal-looking but unsafe to rewrite without
  // retaining lexer state and every interior whitespace byte.
  if (quote || blockComment) return null
  return {
    mask,
    parenDelta,
    minParenDelta,
    bracketDelta,
    minBracketDelta,
    braceDelta,
    minBraceDelta,
    hasComment,
  }
}

function scanDocument(lines: string[]): ScannedLine[] | null {
  const scanned: ScannedLine[] = []
  let parens = 0
  let brackets = 0
  let braces = 0
  const delimiters: string[] = []
  const ifFrames: Array<{ then: boolean; else: boolean }> = []
  for (const line of lines) {
    const item = scanLine(line)
    if (
      !item
      || parens + item.minParenDelta < 0
      || brackets + item.minBracketDelta < 0
      || braces + item.minBraceDelta < 0
    ) return null
    parens += item.parenDelta
    brackets += item.bracketDelta
    braces += item.braceDelta
    for (const char of item.mask) {
      if (char === '(' || char === '[' || char === '{') delimiters.push(char)
      else if (char === ')' && delimiters.pop() !== '(') return null
      else if (char === ']' && delimiters.pop() !== '[') return null
      else if (char === '}' && delimiters.pop() !== '{') return null
    }
    const tokens = item.mask.match(/\b(?:IF|THEN|ELSE|ENDIF)\b/gi) ?? []
    for (const token of tokens) {
      const upper = token.toUpperCase()
      const frame = ifFrames.at(-1)
      if (upper === 'IF') ifFrames.push({ then: false, else: false })
      else if (upper === 'THEN') {
        if (!frame || frame.then) return null
        frame.then = true
      } else if (upper === 'ELSE') {
        if (!frame?.then || frame.else) return null
        frame.else = true
      } else {
        if (!frame?.then) return null
        ifFrames.pop()
      }
    }
    scanned.push(item)
  }
  return delimiters.length === 0 && parens === 0 && brackets === 0 && braces === 0 && ifFrames.length === 0
    ? scanned
    : null
}

function joinFragments(parts: string[]): string {
  let result = parts[0] ?? ''
  for (const part of parts.slice(1)) {
    if (part === ')') result += part
    else if (result.endsWith('(')) result += part
    else result += ` ${part}`
  }
  return result
}

function compactParenthesizedBlocks(lines: string[], width: number): string[] {
  const out: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const firstScan = scanLine(lines[i])
    if (!firstScan || firstScan.parenDelta <= 0 || firstScan.hasComment) {
      out.push(lines[i])
      continue
    }
    let depth = firstScan.parenDelta
    let end = i
    let safe = !/\b(?:IF|THEN|ELSE|ENDIF)\b/i.test(firstScan.mask) && !/\.forEach\s*\(/i.test(firstScan.mask)
    while (depth > 0 && end + 1 < lines.length) {
      end++
      const scan = scanLine(lines[end])
      if (!scan) { safe = false; break }
      depth += scan.parenDelta
      safe &&= !scan.hasComment && !/\b(?:IF|THEN|ELSE|ENDIF)\b/i.test(scan.mask)
    }
    // Newlines can separate statements in parenthesized expression blocks. Only
    // remove them when every boundary is already explicit punctuation.
    for (let boundary = i + 1; boundary < end - 1; boundary++) {
      safe &&= /[,;]\s*$/.test(lines[boundary])
    }
    if (!safe || depth !== 0 || end === i) {
      out.push(lines[i])
      continue
    }
    const joined = joinFragments(lines.slice(i, end + 1))
    if (joined.length > width) {
      out.push(lines[i])
      continue
    }
    out.push(joined)
    i = end
  }
  return out
}

function compactControlLines(lines: string[], width: number): string[] {
  const folded: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (/^ELSE$/i.test(line) && /^IF\b/i.test(lines[i + 1] ?? '')) {
      const joined = `ELSE ${lines[i + 1]}`
      if (joined.length <= width) {
        folded.push(joined)
        i++
        continue
      }
    }
    if (/^ENDIF$/i.test(line)) {
      const closers = [line]
      while (/^ENDIF$/i.test(lines[i + 1] ?? '') && joinFragments([...closers, lines[i + 1]]).length <= width) {
        closers.push(lines[++i])
      }
      folded.push(joinFragments(closers))
      continue
    }
    folded.push(line)
  }
  return folded
}

function compactContinuations(lines: string[], width: number): string[] {
  const out: string[] = []
  const isContinuation = (line: string): boolean =>
    /^(?:FROM|WHERE|AND|OR|ORDER\s+BY)\b/i.test(line) || /^\./.test(line)
  for (let i = 0; i < lines.length; i++) {
    const group = [lines[i]]
    while (isContinuation(lines[i + 1] ?? '')) group.push(lines[++i])
    const joined = joinFragments(group)
    if (group.length > 1 && joined.length <= width && group.every(line => !scanLine(line)?.hasComment)) {
      out.push(joined)
    } else {
      out.push(...group)
    }
  }
  return out
}

function topLevelMethodOffsets(mask: string): number[] {
  const offsets: number[] = []
  const delimiters: string[] = []
  for (let i = 0; i < mask.length; i++) {
    const char = mask[i]
    if (char === '(' || char === '[' || char === '{') delimiters.push(char)
    else if (char === ')' || char === ']' || char === '}') delimiters.pop()
    else if (char === '.' && delimiters.length === 0 && /^\.[A-Za-z_]\w*\s*\(/.test(mask.slice(i))) offsets.push(i)
  }
  return offsets
}

function wrapLongMethodChains(lines: string[], width: number): string[] {
  const out: string[] = []
  for (const line of lines) {
    const scan = scanLine(line)
    if (!scan || scan.hasComment || line.length <= width) {
      out.push(line)
      continue
    }
    const offsets = topLevelMethodOffsets(scan.mask)
    if (offsets.length < 2) {
      out.push(line)
      continue
    }
    const breaks = offsets.slice(1)
    let start = 0
    for (const offset of breaks) {
      out.push(line.slice(start, offset).trim())
      start = offset
    }
    out.push(line.slice(start).trim())
  }
  return out
}

function outerCallBounds(mask: string): { open: number; close: number; commas: number[] } | null {
  const open = mask.indexOf('(')
  if (open < 0 || /\b(?:IF|THEN|ELSE|ENDIF)\b/i.test(mask)) return null
  let depth = 0
  let close = -1
  const commas: number[] = []
  for (let i = open; i < mask.length; i++) {
    const char = mask[i]
    if (char === '(') depth++
    else if (char === ')') {
      depth--
      if (depth === 0) { close = i; break }
    } else if (char === ',' && depth === 1) commas.push(i)
    else if (char === ':' && depth === 1 && mask[i + 1] !== '=') return null
  }
  if (close < 0 || mask.slice(close + 1).trim() || commas.length === 0) return null
  return { open, close, commas }
}

function wrapLongCalls(lines: string[], width: number): string[] {
  const out: string[] = []
  for (const line of lines) {
    const scan = scanLine(line)
    if (!scan || scan.hasComment || line.length <= width) {
      out.push(line)
      continue
    }
    const bounds = outerCallBounds(scan.mask)
    if (!bounds) {
      out.push(line)
      continue
    }
    out.push(line.slice(0, bounds.open + 1).trimEnd())
    let start = bounds.open + 1
    for (const comma of bounds.commas) {
      out.push(`${line.slice(start, comma).trim()},`)
      start = comma + 1
    }
    out.push(line.slice(start, bounds.close).trim(), line.slice(bounds.close).trim())
  }
  return out
}

function topLevelKeywordOffsets(mask: string): number[] {
  const offsets: number[] = []
  const delimiters: string[] = []
  const keyword = /^(?:FROM|WHERE|ORDER\s+BY|AND|OR)\b/i
  for (let i = 0; i < mask.length; i++) {
    const char = mask[i]
    if (char === '(' || char === '[' || char === '{') delimiters.push(char)
    else if (char === ')' || char === ']' || char === '}') delimiters.pop()
    else if (delimiters.length === 0 && keyword.test(mask.slice(i)) && (i === 0 || /\s/.test(mask[i - 1]))) offsets.push(i)
  }
  return offsets
}

function keywordOffset(mask: string, keyword: string): number {
  const match = new RegExp(`\\b${keyword}\\b`, 'i').exec(mask)
  return match?.index ?? -1
}

function wrapLongSelect(lines: string[], width: number): string[] {
  const out: string[] = []
  for (const line of lines) {
    const scan = scanLine(line)
    if (!scan || line.length <= width || keywordOffset(scan.mask, 'SELECT') < 0) {
      out.push(line)
      continue
    }
    const offsets = topLevelKeywordOffsets(scan.mask).filter(offset => offset > 0)
    if (offsets.length === 0) {
      out.push(line)
      continue
    }
    const major = offsets.find(offset => /^(?:WHERE|ORDER\s+BY)\b/i.test(scan.mask.slice(offset)))
    const pending = major === undefined
      ? [line]
      : [line.slice(0, major).trim(), line.slice(major).trim()]
    for (const part of pending) {
      if (part.length <= width) {
        out.push(part)
        continue
      }
      const partScan = scanLine(part)!
      const partOffsets = topLevelKeywordOffsets(partScan.mask).filter(offset => offset > 0)
      let start = 0
      while (part.length - start > width) {
        const candidates = partOffsets.filter(offset => offset > start)
        if (candidates.length === 0) break
        const fitting = candidates.filter(offset => offset - start <= width)
        const end = fitting.at(-1) ?? candidates[0]
        out.push(part.slice(start, end).trim())
        start = end
      }
      out.push(part.slice(start).trim())
    }
  }
  return out
}

function leadingEndifCount(mask: string): number {
  const prefix = /^(?:ENDIF\s*)+/i.exec(mask)?.[0] ?? ''
  return prefix.match(/\bENDIF\b/gi)?.length ?? 0
}

function leadingParenClosers(mask: string): number {
  return /^\)+/.exec(mask)?.[0].length ?? 0
}

function indentLines(lines: string[]): string[] {
  const out: string[] = []
  const ifFrames: boolean[] = [] // true = visually flattened ELSE IF frame
  let parenDepth = 0
  let previousBlank = false

  for (const content of lines) {
    if (!content) {
      if (!previousBlank && out.length) out.push('')
      previousBlank = true
      continue
    }
    previousBlank = false
    const scan = scanLine(content)!
    const endifCount = leadingEndifCount(scan.mask)
    const remainingFrames = ifFrames.slice(0, Math.max(0, ifFrames.length - endifCount))
    const hiddenFrames = remainingFrames.filter(Boolean).length
    const startsElse = /^ELSE\b/i.test(scan.mask)
    const compactElseIf = /^ELSE\s+IF\b/i.test(scan.mask)
    const blockLevel = endifCount > 0
      ? remainingFrames.length - hiddenFrames
      : startsElse
        ? Math.max(0, ifFrames.length - 1 - ifFrames.filter(Boolean).length)
        : ifFrames.length - ifFrames.filter(Boolean).length
    const parenLevel = Math.max(0, parenDepth - leadingParenClosers(scan.mask))
    const continuation = /^(?:FROM|WHERE|AND|OR|ORDER\s+BY)\b/i.test(scan.mask) || /^\./.test(scan.mask)
    const level = Math.max(0, blockLevel + parenLevel + (continuation && parenLevel === 0 ? 1 : 0))
    out.push(INDENT.repeat(level) + content)

    let firstThen = true
    for (const token of scan.mask.match(/\b(?:THEN|ENDIF)\b/gi) ?? []) {
      if (token.toUpperCase() === 'THEN') {
        ifFrames.push(compactElseIf && firstThen)
        firstThen = false
      } else {
        ifFrames.pop()
      }
    }
    parenDepth = Math.max(0, parenDepth + scan.parenDelta)
  }
  while (out.at(-1) === '') out.pop()
  return out
}

/** Conservative compact formatter. Unsafe/incomplete input is returned byte-for-byte. */
export function formatExtendedCode(source: string, width = 140): FormatExtendedResult {
  const original = source
  const newlineNormalized = source.replace(/\r\n?/g, '\n')
  const rawLines = newlineNormalized.split('\n')
  if (!scanDocument(rawLines)) return { code: original, changed: false, safe: false }

  let lines = rawLines.map(line => line.trim())
  lines = compactParenthesizedBlocks(lines, width)
  lines = compactControlLines(lines, width)
  lines = compactContinuations(lines, width)
  // Wrapping an outer call can expose a nested call or chain. These passes only
  // split lines, so reaching a fixed point is finite and preserves idempotence.
  while (true) {
    let wrapped = wrapLongSelect(lines, width)
    wrapped = wrapLongMethodChains(wrapped, width)
    wrapped = wrapLongCalls(wrapped, width)
    if (wrapped.length === lines.length && wrapped.every((line, index) => line === lines[index])) break
    lines = wrapped
  }
  const code = indentLines(lines).join('\n')
  return { code, changed: code !== original, safe: true }
}
