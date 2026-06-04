/**
 * Connections section — the relationship view for a domain/enterprise object.
 *
 * Unlike the widget-oriented `reference-edges.ts` (a hardcoded table of layout
 * refs), this renders GENERIC reference relationships discovered from the
 * object's class config: forward refs (this → target) AND reverse refs
 * (target → this), each resolved to a clickable identity. Clicking a target
 * re-centers the pane on it — so you walk the relationship graph one hop at a
 * time. Empty/required/broken edges and navigability are flagged because
 * surfacing those is the whole point for a configurator debugging an object.
 *
 * Pure render given the resolved `Connections` model — see connections.test.ts.
 */

import { h } from '../../lib/dom';
import { getTypeColor, getTypeAbbr } from '../../lib/types';
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
  if (groups.length === 0 && !inbound) return null;

  // Summary: count edges that actually connect to something.
  const live = groups.filter(g => g.targets.length > 0).length;
  const summary = `${live}/${groups.length} connected`;

  return h('div', { class: 'prop-group conn-section' },
    h('div', { class: 'prop-group-title' },
      h('span', { class: 'prop-group-title-text' }, 'Connections'),
      groups.length > 0 ? h('span', { class: 'prop-group-title-meta' }, summary) : null,
    ),
    ...groups.map(g => renderGroup(g, input.onNavigate)),
    inbound ? renderInbound(inbound, input.onNavigate, input.onScanInbound) : null,
  );
}

function renderGroup(g: ConnGroup, onNavigate: (rid: string) => void): HTMLElement {
  const dirArrow = g.direction === 'out' ? '→' : '←';

  if (g.targets.length === 0) {
    // Unset edge. A required forward ref that's empty is a real defect.
    const flagged = g.required && g.direction === 'out';
    return h('div', { class: `conn-row conn-row--empty${flagged ? ' conn-row--flag' : ''}` },
      h('span', { class: 'conn-label' }, g.label),
      h('span', { class: 'conn-dir' }, dirArrow),
      flagged
        ? h('span', { class: 'conn-empty conn-empty--required', title: 'Required reference is not set' }, '⌀ required, empty')
        : h('span', { class: 'conn-empty', title: g.direction === 'out' ? 'This reference is not set' : 'Nothing references this object here' }, g.direction === 'out' ? '(none)' : '(nothing)'),
    );
  }

  return h('div', { class: 'conn-group' },
    h('div', { class: 'conn-grouphead' },
      h('span', { class: 'conn-label' }, g.label),
      h('span', { class: 'conn-dir' }, dirArrow),
      g.targets.length > 1 ? h('span', { class: 'conn-count' }, String(g.targets.length)) : null,
    ),
    ...g.targets.map(t => renderTarget(t, onNavigate)),
  );
}

function renderTarget(t: ConnTarget, onNavigate: (rid: string) => void): HTMLElement {
  if (t.broken) {
    return h('div', { class: 'conn-target conn-target--broken', title: `Reference points to a missing object (${t.rid})` },
      h('span', { class: 'conn-flag' }, '⚠'),
      h('span', { class: 'conn-broken' }, `broken → ${t.rid}`),
    );
  }

  return h('div', {
    class: 'conn-target',
    role: 'button',
    tabindex: '0',
    title: `Open ${t.name || t.businessId || t.rid}`,
    onClick: () => onNavigate(t.rid),
    onKeydown: (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onNavigate(t.rid); }
    },
  },
    h('span', { class: 'conn-chip', style: `--type-color:${getTypeColor(t.type)}` }, getTypeAbbr(t.type)),
    h('span', { class: 'conn-name' }, t.name || '(unnamed)'),
    t.businessId ? h('span', { class: 'conn-bid' }, t.businessId) : null,
    // Junction far-side, inline: "Patch SMB → Monthly patching"
    t.via ? renderVia(t.via, onNavigate) : null,
    renderNav(t.navigable),
  );
}

function renderVia(via: ConnTarget, onNavigate: (rid: string) => void): HTMLElement {
  if (via.broken) {
    return h('span', { class: 'conn-via conn-via--broken', title: 'Junction far-side is missing' }, '→ ⚠ missing');
  }
  return h('span', {
    class: 'conn-via',
    role: 'button',
    tabindex: '0',
    title: `Open ${via.name || via.businessId || via.rid}`,
    onClick: (e: Event) => { e.stopPropagation(); onNavigate(via.rid); },
    onKeydown: (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); onNavigate(via.rid); }
    },
  },
    h('span', { class: 'conn-via-arrow' }, '→'),
    h('span', { class: 'conn-chip conn-chip--via', style: `--type-color:${getTypeColor(via.type)}` }, getTypeAbbr(via.type)),
    h('span', { class: 'conn-via-name' }, via.name || '(unnamed)'),
  );
}

/** Navigability pip: ·page (openable in BMP) vs ⌀ (no web page — inspect-only). */
function renderNav(navigable?: boolean): HTMLElement | null {
  if (navigable === undefined) return null;
  return navigable
    ? h('span', { class: 'conn-nav conn-nav--page', title: 'Has a web page — openable in BMP' }, '·page')
    : h('span', { class: 'conn-nav conn-nav--nopage', title: 'No web page — inspect-only here' }, '⌀');
}

function renderInbound(inbound: ConnInbound, onNavigate: (rid: string) => void, onScan?: () => void): HTMLElement {
  if (inbound.scanning) {
    return h('div', { class: 'conn-row conn-inbound' },
      h('span', { class: 'conn-label' }, 'referenced by'),
      h('span', { class: 'conn-dir' }, '←'),
      h('span', { class: 'conn-empty' }, 'scanning…'),
    );
  }
  if (!inbound.loaded) {
    return h('div', { class: 'conn-row conn-inbound' },
      h('span', { class: 'conn-label' }, 'referenced by'),
      h('span', { class: 'conn-dir' }, '←'),
      onScan
        ? h('button', { class: 'conn-scan', onClick: () => onScan() }, 'scan whole workspace ›')
        : h('span', { class: 'conn-empty' }, '(not scanned)'),
    );
  }
  if (inbound.targets.length === 0) {
    return h('div', { class: 'conn-row conn-inbound' },
      h('span', { class: 'conn-label' }, 'referenced by'),
      h('span', { class: 'conn-dir' }, '←'),
      h('span', { class: 'conn-empty' }, 'nothing'),
    );
  }
  return h('div', { class: 'conn-group' },
    h('div', { class: 'conn-grouphead' },
      h('span', { class: 'conn-label' }, 'referenced by'),
      h('span', { class: 'conn-dir' }, '←'),
      h('span', { class: 'conn-count' }, String(inbound.targets.length) + (inbound.capped ? '+' : '')),
    ),
    ...inbound.targets.map(t => renderTarget(t, onNavigate)),
  );
}
