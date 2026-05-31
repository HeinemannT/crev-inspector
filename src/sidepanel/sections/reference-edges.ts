/**
 * References section — list reference-edge properties for the current type
 * with their resolved target identities. Click a row to navigate the pane
 * to that target. Unset references render as a dim "(none)".
 */

import { h } from '../../lib/dom';
import { referencesFor } from '../../lib/widget-metadata';
import { getTypeColor, getTypeAbbr } from '../../lib/types';
import type { ObjectPaneIdentity } from '../../lib/types';

export interface ReferenceSectionInput {
  type: string;
  references: Record<string, ObjectPaneIdentity | null>;
  /** Called when a reference row is clicked. */
  onNavigate: (rid: string) => void;
}

export function renderReferenceSection(input: ReferenceSectionInput): HTMLElement | null {
  const defs = referencesFor(input.type);
  if (defs.length === 0) return null;

  const rows: HTMLElement[] = [];
  for (const def of defs) {
    const target = input.references[def.prop];
    rows.push(renderRefRow(def.label ?? def.prop, target, input.onNavigate));
  }
  if (rows.length === 0) return null;

  const setCount = defs.filter(d => input.references[d.prop]).length;
  const summary = setCount === defs.length
    ? `${defs.length} ${defs.length === 1 ? 'edge' : 'edges'}`
    : `${setCount}/${defs.length} set`;

  return h('div', { class: 'prop-group ref-section' },
    h('div', { class: 'prop-group-title' },
      h('span', { class: 'prop-group-title-text' }, 'References'),
      h('span', { class: 'prop-group-title-meta' }, summary),
    ),
    ...rows,
  );
}

function renderRefRow(label: string, target: ObjectPaneIdentity | null, onNavigate: (rid: string) => void): HTMLElement {
  if (!target) {
    return h('div', { class: 'ref-row ref-row--empty' },
      h('span', { class: 'ref-row-label' }, label),
      h('span', { class: 'ref-row-empty', title: 'No object is currently referenced by this property' }, '(none)'),
    );
  }

  return h('div', {
    class: 'ref-row',
    role: 'button',
    tabindex: '0',
    title: `Open ${target.name || target.businessId}`,
    onClick: () => onNavigate(target.rid),
    onKeydown: (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onNavigate(target.rid); }
    },
  },
    h('span', { class: 'ref-row-label' }, label),
    h('span', { class: 'ref-row-arrow' }, '→'),
    h('span', {
      class: 'ref-row-chip',
      style: `--type-color:${getTypeColor(target.type)}`,
    }, getTypeAbbr(target.type)),
    h('span', { class: 'ref-row-name' }, target.name || '(unnamed)'),
    target.businessId ? h('span', { class: 'ref-row-bid' }, target.businessId) : null,
    h('span', { class: 'ref-row-open' }, '↗'),
  );
}
