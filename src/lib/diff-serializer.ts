/**
 * Deterministic text serialization of BMP object properties for diff comparison.
 * Produces a human-readable format suitable for CodeMirror merge view.
 */

/**
 * Serialize an object's identity and properties into a diffable text block.
 *
 * Output format:
 *   # Type: Name
 *   # RID: 12345
 *   # Business ID: SC-142
 *
 *   name: Revenue Dashboard
 *   sortIndex: 5
 *
 *   --- expression ---
 *   sum(children().value)
 *   --- end expression ---
 */
export function serializeForDiff(
  identity: { name?: string; type?: string; rid: string; businessId?: string },
  props: Record<string, string>,
  codeProps: string[],
): string {
  const lines: string[] = [];
  const codePropSet = new Set(codeProps);

  // Identity header as comments
  if (identity.type) {
    lines.push(`# ${identity.type}: ${identity.name ?? 'unnamed'}`);
  } else {
    lines.push(`# ${identity.name ?? 'unnamed'}`);
  }
  lines.push(`# RID: ${identity.rid}`);
  if (identity.businessId) {
    lines.push(`# Business ID: ${identity.businessId}`);
  }
  lines.push('');

  // Separate simple props from code props
  const simpleEntries: [string, string][] = [];
  const codeEntries: [string, string][] = [];

  for (const [key, value] of Object.entries(props)) {
    if (!value) continue; // skip empty
    if (codePropSet.has(key)) {
      codeEntries.push([key, value]);
    } else {
      simpleEntries.push([key, value]);
    }
  }

  // Simple props — sorted alphabetically, one per line
  simpleEntries.sort((a, b) => a[0].localeCompare(b[0]));
  for (const [key, value] of simpleEntries) {
    lines.push(`${key}: ${value}`);
  }

  // Code props — fenced blocks
  if (simpleEntries.length > 0 && codeEntries.length > 0) {
    lines.push('');
  }
  for (const [key, value] of codeEntries) {
    lines.push(`--- ${key} ---`);
    lines.push(value);
    lines.push(`--- end ${key} ---`);
    lines.push('');
  }

  return lines.join('\n');
}
