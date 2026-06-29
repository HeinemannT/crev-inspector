/**
 * Style tab — a focused, visual styling surface for the currently-selected
 * object (the same object the Inspect/Detail pane targets, via S.detailRid).
 *
 * It is a THIRD host of the shared property model: Properties + Visibility reuse
 * the pane-schema defs + the `renderPropRow` row renderer (so they can't drift
 * from the Detail pane), and saving goes through the same APPLY_OBJECT_CHANGES
 * path with the shared `buildChangesPayload` coercion. The one bit of new UI is
 * the Colours section — an inline Photoshop-style swatch grid (folders = colour
 * sets, swatches = CorpoColor objects, + an always-present Basics group) that
 * links headerColor / fontColor without the modal picker.
 *
 * Fetch/draft/save mirror DetailView's loop (FETCH_OBJECT_PANE → instanceProps/
 * templateProps; draft over the active target; confirm → apply → refetch), but
 * over the narrow style/colour/visibility subset rather than the full pane.
 */
import { h, svg } from '../../lib/dom';
import type { Tab, SendFn } from './tab-types';
import type { InspectorMessage, ObjectPaneIdentity, ColorSetData } from '../../lib/types';
import { getTypeColor, getTypeAbbr, colorLinkBid } from '../../lib/types';
import { S } from '../state';
import { findPropDef, type PropDef } from '../pane-schema';
import { renderPropRow, type PaneGroupsCtx } from '../sections/property-groups';
import { isPropAvailable, requestSchema } from '../pane-schema-runtime';
import { lookupColor, openColorPicker } from '../color-picker';
import { renderSwatchGrid } from '../swatch-grid';
import { buildChangesPayload } from '../pane-edit';
import { confirmModal } from '../../lib/modal';
import { showToast } from '../../lib/toast';
import { displayValue } from '../property-editors';
import { ICON_REFRESH } from '../../lib/icons';

type SaveTarget = 'instance' | 'template';
type ColorProp = 'headerColor' | 'fontColor';

const COLOR_PROPS: { prop: ColorProp; label: string }[] = [
  { prop: 'headerColor', label: 'Header' },
  { prop: 'fontColor', label: 'Font' },
];
// Properties section: the cosmetic WebChild props (no columns — those are layout,
// handled by the blueprint) + the tools/search toggles.
const STYLE_PROP_NAMES = ['shadow', 'headerStyle', 'borderStyle', 'transparency', 'showToolMenu', 'disableSearch'];
const VIS_PROP_NAMES = ['visible', 'shownOnLargeDisplay', 'shownOnMediumDisplay', 'shownOnSmallDisplay'];

export class StyleTab implements Tab {
  private rid: string | null = null;
  private identity: ObjectPaneIdentity | null = null;
  private template: ObjectPaneIdentity | null = null;
  private instanceProps: Record<string, string> = {};
  private templateProps: Record<string, string> = {};
  private draft: Record<string, string> = {};
  private target: SaveTarget = 'instance';
  private loading = false;
  private saving = false;
  private error: string | null = null;

  private sets: ColorSetData[] | null = null;
  private activeColor: ColorProp = 'headerColor';
  private colorFilter = '';
  // Open colour folders. Basics starts open (small, useful); the rest stay
  // collapsed since a workspace can carry hundreds of colours.
  private expandedSets = new Set<string>(['Basics']);

  private panel: HTMLElement | null = null;
  private gridHost: HTMLElement | null = null;

  constructor(private send: SendFn) {}

  // ── Lifecycle ────────────────────────────────────────────────────

  activate(): void {
    this.syncRid();
    if (this.sets === null) this.send({ type: 'FETCH_COLOR_SETS' });
  }

  deactivate(): void { /* nothing to tear down — no timers/listeners */ }

  /** Pending unsaved edits — surfaced as the tab's dirty dot. */
  pendingCount(): number { return Object.keys(this.draft).length; }

  /** Drop the cached colour sets (called on a profile switch) so the next fetch reloads the new
   *  workspace's colours instead of serving the previous profile's swatches. */
  resetColorSets(): void { this.sets = null; }

  /** Pick up a selection made elsewhere (Inspect badge, Browse, layout tree).
   *  Loads the new object; clears to empty when nothing is selected. */
  private syncRid(): void {
    const rid = S.detailRid;
    if (rid && rid !== this.rid) this.load(rid);
    else if (!rid && this.rid) this.reset();
  }

