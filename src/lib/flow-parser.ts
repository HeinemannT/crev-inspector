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

/** Parse a single pipe-delimited identity row: rid|id|name|className. */
export function parsePipeRow(s: string | undefined): FlowIdentity | null {
  if (!s) return null;
  const line = s.trim().split('\n')[0];
  const parts = line.split('|');
  if (parts.length < 4) return null;
  const [rid, businessId, name, type] = parts;
  if (!rid) return null;
  return { rid, businessId: businessId ?? '', name: name ?? '', type: type ?? '' };
}

/** Parse an identity row with a trailing key column: rid|id|name|className|key.
 *  Used for InputSet children where *Input types carry a key. */
export function parsePipeRowWithKey(line: string): { rid: string; businessId: string; name: string; type: string; key: string } | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  const parts = trimmed.split('|');
  if (parts.length < 4) return null;
  const [rid, businessId, name, type, key] = parts;
  if (!rid) return null;
  return { rid, businessId: businessId ?? '', name: name ?? '', type: type ?? '', key: key ?? '' };
}

/** Parse the ActionButton header row: rid|id|name|className|actionType.
 *  actionType is the BMP enum value as an uppercase string (ACTION/ADD/EDIT/NAVIGATE). */
export function parseAbRow(s: string | undefined): { identity: FlowIdentity; actionType: string } | null {
  if (!s) return null;
  const line = s.trim().split('\n')[0];
  const parts = line.split('|');
  if (parts.length < 5) return null;
  const [rid, businessId, name, type, actionType] = parts;
  if (!rid) return null;
  return {
    identity: { rid, businessId: businessId ?? '', name: name ?? '', type: type ?? '' },
    actionType: actionType ?? '',
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
