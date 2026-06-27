/**
 * Blast-radius queries for the blueprint apply-preview — PURE (builders + parsers, no I/O).
 *
 * Two questions the preview answers before the user commits, both driven by `rref()` (reverse
 * reference) against live BMP via the LayoutIO seam:
 *
 *   (A) INSTANCE FAN-OUT — is the page being edited a TEMPLATE MASTER? `page.rref(linkedTo)` returns
 *       the instances that inherit from it; non-empty ⇒ widget edits here propagate to all of them.
 *   (B) SHARED-STRUCTURE BLAST — a TabSet/Tab/Container is a single shared object (under PortalRoot),
 *       so a structural edit hits every page bound into it. For each touched container,
 *       `container.rref(container)` → the widgets → `widget.scorecard` → the distinct scorecards.
 *       Collapsed by TEMPLATE-FAMILY so a master and its own instances count as ONE thing (not N
 *       scary "places"); only families OTHER than the page's own are an external blast.
 *
 * `name` is the LAST pipe field everywhere (free-text, parsed as the remainder) — a name containing
 * `|` can't shift the structural fields (same rule as the layout wire format). See
 * skills/bmp-platform/reference/template-instance-architecture.md.
 *
 * Note: `.scorecard` (the ModelAscender) resolves the owning Scorecard through an `rref` result;
 * `.ancestor(Scorecard)` does NOT in that context (returns MISSING) — verified live.
 */

const SEP = '<<<CREV_BLAST>>>';

export interface InstanceFanout {
  /** The page's template-family key: its linkedTo rid if it's an instance, else its own rid. */
  ownFamilyKey: string;
  /** True when other scorecards link to this page (it is a template master). */
  isMaster: boolean;
  instances: { rid: string; businessId?: string; name?: string }[];
}

export interface SharedFamily {
  /** A representative scorecard rid for the family (the master if seen, else any member). */
  rid: string;
  name?: string;
  isMaster: boolean;
}

export interface ContainerBlast {
  /** Distinct template-families using the shared structure, EXCLUDING the page being edited. */
  otherFamilies: number;
  /** One representative page per other family (for the warning text). */
  families: SharedFamily[];
}

/** (A) Build the fan-out probe for the page being edited. Emits one SELF row (own rid + linkedTo)
 *  then one INST row per linking instance. */
export function buildInstanceFanoutEc(pageRef: string): string {
  return [
    `_p := ${pageRef}`,
    `_r := "${SEP}SELF|" + _p.rid.whenMissing("") + "|" + _p.linkedTo.rid.whenMissing("") + "\\n"`,
    `_p.rref(linkedTo).forEach(_i:`,
    `     _r := _r + "${SEP}INST|" + _i.rid.whenMissing("") + "|" + _i.id.whenMissing("") + "|" + _i.name.whenMissing("") + "\\n"`,
    `)`,
    `_r`,
  ].join('\n');
}

export function parseInstanceFanout(log: string): InstanceFanout {
  let ownRid = '';
  let ownLinkedTo = '';
  const instances: InstanceFanout['instances'] = [];
  const seen = new Set<string>();
  for (const block of log.split(SEP)) {
    const line = block.split('\n', 1)[0].trim();
    if (!line) continue;
    const parts = line.split('|');
    if (parts[0] === 'SELF') {
      ownRid = parts[1] ?? '';
      ownLinkedTo = parts[2] ?? '';
    } else if (parts[0] === 'INST') {
      const rid = parts[1];
      if (!rid || seen.has(rid)) continue;
      seen.add(rid);
      instances.push({ rid, businessId: parts[2] || undefined, name: parts.slice(3).join('|') || undefined });
    }
  }
  return { ownFamilyKey: ownLinkedTo || ownRid, isMaster: instances.length > 0, instances };
}

/** (B) Build the shared-structure probe for the containers the plan touches. One rref(container)
 *  walk per container, emitting (scorecardRid | scorecardLinkedTo | scorecardName) rows. */
export function buildContainerBlastEc(containerRefs: string[]): string {
  const lines: string[] = ['_r := ""'];
  containerRefs.forEach((ref, i) => {
    lines.push(`_c${i} := ${ref}`);
    lines.push(`_c${i}.rref(container).forEach(_w:`);
    lines.push('     _sc := _w.scorecard');
    lines.push(`     _r := _r + "${SEP}" + _sc.rid.whenMissing("") + "|" + _sc.linkedTo.rid.whenMissing("") + "|" + _sc.name.whenMissing("") + "\\n"`);
    lines.push(')');
  });
  lines.push('_r');
  return lines.join('\n');
}

export function parseContainerBlast(log: string, ownFamilyKey: string): ContainerBlast {
  const byFamily = new Map<string, SharedFamily>();
  for (const block of log.split(SEP)) {
    const line = block.split('\n', 1)[0].trim();
    if (!line) continue;
    const parts = line.split('|');
    const scRid = parts[0];
    if (!scRid) continue;
    const linkedTo = parts[1] || '';
    const name = parts.slice(2).join('|') || undefined;
    const family = linkedTo || scRid; // instances collapse onto their master
    if (family === ownFamilyKey) continue; // the page's own template-family is not an external blast
    const existing = byFamily.get(family);
    // Prefer the master (linkedTo empty) as the family's representative + name.
    if (!existing || (!linkedTo && existing.isMaster === false)) {
      byFamily.set(family, { rid: scRid, name, isMaster: !linkedTo });
    }
  }
  return { otherFamilies: byFamily.size, families: [...byFamily.values()] };
}
