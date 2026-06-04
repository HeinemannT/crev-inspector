/**
 * Shared property-group rendering for the object pane.
 *
 * BOTH the sidebar DetailView and the Object View popout render the same set of
 * BMP property groups (Layout / Display / Appearance / Visibility / Columns).
 * This used to be copy-pasted into each, and drifted — the popout never got the
 * STYLE-fold / Visibility-triplet / default-dimension-hiding improvements.
 *
 * Now both build a small {@link PaneGroupsCtx} controller (abstracting how each
 * reads/writes draft state + opens the colour picker) and call
 * {@link renderPropertyGroups}. One source of truth → the two surfaces can't
 * drift again.
 *
 * Note: the *code* section, references, flow and header differ legitimately
 * between the two surfaces and stay per-module. Only the property GROUPS are
 * shared here.
 */
import { h, svg } from '../../lib/dom';
import { ICON_CHEVRON } from '../../lib/icons';
import { PROP_GROUPS, type PropDef } from '../pane-schema';
import {
  colorLinkEditor, numberEditor, enumEditor, booleanEditor, sliderEditor,
  displayValue, type PropEditorContext,
} from '../property-editors';
import { colorLinkBid } from '../../lib/types';
import { lookupColor } from '../color-picker';

/** The host surface (sidebar DetailView / Object View popout) implements this so
 *  the shared renderers don't need to know how draft state is stored. */
export interface PaneGroupsCtx {
  objectType: string;
  /** Type-availability gate for a prop (schema-cached truth or static set). */
  isAvailable(def: PropDef): boolean;
  /** Current value incl. any pending draft. */
  displayValue(prop: string): string;
  /** Last value from the server (no draft). */
  serverValue(prop: string): string;
  isDirty(prop: string): boolean;
  setDraft(prop: string, value: string): void;
  /** Open the colour-link picker for a colour prop (host wires its own messaging). */
  openColorPicker(def: PropDef, anchor: HTMLElement, currentBid: string | null): void;
  /** Collapse state for the "Style" disclosure (host owns it + re-renders). */
  styleCollapsed: boolean;
  toggleStyleCollapsed(): void;
}

const RESP_VIS: Record<string, string> = {
  shownOnLargeDisplay: 'L', shownOnMediumDisplay: 'M', shownOnSmallDisplay: 'S',
};
const COLUMN_PROPS = ['columnsLargeScreen', 'columnsMediumScreen', 'columnsSmallScreen'];

/** Render every applicable property group for the object. */
export function renderPropertyGroups(ctx: PaneGroupsCtx): HTMLElement {
  const wrap = h('div');
  for (const group of PROP_GROUPS) {
    const visibleDefs: PropDef[] = [];
    let dirtyInGroup = 0;
    for (const def of group.props) {
      if (!ctx.isAvailable(def)) continue;
      const draftPresent = ctx.isDirty(def.prop);
      const serverVal = ctx.serverValue(def.prop);
      const serverHas = serverVal !== '';
      // Near-zero px dimensions (Width / Height) are "auto/unset" — 0 or 1px is
      // never a deliberate layout, so surfacing it is just a noise row.
      if (def.kind === 'number' && def.unit === 'px' && !draftPresent) {
        const n = Number(serverVal);
        if (!serverHas || (Number.isFinite(n) && n <= 1)) continue;
      }
      const isAlwaysShown = def.kind === 'boolean' || def.kind === 'enum' || def.kind === 'slider';
      if (!serverHas && !draftPresent && !isAlwaysShown) continue;
      if (draftPresent) dirtyInGroup++;
      visibleDefs.push(def);
    }
    if (visibleDefs.length === 0) continue;

    const titleChildren: (HTMLElement | string | null)[] = [group.title];
    if (dirtyInGroup > 0) titleChildren.push(h('span', { class: 'prop-group-count' }, ` · ${dirtyInGroup} changed`));
    // Layout + Display titles are suppressed (the Display group grows its own
    // "Style" sub-header; Layout rows are self-explanatory).
    const suppressTitle = group.title === 'Layout' || group.title === 'Display';

    if (group.title === 'Display') {
      wrap.appendChild(renderDisplayGroup(ctx, visibleDefs, titleChildren, suppressTitle));
    } else if (group.title === 'Visibility') {
      wrap.appendChild(renderVisibilityGroup(ctx, visibleDefs, titleChildren));
    } else {
      wrap.appendChild(
        h('div', { class: 'prop-group' },
          suppressTitle ? null : h('div', { class: 'prop-group-title' }, ...titleChildren.filter(Boolean) as (HTMLElement | string)[]),
          ...visibleDefs.map(d => renderPropRow(ctx, d)),
        ),
      );
    }
  }
  return wrap;
}

