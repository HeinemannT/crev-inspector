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
import { ICON_REFRESH, ICON_REVERT } from '../../lib/icons';
import { PROP_GROUPS, type PropDef } from '../pane-schema';
import {
  colorLinkEditor, numberEditor, enumEditor, booleanEditor, sliderEditor,
  propertyAccessorEditor, stringEditor, displayValue, type EnumOption, type PropEditorContext,
} from '../property-editors';
import { colorLinkBid } from '../../lib/color-util';
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
  /** True only for a staged literal value edit (not an inheritance reset). */
  isValueDirty?(prop: string): boolean;
  setDraft(prop: string, value: string): void;
  /** Live business-object properties for specialized mapping editors. */
  propertyChoices?(prop: string): {
    options?: EnumOption[];
    loading?: boolean;
    source?: string;
    error?: string;
  };
  /** Open the colour-link picker for a colour prop (host wires its own messaging). */
  openColorPicker(def: PropDef, anchor: HTMLElement, currentBid: string | null): void;
  /** Optional expanded-view interaction: render values quietly until the user
   *  explicitly clicks a field, then reveal its native editor. */
  editOnDemand?: {
    activeProp: string | null;
    request(prop: string): void;
  };
  /** Optional instance-override state for the expanded object view. The reset
   * arrow is the complete affordance: no inheritance/source inspector. */
  cascade?: {
    get(prop: string): {
      overridden: boolean;
      resetStaged: boolean;
    };
    toggleReset(prop: string): void;
  };
}

const RESP_VIS: Record<string, string> = {
  shownOnLargeDisplay: 'L', shownOnMediumDisplay: 'M', shownOnSmallDisplay: 'S',
};
const COLUMN_PROPS = ['columnsLargeScreen', 'columnsMediumScreen', 'columnsSmallScreen'];
const COLUMN_PROP_SET: ReadonlySet<string> = new Set(COLUMN_PROPS);

/** Render one stable property root for either a full group or a local refresh. */
export function renderPropertyElement(ctx: PaneGroupsCtx, def: PropDef): HTMLElement {
  if (COLUMN_PROP_SET.has(def.prop)) return renderColumnCell(ctx, def);
  const visibilityLabel = RESP_VIS[def.prop];
  if (visibilityLabel) return renderVisCell(ctx, def, visibilityLabel);
  return renderPropRow(ctx, def);
}

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
      const isAlwaysShown = def.kind === 'boolean' || def.kind === 'enum'
        || def.kind === 'slider' || def.kind === 'property' || def.kind === 'string';
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
        h('div', { class: 'prop-group', 'data-section-label': group.title },
          suppressTitle ? null : h('div', { class: 'prop-group-title' }, ...titleChildren.filter(Boolean) as (HTMLElement | string)[]),
          ...visibleDefs.map(d => renderPropertyElement(ctx, d)),
        ),
      );
    }
  }
  return wrap;
}

/** Display group: Columns triplet, then the cosmetic ("Style") controls as a
 *  flat always-open grid. A hairline divider — not a sub-header — separates the
 *  two, so the controls integrate as plainly as Visibility's rows do. */
function renderDisplayGroup(
  ctx: PaneGroupsCtx, defs: PropDef[], titleChildren: (HTMLElement | string | null)[], suppressTitle: boolean,
): HTMLElement {
  const columnsDefs = defs.filter(d => COLUMN_PROPS.includes(d.prop));
  const otherDefs = defs.filter(d => !columnsDefs.includes(d));

  const columnsRow = columnsDefs.length > 0
    ? h('div', { class: 'prop-row prop-row--columns', title: 'Responsive width: large / medium / small screens (0–6, 0 = full width)' },
        h('span', { class: 'prop-label' }, 'Columns'),
        h('div', { class: 'prop-columns-triplet' }, ...columnsDefs.map(d => renderPropertyElement(ctx, d))),
      )
    : null;

  const styleGrid = otherDefs.length > 0
    ? h('div', { class: 'prop-grid' }, ...otherDefs.map(d => renderPropertyElement(ctx, d)))
    : null;
  // Divider only when both halves are present (gives the hierarchy a reason).
  const divider = columnsRow && styleGrid ? h('div', { class: 'prop-divider' }) : null;

  return h('div', { class: 'prop-group prop-group--display', 'data-section-label': 'Display' },
    suppressTitle ? null : h('div', { class: 'prop-group-title' }, ...titleChildren.filter(Boolean) as (HTMLElement | string)[]),
    columnsRow,
    divider,
    styleGrid,
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
        h('div', { class: 'prop-vis-triplet' }, ...respDefs.map(d => renderPropertyElement(ctx, d))),
      )
    : null;
  return h('div', { class: 'prop-group', 'data-section-label': 'Visibility' },
    h('div', { class: 'prop-group-title' }, ...titleChildren.filter(Boolean) as (HTMLElement | string)[]),
    ...otherDefs.map(d => renderPropertyElement(ctx, d)),
    tripletRow,
  );
}