  private reset(): void {
    this.rid = null; this.identity = null; this.template = null;
    this.instanceProps = {}; this.templateProps = {}; this.draft = {};
    this.target = 'instance'; this.loading = false; this.saving = false; this.error = null;
  }

  private load(rid: string): void {
    this.reset();
    this.rid = rid;
    this.loading = true;
    this.send({ type: 'FETCH_OBJECT_PANE', rid });
  }

  handleMessage(msg: InspectorMessage): boolean {
    if (msg.type === 'OBJECT_PANE_DATA' && msg.rid === this.rid) {
      this.identity = msg.instance;
      this.template = msg.template;
      this.instanceProps = msg.instanceProps;
      this.templateProps = msg.templateProps;
      this.loading = false;
      this.error = msg.error ?? null;
      if (!this.template) this.target = 'instance';
      if (msg.instance.type) requestSchema(msg.instance.type, this.send);
      return true;
    }
    if (msg.type === 'COLOR_SETS_DATA') {
      this.sets = msg.sets;
      this.repaintGrid();
      return false; // grid repainted in place — no full re-render needed
    }
    if (msg.type === 'APPLY_CHANGES_RESULT' && msg.rid === this.rid) {
      this.saving = false;
      if (msg.ok) {
        this.draft = {};
        this.send({ type: 'FETCH_OBJECT_PANE', rid: this.rid });
        showToast('Saved. Reload the BMP page to see it.', 'success', {
          label: 'Reload',
          onClick: () => this.send({ type: 'RELOAD_BMP_TAB' }),
        });
      } else {
        this.error = msg.error ?? 'Save failed';
      }
      return true;
    }
    return false;
  }

  // ── Draft model (parallels DetailView over the active target) ─────

  private serverVal(prop: string): string {
    return this.target === 'template'
      ? (this.templateProps[prop] ?? '')
      : (this.instanceProps[prop] ?? '');
  }
  private displayVal(prop: string): string { return this.draft[prop] ?? this.serverVal(prop); }
  private setDraft(prop: string, value: string): void {
    if (value === this.serverVal(prop)) delete this.draft[prop];
    else this.draft[prop] = value;
    this.rerender();
  }

  private makeGroupsCtx(): PaneGroupsCtx {
    const type = this.identity?.type ?? '';
    return {
      objectType: type,
      isAvailable: (def) => isPropAvailable(type, def.prop, def.availableOn),
      displayValue: (prop) => this.displayVal(prop),
      serverValue: (prop) => this.serverVal(prop),
      isDirty: (prop) => this.draft[prop] != null,
      setDraft: (prop, value) => this.setDraft(prop, value),
      openColorPicker: (def, anchor, currentBid) => openColorPicker({
        anchor, currentBid, sendMessage: this.send,
        onPick: (val) => this.setDraft(def.prop, val),
      }),
    };
  }

  // ── Render ───────────────────────────────────────────────────────

  render(container: HTMLElement): void {
    this.panel = container;
    this.syncRid(); // selection may have changed while this tab was inactive
    container.textContent = '';
    container.appendChild(this.build());
    this.syncDirtyDot();
  }

  /** Keep the tab-bar's dirty dot synced with the live draft — a cheap DOM
   *  poke (the dot lives in the header, surviving panel re-renders), mirroring
   *  DetailView. No-op before buildApp mounts the dot. */
  private syncDirtyDot(): void {
    const dot = document.getElementById('style-dirty-dot');
    if (!dot) return;
    const n = Object.keys(this.draft).length;
    dot.classList.toggle('active', n > 0);
    dot.title = n > 0 ? `${n} unsaved styling change${n === 1 ? '' : 's'}` : '';
  }

  private rerender(): void {
    if (this.panel && document.body.contains(this.panel)) this.render(this.panel);
  }