/** Display group: Columns triplet always visible; the cosmetic controls fold
 *  behind a collapsible "Style" disclosure (auto-expands when one is dirty). */
function renderDisplayGroup(
  ctx: PaneGroupsCtx, defs: PropDef[], titleChildren: (HTMLElement | string | null)[], suppressTitle: boolean,
): HTMLElement {
  const columnsDefs = defs.filter(d => COLUMN_PROPS.includes(d.prop));
  const otherDefs = defs.filter(d => !columnsDefs.includes(d));

  const columnsRow = columnsDefs.length > 0
    ? h('div', { class: 'prop-row prop-row--columns', title: 'Responsive width: large / medium / small screens (0–6, 0 = full width)' },
        h('span', { class: 'prop-label' }, 'Columns'),
        h('div', { class: 'prop-columns-triplet' }, ...columnsDefs.map(d => renderColumnCell(ctx, d))),
      )
    : null;

  const changedCount = otherDefs.filter(d => ctx.isDirty(d.prop)).length;
  const open = !ctx.styleCollapsed || changedCount > 0;
  const styleSection = otherDefs.length > 0
    ? h('div', { class: 'prop-substyle' },
        h('button', {
          class: `prop-substyle-head${open ? ' is-open' : ''}`,
          'aria-expanded': open ? 'true' : 'false',
          onClick: () => ctx.toggleStyleCollapsed(),
        },
          // Label first (aligns with the other group eyebrows like VISIBILITY);
          // the disclosure chevron sits at the far right, accordion-style.
          h('span', { class: 'prop-substyle-label' }, 'Style'),
          changedCount > 0 ? h('span', { class: 'prop-group-count' }, `${changedCount} changed`) : null,
          h('span', { class: 'prop-substyle-tw' }, svg(ICON_CHEVRON)),
        ),
        open ? h('div', { class: 'prop-grid' }, ...otherDefs.map(d => renderPropRow(ctx, d))) : null,
      )
    : null;

  return h('div', { class: 'prop-group prop-group--display' },
    suppressTitle ? null : h('div', { class: 'prop-group-title' }, ...titleChildren.filter(Boolean) as (HTMLElement | string)[]),
    columnsRow,
    styleSection,
  );
}

/** Visibility: "Visible" as a row, the three responsive toggles as an L/M/S
 *  triplet on ONE row (mirrors Columns), not three stacked rows. */
function renderVisibilityGroup(
  ctx: PaneGroupsCtx, defs: PropDef[], titleChildren: (HTMLElement | string | null)[],
): HTMLElement {
  const respDefs = defs.filter(d => d.prop in RESP_VIS);
  const otherDefs = defs.filter(d => !(d.prop in RESP_VIS));
  const tripletRow = respDefs.length > 0
    ? h('div', { class: 'prop-row prop-row--columns', title: 'Show on large / medium / small screens' },
        h('span', { class: 'prop-label' }, 'Show on'),
        h('div', { class: 'prop-vis-triplet' }, ...respDefs.map(d => renderVisCell(ctx, d, RESP_VIS[d.prop]))),
      )
    : null;
  return h('div', { class: 'prop-group' },
    h('div', { class: 'prop-group-title' }, ...titleChildren.filter(Boolean) as (HTMLElement | string)[]),
    ...otherDefs.map(d => renderPropRow(ctx, d)),
    tripletRow,
  );
}