/** One responsive-columns cell. In the expanded view all seven widths are
 * directly available—there is no input mode, spinner, or dropdown. */
function renderColumnCell(ctx: PaneGroupsCtx, def: PropDef): HTMLElement {
  const value = ctx.displayValue(def.prop);
  const original = ctx.serverValue(def.prop);
  const dirty = ctx.isDirty(def.prop);
  if (ctx.editOnDemand) {
    const selected = Math.max(0, Math.min(6, Number(value) || 0));
    return h('div', {
      class: `prop-column-cell${dirty ? ' is-dirty' : ''}`,
      'data-property-prop': def.prop,
      title: `${def.label}: ${selected} of 6 columns (server: ${original || 'none'})`,
    },
      h('span', { class: 'prop-column-label' }, def.label),
      h('div', { class: 'prop-column-direct', role: 'radiogroup', 'aria-label': `${def.label} column width` },
        ...Array.from({ length: 7 }, (_, option) =>
          h('button', {
            class: `prop-column-step${option === 0 ? ' is-zero' : ''}${option > 0 && option <= selected ? ' is-filled' : ''}${selected === option ? ' is-selected' : ''}`,
            type: 'button',
            role: 'radio',
            'aria-checked': selected === option ? 'true' : 'false',
            'aria-label': option === 0 ? 'BMP full width (0)' : `${option} of 6 columns`,
            title: option === 0 ? 'BMP full width (0)' : `${option} of 6 columns`,
            onClick: () => ctx.setDraft(def.prop, String(option)),
          }, option === 0 ? '0' : ''),
        ),
        h('span', { class: 'prop-column-current', 'aria-hidden': 'true' }, `${selected}/6`),
      ),
      renderCascadeActions(ctx, def.prop),
    );
  }
  const input = h('input', {
    class: `prop-column-input${dirty ? ' prop-cell--dirty' : ''}`,
    type: 'number', min: 0, max: 6, step: 1, value: value || '', 'aria-label': def.label,
  }) as HTMLInputElement;
  input.addEventListener('change', () => ctx.setDraft(def.prop, input.value));
  return h('div', {
    class: `prop-column-cell${dirty ? ' is-dirty' : ''}`,
    'data-property-prop': def.prop,
    title: `${def.label} (server: ${original || 'none'})`,
  }, input, h('span', { class: 'prop-column-label' }, def.label));
}

/** One compact responsive visibility button. The L/M/S label is the control,
 * replacing the repeated "On" values and switches. */
