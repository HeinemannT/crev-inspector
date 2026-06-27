/**
 * Flow-graph parsing helpers + shared types.
 * Used by BmpClient.fetchInputViewFlow / fetchActionButtonFlow / fetchLabelFlow
 * to turn pipe-delimited EC output into typed FlowChain structures.
 *
 * Pure functions; no I/O.
 */

export interface FlowIdentity {
  rid: string;
  businessId: string;
  type: string;
  name: string;
}

export interface FlowCodeField {
  prop: string;
  /** Character count of the raw EC content. */
  length: number;
  /** Actual newline-separated line count. */
  lineCount: number;
  firstLine: string;
  /** Sibling input keys this code reads (whole-word token match). */
  reads?: Array<{ key: string; sourceRid: string }>;
  /** When set, this EC only runs if the named boolean prop is true at
   *  runtime. Set with the gate's actual value so the UI can grey the row
   *  out when off and explain why ("disabled by useShowExpression=false"). */
  gateProp?: string;
  gateValue?: string;
  /** Indirection target for the Edit button. When the EC lives on a related
   *  object (e.g. ActionButton.showExpression is a Reference(ExtendedExpression)
   *  and the actual EC sits on that target's `.expression`), `prop` describes
   *  the source field (for display), but Edit must open the TARGET object's
   *  field. Both targetRid + targetProp must be set together to redirect. */
  targetRid?: string;
  targetProp?: string;
}

export interface FlowStep {
  identity: FlowIdentity;
  /** Edge label from the previous step in the chain. */
  edgeLabel?: string;
  /** *Input.key value when this step is an input field. */
  inputKey?: string;
  codeFields?: FlowCodeField[];
  /** Nested sub-steps (InputSet's children, Workflow's EC children). */
  children?: FlowStep[];
  /** Hint message for this step ("no action set", etc.). */
  hint?: string;
}

export interface FlowChain {
  steps: FlowStep[];
}

/** Split a `|`-delimited identity row, anchoring the free-text `name` between
 *  `leading` fixed columns (rids/ids) and `trailing` fixed columns
 *  (className/key/…). A `|` inside the name is absorbed into the name rather
 *  than shifting every column after it. Returns `[...leading, name, ...trailing]`
 *  or null if the row is too short / has no rid.
 *
 *  Note: BMP names can't be escaped in EC (no inline string-replace), so a
 *  literal newline in a name still splits the row upstream — that fragment is
 *  then dropped by the min-columns guard, which corrupts only that one node,
 *  never its siblings' columns. */
export function splitNamedRow(line: string, leading: number, trailing: number): string[] | null {
  const parts = line.split('|');
  if (parts.length < leading + 1 + trailing || !parts[0]) return null;
  const name = parts.slice(leading, parts.length - trailing).join('|');
  return [...parts.slice(0, leading), name, ...parts.slice(parts.length - trailing)];
}

/** Parse a single pipe-delimited identity row: rid|id|name|className. */
export function parsePipeRow(s: string | undefined): FlowIdentity | null {
  if (!s) return null;
  const cols = splitNamedRow(s.trim().split('\n')[0], 2, 1);
  if (!cols) return null;
  const [rid, businessId, name, type] = cols;
  return { rid, businessId, name, type };
}

/** Parse an identity row with a trailing key column: rid|id|name|className|key.
 *  Used for InputSet children where *Input types carry a key. */
export function parsePipeRowWithKey(line: string): { rid: string; businessId: string; name: string; type: string; key: string } | null {
  const cols = splitNamedRow(line.trim(), 2, 2);
  if (!cols) return null;
  const [rid, businessId, name, type, key] = cols;
  return { rid, businessId, name, type, key };
}

/** Parse the ActionButton header row: rid|id|name|className|actionType.
 *  actionType is the BMP enum value as an uppercase string (ACTION/ADD/EDIT/NAVIGATE). */
export function parseAbRow(s: string | undefined): { identity: FlowIdentity; actionType: string } | null {
  if (!s) return null;
  const cols = splitNamedRow(s.trim().split('\n')[0], 2, 2);
  if (!cols) return null;
  const [rid, businessId, name, type, actionType] = cols;
  return {
    identity: { rid, businessId, name, type },
    actionType,
  };
}

/** Build a FlowCodeField with whole-word cross-reference detection.
 *  Naive .includes() would false-positive on substrings (`name` matches inside
 *  `customName`). We require non-word characters on both sides of the key. */
export function makeCodeField(
  prop: string,
  content: string,
  inputKeys: Array<{ key: string; sourceRid: string }>,
): FlowCodeField {
  const lines = content.split('\n');
  const lineCount = lines.length;
  const firstLine = (lines.find(l => l.trim() !== '') ?? '').trim();
  const reads: Array<{ key: string; sourceRid: string }> = [];
  for (const ik of inputKeys) {
    if (ik.key && matchesAsToken(content, ik.key)) reads.push(ik);
  }
  const f: FlowCodeField = { prop, length: content.length, lineCount, firstLine };
  if (reads.length > 0) f.reads = reads;
  return f;
}

/** True if `token` appears in `content` as a complete identifier — bounded on
 *  both sides by non-word characters (or string edges). */
export function matchesAsToken(content: string, token: string): boolean {
  if (!token) return false;
  const len = token.length;
  const isWord = (c: string) => c !== '' && /[A-Za-z0-9_$]/.test(c);
  let idx = 0;
  while (true) {
    const found = content.indexOf(token, idx);
    if (found === -1) return false;
    const before = found === 0 ? '' : content[found - 1];
    const after = found + len >= content.length ? '' : content[found + len];
    if (!isWord(before) && !isWord(after)) return true;
    idx = found + 1;
  }
}