/** One responsive-columns number cell (input + L/M/S label under it). */
function renderColumnCell(ctx: PaneGroupsCtx, def: PropDef): HTMLElement {
  const value = ctx.displayValue(def.prop);
  const original = ctx.serverValue(def.prop);
  const dirty = ctx.isDirty(def.prop);
  const input = h('input', {
    class: `prop-column-input${dirty ? ' prop-cell--dirty' : ''}`,
    type: 'number', min: 0, max: 6, step: 1, value: value || '', 'aria-label': def.label,
  }) as HTMLInputElement;
  input.addEventListener('input', () => ctx.setDraft(def.prop, input.value));
  return h('div', {
    class: `prop-column-cell${dirty ? ' is-dirty' : ''}`,
    title: `${def.label} (server: ${original || 'none'})`,
  }, input, h('span', { class: 'prop-column-label' }, def.label));
}

/** One compact L/M/S visibility toggle (switch + breakpoint letter under it). */
function renderVisCell(ctx: PaneGroupsCtx, def: PropDef, label: string): HTMLElement {
  const value = ctx.displayValue(def.prop);
  const dirty = ctx.isDirty(def.prop);
  const checked = value === 'true' || value === 'TRUE';
  return h('div', { class: 'prop-vis-cell' },
    h('button', {
      class: `prop-toggle prop-toggle--compact${checked ? ' prop-toggle--on' : ''}${dirty ? ' prop-cell--dirty' : ''}`,
      role: 'switch', 'aria-checked': checked ? 'true' : 'false',
      'aria-label': `Show on ${def.label.replace(/^Show on /, '')}`,
      onClick: () => ctx.setDraft(def.prop, checked ? 'false' : 'true'),
    },
      h('span', { class: 'prop-toggle-track' }, h('span', { class: 'prop-toggle-thumb' })),
    ),
    h('span', { class: 'prop-vis-cell-label' }, label),
  );
}

/** One generic property row — kind-specific editor + revert affordance. */
export function renderPropRow(ctx: PaneGroupsCtx, def: PropDef): HTMLElement {
  const value = ctx.displayValue(def.prop);
  const original = ctx.serverValue(def.prop);
  const dirty = ctx.isDirty(def.prop);
  const editorCtx: PropEditorContext = {
    value, original, dirty,
    onChange: (next) => ctx.setDraft(def.prop, next),
  };
  let editor: HTMLElement;
  switch (def.kind) {
    case 'color': {
      const bid = colorLinkBid(value);
      const cached = lookupColor(bid);
      editor = colorLinkEditor(editorCtx, {
        name: cached?.name ?? (bid ? value.slice(bid.length).trim() || bid : ''),
        rgb: cached?.rgb ?? null,
        onOpen: (anchor) => ctx.openColorPicker(def, anchor, bid || null),
      });
      break;
    }
    case 'number':  editor = numberEditor(editorCtx, { unit: def.unit, ...(def.range ?? {}) }); break;
    case 'enum':    editor = enumEditor(editorCtx, def.options ?? []); break;
    case 'boolean': editor = booleanEditor(editorCtx); break;
    case 'slider':  editor = sliderEditor(editorCtx, def.range!); break;
    case 'text':
      editor = h('span', { class: 'prop-text-value' }, value || h('span', { class: 'prop-text-empty' }, '—'));
      break;
    default: editor = h('span');
  }
  return h('div', { class: `prop-row prop-row--${def.kind}` },
    h('span', { class: 'prop-label', title: `BMP property: ${def.prop}` }, def.label),
    editor,
    dirty && def.kind !== 'text'
      ? h('button', {
          class: 'prop-revert',
          title: `Reset to ${displayValue(original)}`,
          'aria-label': 'Revert this property',
          onClick: () => ctx.setDraft(def.prop, original),
        }, '↻')
      : h('span', { class: 'prop-revert', 'aria-hidden': 'true' }),
  );
}
