/**
 * Links section — the ONE relationship view in the object inspector.
 *
 * Every object→object link lives here, whether it's a curated data binding
 * (widget types: a chart's data set, an InputView's InputSet) or a discovered
 * relationship (domain types: owner, mitigated-by, …). Both feed the same
 * normalized model and render in the same grammar, so the inspector stays a
 * single coherent stack of eyebrow-titled property groups — no special card.
 *
 * Layout (name-first, full pane width; direction carried by the leading glyph,
 * so a divider — not a header — splits outgoing from incoming):
 *
 *   LINKS                          3 out · 1 in
 *   →  [USE] Anna Schmidt                 owner
 *   →  [CER] DDoS attack statement       master
 *   ─────────────────────────────────────────────
 *   ↰  [CEW] DDoS mitigation workflow  mitigates
 *        ↳ [CEC] WAF rate-limit control     via   (junction far side, indented)
 *   [ Scan all referrers ]
 *
 * Outgoing links lead with →, incoming with ↰ (bend-up-left "return"). A
 * junction's far side is an indented sub-row. Unset *discovered* links are
 * simply omitted (an empty optional field isn't a relationship); unset *curated*
 * bindings stay visible as a dim "(none)" because that's a real config signal.
 *
 * Pure render given the resolved `LinksModel` — see links.test.ts.
 */

import { h } from '../../lib/dom';
import { getTypeColor, getTypeAbbr } from '../../lib/types';
import type { ObjectPaneIdentity } from '../../lib/types';
import type { ConnTarget, ConnGroup } from '../../lib/connections';
import { referencesFor } from '../../lib/widget-metadata';

export type { ConnTarget, ConnGroup } from '../../lib/connections';

/** One link in the unified model: a target plus the field that carries it. */
export interface LinkTarget {
  rid: string;
  name?: string;
  type?: string;
  businessId?: string;
  /** The property/relationship the link travels on — shown as a dim caption. */
  field: string;
  /** Junction far side (risk → workflow → control), shown as an indented sub-row. */
  via?: ConnTarget;
  /** Reference resolves to a rid with no identity — a dangling pointer. */
  broken?: boolean;
  /** Curated binding that is currently unset — kept visible as a dim "(none)". */
  empty?: boolean;
}

/** Lazy "who else references me" — the universal inbound scan (rref). */
export interface LinkInbound {
  loaded: boolean;
  scanning?: boolean;
  capped?: boolean;
  targets: ConnTarget[];
}

export interface LinksModel {
  /** Outgoing links — "→ References". May include unset curated bindings. */
  outgoing: LinkTarget[];
  /** Incoming links — "← Referenced by". Declared reverse refs. */
  incoming: LinkTarget[];
  /** Lazy inbound scan (domain objects only). Omit to hide the affordance. */
  inbound?: LinkInbound;
}

export interface LinksInput {
  links: LinksModel;
  onNavigate: (rid: string) => void;
  /** Trigger the lazy inbound scan. Omit to hide the affordance. */
  onScanInbound?: () => void;
}

/** Flatten discovered connection groups into outgoing/incoming link lists,
 *  dropping unset edges (an empty optional field isn't a relationship). */
export function connectionsToLinks(groups: ConnGroup[]): { outgoing: LinkTarget[]; incoming: LinkTarget[] } {
  const outgoing: LinkTarget[] = [];
  const incoming: LinkTarget[] = [];
  for (const g of groups) {
    for (const t of g.targets) {
      const lt: LinkTarget = { ...t, field: g.label };
      (g.direction === 'out' ? outgoing : incoming).push(lt);
    }
  }
  return { outgoing, incoming };
}

/** Map a type's curated reference bindings into outgoing links, keeping unset
 *  ones as `empty` (a widget's missing data binding is worth surfacing). */
export function referencesToLinks(type: string, references: Record<string, ObjectPaneIdentity | null>): LinkTarget[] {
  return referencesFor(type).map(def => {
    const target = references[def.prop];
    const field = def.label ?? def.prop;
    if (!target) return { rid: '', field, empty: true };
    return { rid: target.rid, name: target.name, type: target.type, businessId: target.businessId, field };
  });
}

/** Direction glyphs: a plain arrow out, a bend-up-left "return" arrow back in.
 *  Direction is carried per-row by this glyph, so the out/in split needs no
 *  sub-headers — just a divider for hierarchy. */
const DIR_GLYPH = { out: '→', in: '↰' } as const;

