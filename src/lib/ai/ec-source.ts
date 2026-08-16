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