  private build(): HTMLElement {
    const root = h('div', { class: 'style-tab' });
    if (!this.rid) {
      root.appendChild(this.emptyState());
      return root;
    }
    if (this.loading && !this.identity) {
      root.appendChild(h('div', { class: 'style-empty' }, 'Loading object…'));
      return root;
    }
    if (!this.identity) {
      root.appendChild(h('div', { class: 'style-empty' }, this.error || 'Could not load this object.'));
      return root;
    }

    const ctx = this.makeGroupsCtx();
    const type = this.identity.type;
    root.appendChild(this.header());

    const colorAvail = isPropAvailable(type, 'headerColor', findPropDef('headerColor')?.availableOn);
    const styleDefs = STYLE_PROP_NAMES.map(findPropDef).filter((d): d is PropDef => !!d)
      .filter(d => ctx.isAvailable(d));
    const visDefs = VIS_PROP_NAMES.map(findPropDef).filter((d): d is PropDef => !!d)
      .filter(d => ctx.isAvailable(d));

    if (!colorAvail && styleDefs.length === 0 && visDefs.length === 0) {
      root.appendChild(h('div', { class: 'style-empty' },
        `${getTypeAbbr(type)} objects don't expose styling properties.`));
      return root;
    }

    if (colorAvail) root.appendChild(this.coloursSection());
    if (styleDefs.length) root.appendChild(this.section('Properties', styleDefs.map(d => renderPropRow(ctx, d))));
    if (visDefs.length) root.appendChild(this.section('Visibility', visDefs.map(d => renderPropRow(ctx, d))));
    root.appendChild(this.actionBar());
    return root;
  }

  private emptyState(): HTMLElement {
    return h('div', { class: 'style-empty' },
      h('p', null, 'No object selected.'),
      h('p', { class: 'style-empty-hint' },
        'Pick a widget on the BMP page (Inspect), or open one from Browse, to style it here.'),
    );
  }

  private header(): HTMLElement {
    const id = this.identity!;
    const chip = h('span', {
      class: 'style-type-chip',
      style: `--type-color: ${getTypeColor(id.type)}`,
      title: id.type,
    }, getTypeAbbr(id.type));
    const title = h('div', { class: 'style-head-title' },
      chip,
      h('span', { class: 'style-head-name', title: id.name || id.businessId }, id.name || id.businessId || '(unnamed)'),
    );
    return h('div', { class: 'style-head' }, title, this.targetToggle());
  }

  /** instance / template target — mirrors the Detail pane. The colours + props
   *  edit the chosen object graph; template edits propagate to all instances. */
  private targetToggle(): HTMLElement | null {
    if (!this.template) return null;
    const btn = (t: SaveTarget, label: string) => h('button', {
      class: `style-target-btn${this.target === t ? ' active' : ''}`,
      'aria-selected': this.target === t ? 'true' : 'false',
      title: t === 'template' ? 'Edit the template (affects all instances)' : 'Edit this instance only',
      onClick: () => {
        if (this.target === t) return;
        if (Object.keys(this.draft).length) { this.draft = {}; }
        this.target = t;
        this.rerender();
      },
    }, label);
    return h('div', { class: 'style-target', role: 'group', 'aria-label': 'Save target' },
      btn('instance', 'Instance'), btn('template', 'Template'));
  }

  private section(title: string, rows: HTMLElement[]): HTMLElement {
    return h('div', { class: 'style-section' },
      h('div', { class: 'style-section-title' }, title),
      ...rows,
    );
  }

  // ── Colours section (inline swatch grid) ─────────────────────────

  private coloursSection(): HTMLElement {
    const slots = h('div', { class: 'style-color-slots' },
      ...COLOR_PROPS.map(({ prop, label }) => this.colorSlot(prop, label)));

    const filterInput = h('input', {
      class: 'style-color-filter', type: 'text', placeholder: 'Filter colours…',
      autocomplete: 'off', spellcheck: 'false', value: this.colorFilter,
      onInput: (e: Event) => { this.colorFilter = (e.currentTarget as HTMLInputElement).value; this.repaintGrid(); },
    });
    const refresh = h('button', {
      class: 'style-color-refresh', type: 'button', title: 'Reload colours from BMP',
      onClick: () => { this.sets = null; this.repaintGrid(); this.send({ type: 'FETCH_COLOR_SETS', force: true }); },
    }, svg(ICON_REFRESH));

    this.gridHost = h('div', { class: 'style-grid-host' });
    this.paintGrid();

    return h('div', { class: 'style-section' },
      h('div', { class: 'style-section-title' }, 'Colours'),
      slots,
      h('div', { class: 'style-color-head' }, filterInput, refresh),
      this.gridHost,
    );
  }