export function renderLinks(input: LinksInput): HTMLElement | null {
  const { outgoing, incoming, inbound } = input.links;
  const nav = input.onNavigate;

  const inboundTargets = inbound?.loaded ? inbound.targets : [];
  const inRows: LinkTarget[] = [
    ...incoming,
    ...inboundTargets.map<LinkTarget>(t => ({ ...t, field: '' })),
  ];
  const showScan = !!inbound && !inbound.loaded;
  const hasIn = inRows.length > 0;

  if (outgoing.length === 0 && !hasIn && !showScan) return null;

  const setOut = outgoing.filter(t => !t.empty).length;

  const children: (HTMLElement | string | null)[] = [
    h('div', { class: 'prop-group-title' },
      h('span', { class: 'prop-group-title-text' }, 'Links'),
      h('span', { class: 'prop-group-title-meta' }, metaLabel(outgoing.length, setOut, inRows.length)),
    ),
  ];

  for (const t of outgoing) children.push(...linkRow('out', t, nav));

  // Divider, not a header: separates outgoing from incoming when both exist.
  if (outgoing.length > 0 && hasIn) children.push(h('div', { class: 'lk-divider' }));

  for (const t of inRows) children.push(...linkRow('in', t, nav));

  const scan = scanFoot(inbound, input.onScanInbound);
  if (scan) children.push(scan);

  return h('div', { class: 'prop-group lk-section' }, ...children.filter(Boolean) as (HTMLElement | string)[]);
}

function metaLabel(outTotal: number, outSet: number, inCount: number): string {
  if (inCount > 0) return `${outSet} out · ${inCount} in`;
  const unset = outTotal - outSet;
  if (unset > 0) return `${outSet}/${outTotal} set`;
  return `${outSet} ${outSet === 1 ? 'link' : 'links'}`;
}

/** A link row plus, if present, its junction far-side sub-row. */
function linkRow(dir: 'out' | 'in', t: LinkTarget, nav: (rid: string) => void): HTMLElement[] {
  const rows: HTMLElement[] = [mainRow(dir, t, nav)];
  if (t.via) rows.push(viaRow(t.via, nav));
  return rows;
}

function dirGlyph(dir: 'out' | 'in'): HTMLElement {
  return h('span', { class: `lk-dir lk-dir--${dir}` }, DIR_GLYPH[dir]);
}

function mainRow(dir: 'out' | 'in', t: LinkTarget, nav: (rid: string) => void): HTMLElement {
  if (t.empty) {
    return h('div', { class: 'lk-row lk-row--empty' },
      dirGlyph(dir),
      h('span', { class: 'lk-field lk-field--lead' }, t.field),
      h('span', { class: 'lk-none', title: 'No object is currently bound to this property' }, '(none)'),
    );
  }
  if (t.broken) {
    return h('div', { class: 'lk-row lk-row--broken', title: `Reference points to a missing object (${t.rid})` },
      dirGlyph(dir),
      h('span', { class: 'lk-broken' }, `⚠ ${t.rid}`),
      t.field ? h('span', { class: 'lk-field' }, t.field) : null,
    );
  }
  return h('div', {
    class: 'lk-row',
    role: 'button',
    tabindex: '0',
    title: `Open ${t.name || t.businessId || t.rid}`,
    onClick: () => nav(t.rid),
    onKeydown: (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); nav(t.rid); } },
  },
    dirGlyph(dir),
    h('span', { class: 'lk-chip', style: `--type-color:${getTypeColor(t.type)}` }, getTypeAbbr(t.type)),
    h('span', { class: 'lk-name' }, t.name || '(unnamed)'),
    t.field ? h('span', { class: 'lk-field', title: t.field }, t.field) : null,
  );
}

function viaRow(via: ConnTarget, nav: (rid: string) => void): HTMLElement {
  if (via.broken) {
    return h('div', { class: 'lk-row lk-row--via lk-row--broken' },
      h('span', { class: 'lk-via-arrow' }, '↳'),
      h('span', { class: 'lk-broken' }, '⚠ missing'),
    );
  }
  return h('div', {
    class: 'lk-row lk-row--via',
    role: 'button',
    tabindex: '0',
    title: `Open ${via.name || via.businessId || via.rid}`,
    onClick: () => nav(via.rid),
    onKeydown: (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); nav(via.rid); } },
  },
    h('span', { class: 'lk-via-arrow' }, '↳'),
    h('span', { class: 'lk-chip lk-chip--via', style: `--type-color:${getTypeColor(via.type)}` }, getTypeAbbr(via.type)),
    h('span', { class: 'lk-name' }, via.name || '(unnamed)'),
    h('span', { class: 'lk-field' }, 'via'),
  );
}

/** Bottom-of-section inbound affordance: button → scanning… → cap/empty note. */
function scanFoot(inbound: LinkInbound | undefined, onScan?: () => void): HTMLElement | null {
  if (!inbound) return null;
  if (inbound.scanning) return h('div', { class: 'lk-note' }, 'scanning…');
  if (!inbound.loaded) {
    return onScan ? h('button', { class: 'lk-scan-btn', onClick: () => onScan() }, 'Scan all referrers') : null;
  }
  if (inbound.capped) return h('div', { class: 'lk-note' }, 'first 100 referrers shown');
  if (inbound.targets.length === 0) return h('div', { class: 'lk-note' }, 'no other objects reference this');
  return null;
}
