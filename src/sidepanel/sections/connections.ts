/**
 * Connections section — the relationship view for a domain/enterprise object,
 * rendered as a visually distinct "map card" so it reads as relationships, NOT
 * as more of the object's own properties.
 *
 * Design: an accent-railed, tinted card. Outgoing edges (this → target) on top,
 * a hairline, then incoming edges (target → this) and the inbound "referenced
 * by" scan. One compact line per SET edge — the target is the hero, the field
 * is a muted caption; unset edges are hidden and summarised as "N unset". A
 * junction's far side (risk → workflow → control) is an indented sub-line.
 * Clicking any target re-centers the pane (one-hop graph walk).
 *
 * Pure render given the resolved `Connections` model — see connections.test.ts.
 */

import { h, svg } from '../../lib/dom';
import { getTypeColor, getTypeAbbr } from '../../lib/types';
import { ICON_LINK } from '../../lib/icons';
import type { ConnTarget, ConnGroup } from '../../lib/connections';

export type { ConnTarget, ConnGroup } from '../../lib/connections';

/** Lazy "who else references me" — the universal inbound scan (C3). */
export interface ConnInbound {
  loaded: boolean;
  scanning?: boolean;
  capped?: boolean;
  targets: ConnTarget[];
}

export interface Connections {
  groups: ConnGroup[];
  inbound?: ConnInbound;
}

export interface ConnectionsInput {
  connections: Connections;
  onNavigate: (rid: string) => void;
  /** Trigger the lazy inbound scan (C3). Omit to hide the affordance. */
  onScanInbound?: () => void;
}

export function renderConnections(input: ConnectionsInput): HTMLElement | null {
  const { groups, inbound } = input.connections;
  const nav = input.onNavigate;

  const out = groups.filter(g => g.direction === 'out' && g.targets.length > 0);
  const inc = groups.filter(g => g.direction === 'in' && g.targets.length > 0);
  const unset = groups.filter(g => g.targets.length === 0).length;

  // Inbound ("referenced by") edges, when scanned and non-empty.
  const inboundGroup: ConnGroup | null = inbound?.loaded && inbound.targets.length > 0
    ? { field: '__inbound__', label: 'referenced by', direction: 'in', targets: inbound.targets }
    : null;

  const hasEdges = out.length > 0 || inc.length > 0 || inboundGroup != null;
  // Nothing connected and no scan affordance → don't render the card at all.
  if (!hasEdges && !inbound) return null;

  const outRows = out.flatMap(g => groupRows(g, nav));
  const incRows = inc.flatMap(g => groupRows(g, nav));
  const inboundRows = inboundGroup ? groupRows(inboundGroup, nav) : [];

  const foot = footNote(unset, inbound, input.onScanInbound);

  return h('div', { class: 'conn-card' },
    h('div', { class: 'conn-card-head' },
      h('span', { class: 'conn-card-icon' }, svg(ICON_LINK)),
      h('span', { class: 'conn-card-title' }, 'Relationships'),
    ),
    ...outRows,
    (outRows.length > 0 && (incRows.length > 0 || inboundRows.length > 0)) ? h('div', { class: 'conn-card-rule' }) : null,
    ...incRows,
    ...inboundRows,
    foot,
  );
}

/** Rows for one edge group: the field label shows on the first target only,
 *  so a multi-value edge stays visually grouped. A junction target's far side
 *  follows as an indented sub-row. */
function groupRows(g: ConnGroup, nav: (rid: string) => void): HTMLElement[] {
  const rows: HTMLElement[] = [];
  g.targets.forEach((t, i) => {
    rows.push(edgeRow(g.direction, i === 0 ? g.label : '', t, nav));
    if (t.via) rows.push(viaRow(t.via, nav));
  });
  return rows;
}

function edgeRow(direction: 'out' | 'in', label: string, t: ConnTarget, nav: (rid: string) => void): HTMLElement {
  const dir = direction === 'out' ? '→' : '←';
  if (t.broken) {
    return h('div', { class: 'conn-edge conn-edge--broken', title: `Reference points to a missing object (${t.rid})` },
      h('span', { class: 'conn-edge-dir' }, dir),
      h('span', { class: 'conn-edge-label' }, label),
      h('span', { class: 'conn-edge-broken' }, `⚠ ${t.rid}`),
    );
  }
  return h('div', {
    class: 'conn-edge',
    role: 'button',
    tabindex: '0',
    title: `Open ${t.name || t.businessId || t.rid}`,
    onClick: () => nav(t.rid),
    onKeydown: (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); nav(t.rid); } },
  },
    h('span', { class: 'conn-edge-dir' }, dir),
    h('span', { class: 'conn-edge-label', title: label }, label),
    h('span', { class: 'conn-edge-chip', style: `--type-color:${getTypeColor(t.type)}` }, getTypeAbbr(t.type)),
    h('span', { class: 'conn-edge-name' }, t.name || '(unnamed)'),
  );
}

/** Junction far side, indented under its junction (aligned past the dir+label
 *  columns): "→ [chip] far-side name". */
function viaRow(via: ConnTarget, nav: (rid: string) => void): HTMLElement {
  if (via.broken) {
    return h('div', { class: 'conn-edge conn-edge--via conn-edge--broken' },
      h('span', { class: 'conn-edge-dir' }, ''),
      h('span', { class: 'conn-edge-label' }, ''),
      h('span', { class: 'conn-edge-broken' }, '→ ⚠ missing'),
    );
  }
  return h('div', {
    class: 'conn-edge conn-edge--via',
    role: 'button',
    tabindex: '0',
    title: `Open ${via.name || via.businessId || via.rid}`,
    onClick: () => nav(via.rid),
    onKeydown: (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); nav(via.rid); } },
  },
    h('span', { class: 'conn-edge-dir' }, ''),
    h('span', { class: 'conn-edge-label' }, ''),
    h('span', { class: 'conn-via-arrow' }, '→'),
    h('span', { class: 'conn-edge-chip conn-edge-chip--via', style: `--type-color:${getTypeColor(via.type)}` }, getTypeAbbr(via.type)),
    h('span', { class: 'conn-edge-name' }, via.name || '(unnamed)'),
  );
}

/** Footer: "N unset" + the inbound scan affordance (button / scanning / done). */
function footNote(unset: number, inbound: ConnInbound | undefined, onScan?: () => void): HTMLElement | null {
  const bits: (HTMLElement | string)[] = [];
  if (unset > 0) bits.push(`${unset} unset`);
  if (inbound) {
    if (inbound.scanning) bits.push('scanning…');
    else if (!inbound.loaded && onScan) bits.push(h('button', { class: 'conn-foot-scan', onClick: () => onScan() }, 'referenced by ›'));
    else if (inbound.loaded && inbound.targets.length === 0) bits.push('no other refs');
    else if (inbound.loaded && inbound.capped) bits.push('first 100 shown');
  }
  if (bits.length === 0) return null;

  const children: (HTMLElement | string)[] = [];
  bits.forEach((b, i) => {
    if (i > 0) children.push(h('span', { class: 'conn-foot-sep' }, ' · '));
    children.push(b);
  });
  return h('div', { class: 'conn-card-foot' }, ...children);
}