function renderVisCell(ctx: PaneGroupsCtx, def: PropDef, label: string): HTMLElement {
  const value = ctx.displayValue(def.prop);
  const dirty = ctx.isDirty(def.prop);
  const checked = value === 'true' || value === 'TRUE';
  if (ctx.editOnDemand) {
    return h('div', {
      class: `prop-vis-cell${dirty ? ' is-dirty' : ''}`,
      'data-property-prop': def.prop,
    },
      h('button', {
        class: `prop-vis-breakpoint${checked ? ' is-shown' : ' is-hidden'}${dirty ? ' prop-cell--dirty' : ''}`,
        type: 'button',
        'aria-pressed': checked ? 'true' : 'false',
        'aria-label': `${checked ? 'Hide' : 'Show'} on ${def.label.replace(/^Show on /, '')}`,
        title: `${checked ? 'Shown' : 'Hidden'} on ${def.label.replace(/^Show on /, '').toLowerCase()} screens`,
        onClick: () => ctx.setDraft(def.prop, checked ? 'false' : 'true'),
      }, label),
      renderCascadeActions(ctx, def.prop),
    );
  }
  return h('div', {
    class: 'prop-vis-cell',
    'data-property-prop': def.prop,
  },
    h('button', {
      class: `prop-toggle prop-toggle--compact${checked ? ' prop-toggle--on' : ''}${dirty ? ' prop-cell--dirty' : ''}`,
      role: 'switch', 'aria-checked': checked ? 'true' : 'false',
      'aria-label': `Show on ${def.label.replace(/^Show on /, '')}`,
      onClick: () => ctx.setDraft(def.prop, checked ? 'false' : 'true'),
    },
      h('span', { class: 'prop-toggle-track' }, h('span', { class: 'prop-toggle-thumb' })),
    ),
    h('span', { class: 'prop-vis-cell-label' }, label),
    renderCascadeActions(ctx, def.prop),
  );
}

function renderCascadeActions(ctx: PaneGroupsCtx, prop: string): HTMLElement | null {
  if (!ctx.cascade) return null;
  const model = ctx.cascade.get(prop);
  return h('span', { class: 'prop-cascade-actions' },
    model.overridden || model.resetStaged
      ? h('button', {
          class: `prop-source-reset${model.resetStaged ? ' is-staged' : ''}`,
          type: 'button',
          title: model.resetStaged ? 'Cancel staged reset' : 'Reset instance override to its inherited value',
          'aria-label': model.resetStaged ? 'Cancel staged reset' : 'Reset instance override',
          onClick: () => ctx.cascade!.toggleReset(prop),
        }, svg(ICON_REVERT))
      : null,
  );
}

/** One generic property row — kind-specific editor + revert affordance. */
export function renderPropRow(ctx: PaneGroupsCtx, def: PropDef): HTMLElement {
  const value = ctx.displayValue(def.prop);
  const original = ctx.serverValue(def.prop);
  const dirty = ctx.isDirty(def.prop);
  const valueDirty = ctx.isValueDirty?.(def.prop) ?? dirty;
  const editorCtx: PropEditorContext = {
    value, original, dirty,
    onChange: (next) => ctx.setDraft(def.prop, next),
  };
  let editor: HTMLElement;
  const editOnDemand = ctx.editOnDemand;
  if (editOnDemand && editOnDemand.activeProp !== def.prop && def.kind !== 'color' && def.kind !== 'text') {
    const rendered = displayValue(value);
    const label = rendered === 'on' ? 'On' : rendered === 'off' ? 'Off' : rendered;
    editor = h('button', {
      class: `prop-cell prop-cell--ondemand${dirty ? ' prop-cell--dirty' : ''}`,
      type: 'button',
      title: `Edit ${def.label}`,
      'aria-label': `Edit ${def.label}`,
      onClick: () => editOnDemand.request(def.prop),
    }, h('span', { class: 'prop-ondemand-value' }, label));
  } else {
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
    case 'property': {
      const choices = ctx.propertyChoices?.(def.prop);
      editor = propertyAccessorEditor(editorCtx, choices?.options, choices);
      break;
    }
    case 'string': editor = stringEditor(editorCtx); break;
    case 'text':
      editor = h('span', { class: 'prop-text-value' }, value || h('span', { class: 'prop-text-empty' }, '—'));
      break;
    default: editor = h('span');
  }
  if (editOnDemand?.activeProp === def.prop) editor.dataset.editingProp = def.prop;
  }
  return h('div', {
    class: `prop-row prop-row--${def.kind}`,
    'data-property-prop': def.prop,
  },
    h('span', { class: 'prop-label', title: `BMP property: ${def.prop}` }, def.label),
    editor,
    h('span', { class: 'prop-row-actions' },
      valueDirty && def.kind !== 'text'
        ? h('button', {
            class: 'prop-revert',
            title: `Undo draft to ${displayValue(original)}`,
            'aria-label': 'Undo this draft',
            onClick: () => ctx.setDraft(def.prop, original),
          }, svg(ICON_REFRESH))
        : null,
      renderCascadeActions(ctx, def.prop),
    ),
  );
}