  /** One colour slot (Header / Font) — selecting it makes the grid assign to it. */
  private colorSlot(prop: ColorProp, label: string): HTMLElement {
    const value = this.displayVal(prop);
    const bid = colorLinkBid(value);
    const cached = bid ? lookupColor(bid) : null;
    const rgb = cached?.rgb ?? null;
    const name = cached?.name ?? (bid ? value.slice(bid.length).trim() || bid : 'None');
    const active = this.activeColor === prop;
    const dirty = this.draft[prop] != null;
    return h('button', {
      class: `style-color-slot${active ? ' active' : ''}${dirty ? ' dirty' : ''}`,
      'aria-pressed': active ? 'true' : 'false',
      title: `${label} colour${rgb ? ` · ${name}` : ' · none'}`,
      onClick: () => { this.activeColor = prop; this.rerender(); },
    },
      h('span', { class: 'style-color-slot-label' }, label),
      h('span', {
        class: `style-color-slot-dot${rgb ? '' : ' empty'}`,
        style: rgb ? `background:${rgb}` : '',
      }),
      h('span', { class: 'style-color-slot-name' }, name),
    );
  }

  /** Replace only the swatch grid's contents (keeps the filter input focused). */
  private paintGrid(): void {
    if (!this.gridHost) return;
    const value = this.displayVal(this.activeColor);
    this.gridHost.textContent = '';
    this.gridHost.appendChild(renderSwatchGrid({
      sets: this.sets,
      q: this.colorFilter,
      currentBid: colorLinkBid(value) || null,
      includeBasics: true,
      expanded: this.expandedSets,
      onToggle: (label) => {
        if (this.expandedSets.has(label)) this.expandedSets.delete(label);
        else this.expandedSets.add(label);
        this.repaintGrid();
      },
      onPick: (bidName) => this.setDraft(this.activeColor, bidName),
      onClear: () => this.setDraft(this.activeColor, ''), // BMP unsets a colour via `:= ""` (verified)
    }));
  }

  /** Repaint the grid in place if it's mounted (color-sets arrival / filter). */
  private repaintGrid(): void {
    if (this.gridHost && document.body.contains(this.gridHost)) this.paintGrid();
  }

  // ── Action bar ───────────────────────────────────────────────────

  private actionBar(): HTMLElement {
    const n = Object.keys(this.draft).length;
    const status = this.error
      ? h('span', { class: 'style-action-error' }, this.error)
      : n > 0
        ? h('span', null, h('strong', null, String(n)), ` pending · target: ${this.target}`)
        : h('span', { class: 'style-action-idle' }, 'No pending changes');
    return h('div', { class: 'style-action-bar' },
      status,
      h('div', { class: 'style-action-btns' },
        n > 0 ? h('button', { class: 'style-btn', onClick: () => { this.draft = {}; this.error = null; this.rerender(); } }, 'Discard') : null,
        h('button', {
          class: 'style-btn style-btn--save',
          disabled: (n === 0 || this.saving) ? 'true' : undefined,
          onClick: () => void this.commitSave(),
        }, this.saving ? 'Saving…' : 'Save'),
      ),
    );
  }

  private async commitSave(): Promise<void> {
    if (!this.identity || this.saving) return;
    const props = Object.keys(this.draft);
    if (props.length === 0) return;

    const label = this.target === 'template' && this.template
      ? `template "${this.template.name || this.template.businessId}"`
      : `instance "${this.identity.name || this.identity.businessId}"`;
    const ok = await confirmModal({
      title: `Save ${props.length} change${props.length === 1 ? '' : 's'}`,
      body: [
        `Apply styling to ${label}?`,
        h('div', { class: 'crev-modal-diff-list' },
          ...props.map(p => h('div', { class: 'crev-modal-diff-row' },
            h('span', { class: 'crev-modal-diff-key' }, p),
            h('span', { class: 'crev-modal-diff-from' }, displayValue(this.serverVal(p))),
            h('span', { class: 'crev-modal-diff-arrow' }, '→'),
            h('span', { class: 'crev-modal-diff-to' }, displayValue(this.draft[p])),
          )),
        ),
      ],
      confirmLabel: 'Save changes',
      confirmVariant: 'success',
    });
    if (!ok) return;

    this.saving = true;
    this.error = null;
    this.rerender();
    this.send({
      type: 'APPLY_OBJECT_CHANGES',
      rid: this.identity.rid,
      target: this.target,
      changes: buildChangesPayload(this.draft),
    });
  }
}
