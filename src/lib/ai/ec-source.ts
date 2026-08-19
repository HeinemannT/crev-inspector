/** Strip EC comments and, optionally, string contents while preserving line
 * structure so lightweight draft checks cannot be satisfied by inert text. */
function scrubEc(code: string, stripStrings: boolean): string {
  let output = '';
  let quote = '';
  let blockComment = false;
  for (let index = 0; index < code.length; index++) {
    const char = code[index];
    const next = code[index + 1];
    if (blockComment) {
      if (char === '*' && next === '/') {
        output += '  ';
        index += 1;
        blockComment = false;
      } else {
        output += char === '\n' ? '\n' : ' ';
      }
      continue;
    }
    if (quote) {
      if (char === '\\') {
        output += stripStrings ? '  ' : char + (next ?? '');
        index += 1;
      } else if (char === quote) {
        quote = '';
        output += stripStrings ? ' ' : char;
      } else {
        output += stripStrings ? (char === '\n' ? '\n' : ' ') : char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      output += stripStrings ? ' ' : char;
      continue;
    }
    if (char === '/' && next === '*') {
      output += '  ';
      index += 1;
      blockComment = true;
      continue;
    }
    if ((char === '/' && next === '/') || (char === '-' && next === '-')) {
      while (index < code.length && code[index] !== '\n') index += 1;
      output += '\n';
      continue;
    }
    output += char;
  }
  return output;
}

export function ecCodeWithoutComments(code: string): string {
  return scrubEc(code, false);
}

export function ecExecutableText(code: string): string {
  return scrubEc(code, true);
}

const STABLE_REFERENCE_ASSIGNMENT = new RegExp(
  String.raw`^[ \t]*(_[A-Za-z][A-Za-z0-9_]*)[ \t]*:=[ \t]*(lookup\(\s*(["'])(-?\d+)\3\s*\)|[tor]\.[A-Za-z_][A-Za-z0-9_]*|_[A-Za-z][A-Za-z0-9_]*)[ \t]*$`,
  'gm',
);

/** Resolve only local aliases bound to stable object references. This is an
 * evaluation convenience, not an EC interpreter: mutation results, method
 * calls, expressions, and arbitrary values are deliberately ignored. */
function stableReferenceAliases(code: string): Map<string, string> {
  const commentless = ecCodeWithoutComments(code);
  const executable = ecExecutableText(code);
  const bindings = new Map<string, string>();
  for (const match of commentless.matchAll(STABLE_REFERENCE_ASSIGNMENT)) {
    const offset = (match.index ?? 0) + match[0].indexOf(match[1]);
    if (executable.slice(offset, offset + match[1].length) !== match[1]) continue;
    const reference = match[4] !== undefined ? `lookup("${match[4]}")` : match[2];
    bindings.set(match[1], reference);
  }

  const resolved = new Map<string, string>();
  const resolve = (name: string, seen = new Set<string>()): string | undefined => {
    if (seen.has(name)) return undefined;
    const value = bindings.get(name);
    if (!value) return undefined;
    if (!value.startsWith('_')) return value;
    seen.add(name);
    return resolve(value, seen);
  };
  for (const name of bindings.keys()) {
    const value = resolve(name);
    if (value) resolved.set(name, value);
  }
  return resolved;
}

function replaceAliasesOutsideStrings(source: string, aliases: ReadonlyMap<string, string>): string {
  let output = '';
  let quote = '';
  for (let index = 0; index < source.length;) {
    const char = source[index];
    if (quote) {
      output += char;
      if (char === '\\') {
        output += source[index + 1] ?? '';
        index += 2;
        continue;
      }
      if (char === quote) quote = '';
      index++;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      output += char;
      index++;
      continue;
    }
    if (char === '_' && /[A-Za-z]/.test(source[index + 1] ?? '')) {
      let end = index + 2;
      while (/[A-Za-z0-9_]/.test(source[end] ?? '')) end++;
      const name = source.slice(index, end);
      output += aliases.get(name) ?? name;
      index = end;
      continue;
    }
    output += char;
    index++;
  }
  return output;
}

/** Return EC text suitable for deterministic matching with stable-reference
 * aliases expanded. Strings may be retained for deferred-source assertions or
 * scrubbed for executable-only assertions. */
export function ecEvaluationTextWithResolvedAliases(code: string, stripStrings = false): string {
  const aliases = stableReferenceAliases(code);
  const source = stripStrings ? ecExecutableText(code) : ecCodeWithoutComments(code);
  return aliases.size ? replaceAliasesOutsideStrings(source, aliases) : source;
}

/** True when executable EC contains a state-changing operation. This is a
 * loop-control signal, not a safety verdict: Preview remains authoritative. */
export function hasStateChangingEc(code: string): boolean {
  const executable = ecExecutableText(code);
  return /\.\s*(?:add|change|delete|reset|link|unlink)\s*\(/i.test(executable)
    || /\b(?:[to]\.[A-Za-z0-9_]+|_[A-Za-z][A-Za-z0-9_]*|lookup\s*\([^)]*\))\s*\.\s*[A-Za-z_][A-Za-z0-9_]*\s*:=/i.test(executable);
}

/** Whether executable EC assigns a deferred expression property. The final
 * ticket, not wording in the user's request, decides whether the two-stage
 * expression + outer Preview is needed. */
export function hasDeferredExpressionAssignment(code: string): boolean {
  return /\bexpression\s*:=/i.test(ecExecutableText(code));
}

function decodeEcEscape(char: string): string {
  switch (char) {
    case 'n': return '\n';
    case 'r': return '\r';
    case 't': return '\t';
    case '\\': return '\\';
    case '"': return '"';
    case "'": return "'";
    default: return char;
  }
}

/** Extract a statically authored deferred `expression := ...` source string.
 * Supports the forms models normally emit: one quoted literal or a `+` chain
 * of quoted literals (often joined with "\n"). Dynamic variables/functions
 * deliberately return null rather than being guessed or evaluated. */
export function extractDeferredExpressionSource(code: string): string | null {
  const executable = ecExecutableText(code);
  const assignment = /\bexpression\s*:=/i.exec(executable);
  if (!assignment) return null;
  let index = assignment.index + assignment[0].length;
  let source = '';
  let literals = 0;

  const skipWhitespace = (): void => {
    while (/\s/.test(code[index] ?? '')) index++;
  };
  for (;;) {
    skipWhitespace();
    const quote = code[index];
    if (quote !== '"' && quote !== "'") return null;
    index++;
    literals++;
    let closed = false;
    while (index < code.length) {
      const char = code[index++];
      if (char === '\\') {
        if (index >= code.length) return null;
        source += decodeEcEscape(code[index++]);
      } else if (char === quote) {
        closed = true;
        break;
      } else {
        source += char;
      }
    }
    if (!closed) return null;
    skipWhitespace();
    if (code[index] !== '+') break;
    index++;
  }
  if (!literals || !source.trim()) return null;
  const next = code[index];
  if (next !== undefined && next !== ',' && next !== ')' && next !== '\n' && next !== '\r') return null;
  return source;
}
