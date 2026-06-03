/**
 * Workshop tab — the layout pane (top) over the per-object detail editor
 * (bottom).
 *
 *   - top half:    WorkshopLayoutPane (context strip + Layout tree)
 *   - bottom half: DetailView (object property editor)
 *
 * Two modes, switched by the context type (see applySplitMode):
 *   - Layout context (TabSet/Tab/Container) → SPLIT: the Layout tree gets a
 *     resizable share via a draggable divider. The split percentage persists
 *     in localStorage (default 35/65 — detail wins, since most edits are
 *     "click a widget, edit its props"). Drag down for pure layout work;
 *     double-click resets.
 *   - Otherwise → STACKED: the top shrinks to the context strip and the
 *     detail editor (which already carries path · siblings · children) fills
 *     the rest. No divider, no dead space under a lone chip row.
 */
import { h, render as renderDom } from '../../lib/dom';
import { emptyState } from '../../lib/empty-state';
import type { Tab, SendFn } from './tab-types';
import type { InspectorMessage, BmpObject } from '../../lib/types';
import type { DetailView } from '../detail-view';
import { WorkshopLayoutPane } from './workshop-layout-pane';
import { tabPanelId } from '../state';

const SPLIT_STORAGE_KEY = 'crev_workshop_split';
const SPLIT_MIN_PCT = 20;
const SPLIT_MAX_PCT = 80;
const SPLIT_DEFAULT_PCT = 35;

export class WorkshopTab implements Tab {
  private layoutPane: WorkshopLayoutPane;
  private splitPct: number = SPLIT_DEFAULT_PCT;

  constructor(
    send: SendFn,
    onNavigate: (rid: string) => void,
    private detailView: DetailView,
  ) {
    // `onNavigate` is shared with the orchestrator's SELECT_OBJECT
    // path so clicking a tree row in the layout half loads the
    // object into the detail half.
    this.layoutPane = new WorkshopLayoutPane(send, onNavigate);

    try {
      const stored = localStorage.getItem(SPLIT_STORAGE_KEY);
      const n = stored ? parseFloat(stored) : NaN;
      if (Number.isFinite(n) && n >= SPLIT_MIN_PCT && n <= SPLIT_MAX_PCT) {
        this.splitPct = n;
      }
    } catch { /* localStorage disabled, accept default */ }
  }

  /** True while the layout half's crosshair picker is armed — the
   *  orchestrator uses this to decide whether the next SELECT_OBJECT
   *  means "load in detail" or "set as picker target". */
  isPickingContext(): boolean { return this.layoutPane.isPickingContext(); }
  consumePick(rid: string, name?: string, type?: string, businessId?: string, container?: HTMLElement): void {
    const layoutContainer = container?.querySelector<HTMLElement>('.workshop-layout') ?? container;
    this.layoutPane.consumePick(rid, name, type, businessId, layoutContainer ?? undefined);
  }
  cancelPick(container?: HTMLElement): void {
    const layoutContainer = container?.querySelector<HTMLElement>('.workshop-layout') ?? container;
    this.layoutPane.cancelPick(layoutContainer ?? undefined);
  }

  findObject(rid: string): BmpObject | null {
    return this.layoutPane.findObject(rid) ?? null;
  }

  handleMessage(msg: InspectorMessage): boolean {
    // Each half re-renders into its own container, so we always
    // return false — the orchestrator's full re-render would tear
    // down both halves and rebuild from scratch.
    const topChanged = this.layoutPane.handleMessage(msg);
    const panel = document.getElementById(tabPanelId('workshop'));
    const layoutContainer = panel?.querySelector<HTMLElement>('.workshop-layout');
    const detailContainer = panel?.querySelector<HTMLElement>('.workshop-detail');
    this.layoutPane.setDetailActive(this.detailView.isActive());
    if (topChanged && layoutContainer) this.layoutPane.render(layoutContainer);
    if (detailContainer && this.detailView.isActive()) {
      this.detailView.handleMessage(msg, detailContainer);
    }
    // The top pane only earns its split share when it has a Layout tree to
    // show; otherwise it shrinks to the context strip and the detail half
    // fills the rest. Re-evaluate every message since context can flip
    // between layout and non-layout types.
    if (panel) this.applySplitMode(panel);
    return false;
  }

  /** Toggle between split mode (top = Layout tree at splitPct%, draggable
   *  divider) and stacked mode (top = context strip at content height, no
   *  divider, detail fills the rest). */
  private applySplitMode(panel: HTMLElement): void {
    const layoutContainer = panel.querySelector<HTMLElement>('.workshop-layout');
    const divider = panel.querySelector<HTMLElement>('.workshop-divider');
    if (!layoutContainer || !divider) return;
    const split = this.layoutPane.hasLayoutTree();
    // Split: size to content, capped at splitPct% — a short layout tree
    // shrinks instead of reserving a fixed band of empty space above the
    // detail editor. A tall tree caps at the % and scrolls. Stacked: the
    // top is just the context strip, so size to content and drop the divider.
    layoutContainer.style.flex = '0 1 auto';
    layoutContainer.style.maxHeight = split ? `${this.splitPct}%` : 'none';
    divider.style.display = split ? '' : 'none';
  }

  render(container: HTMLElement): void {
    // Build the split shell once; subsequent re-renders update each
    // half in place via this.layoutPane.render / detailView.refresh.
    // Initial flex; applySplitMode (called at the end of render) sets the
    // content-sized cap based on whether there's a layout tree to show.
    const layoutContainer = h('div', { class: 'workshop-layout', style: `flex: 0 1 auto; max-height: ${this.splitPct}%` });
    const divider = h('div', {
      class: 'workshop-divider',
      role: 'separator',
      'aria-orientation': 'horizontal',
      'aria-label': 'Resize between layout and detail halves',
      'aria-valuenow': String(this.splitPct),
      'aria-valuemin': String(SPLIT_MIN_PCT),
      'aria-valuemax': String(SPLIT_MAX_PCT),
      tabindex: '0',
    });
    const detailContainer = h('div', { class: 'workshop-detail' });

    renderDom(container,
      h('div', { class: 'workshop-split' },
        layoutContainer,
        divider,
        detailContainer,
      ),
    );

    // Mount the halves' contents
    this.layoutPane.setDetailActive(this.detailView.isActive());
    this.layoutPane.render(layoutContainer);
    if (this.detailView.isActive()) {
      this.detailView.refresh(detailContainer);
    } else {
      // Empty-state placeholder — keeps the bottom half visually
      // balanced with the layout tree above.
      renderDom(detailContainer, emptyState({
        variant: 'hero',
        body: 'Click a widget on the BMP page with Inspect on, right-click a BMP element, or pick a scorecard/tab above to load its detail here.',
      }));
    }

    this.wireDivider(container, divider, layoutContainer);
    this.applySplitMode(container);
  }

  activate(): void {
    // DetailView is event-driven; only the layout half needs an
    // activate hook (to refresh PAGE_INFO).
    this.layoutPane.activate();
  }

  deactivate(): void {
    this.layoutPane.deactivate();
  }

  /** Load (or drill-down into) an object in the detail half. Called
   *  by the orchestrator on SELECT_OBJECT / pill clicks. */
  loadObject(obj: BmpObject, panel: HTMLElement, asDrillDown: boolean): void {
    const detailContainer = panel.querySelector<HTMLElement>('.workshop-detail');
    if (!detailContainer) return;
    if (asDrillDown && this.detailView.isActive()) {
      this.detailView.navigateFromExternal(obj.rid, obj, detailContainer);
    } else {
      this.detailView.show(obj, detailContainer);
    }
    // The detail half is now populated — refresh the layout half so its
    // "pick context" nag collapses, and re-evaluate the split.
    this.syncLayoutToDetail(panel);
  }

  /** Re-render the layout half in step with the detail half's active state
   *  (drops/restores the "pick context" nag) and re-apply the split. */
  private syncLayoutToDetail(panel: HTMLElement): void {
    this.layoutPane.setDetailActive(this.detailView.isActive());
    const layoutContainer = panel.querySelector<HTMLElement>('.workshop-layout');
    if (layoutContainer) this.layoutPane.render(layoutContainer);
    this.applySplitMode(panel);
  }

  /** Set the layout half's context + highlight a row in the tree.
   *  Used by the popout's "Layout ↗" button (OPEN_LAYOUT_FOR →
   *  orchestrator → here). The orchestrator switches to Workshop in
   *  case the user was on Connect/Browse/Log. */
  openLayoutFor(rid: string, highlightRid?: string): void {
    this.layoutPane.openLayoutFor(rid, highlightRid);
  }

  /** Reset both halves on a workspace/profile switch — the layout context
   *  and the inspected object both belong to the old workspace. The layout
   *  pane re-detects page context for the new workspace. */
  resetContext(): void {
    this.layoutPane.reset();
    this.detailView.clear();
  }

  /** Clear the detail half — empty-state shows on next render. */
  clear(panel?: HTMLElement): void {
    this.detailView.clear();
    if (panel) {
      const detailContainer = panel.querySelector<HTMLElement>('.workshop-detail');
      if (detailContainer) {
        renderDom(detailContainer, emptyState({
          variant: 'hero',
          body: 'Click a widget on the BMP page with Inspect on, right-click a BMP element, or pick a scorecard/tab above to load its detail here.',
        }));
      }
      // Detail half emptied — bring the layout half's context prompt back.
      this.syncLayoutToDetail(panel);
    }
  }

  /** Drag to resize the split; double-click to snap to default; the
   *  position persists in localStorage on release. */
  private wireDivider(panel: HTMLElement, divider: HTMLElement, layoutContainer: HTMLElement): void {
    let dragging = false;
    let pointerId: number | null = null;

    divider.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragging = true;
      pointerId = e.pointerId;
      divider.classList.add('dragging');
      // Suppress body-wide text selection during the drag so the
      // pointer sweep doesn't highlight everything it passes over.
      document.body.classList.add('crev-divider-dragging');
      divider.setPointerCapture(e.pointerId);
    });
    divider.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const split = panel.querySelector<HTMLElement>('.workshop-split');
      if (!split) return;
      const rect = split.getBoundingClientRect();
      const offset = e.clientY - rect.top;
      let pct = (offset / rect.height) * 100;
      if (pct < SPLIT_MIN_PCT) pct = SPLIT_MIN_PCT;
      if (pct > SPLIT_MAX_PCT) pct = SPLIT_MAX_PCT;
      this.splitPct = pct;
      layoutContainer.style.maxHeight = `${pct}%`;
      divider.setAttribute('aria-valuenow', String(Math.round(pct)));
    });
    const finish = () => {
      if (!dragging) return;
      dragging = false;
      if (pointerId != null) {
        try { divider.releasePointerCapture(pointerId); } catch { /* fine */ }
        pointerId = null;
      }
      divider.classList.remove('dragging');
      document.body.classList.remove('crev-divider-dragging');
      try { localStorage.setItem(SPLIT_STORAGE_KEY, String(this.splitPct)); } catch { /* fine */ }
    };
    divider.addEventListener('pointerup', finish);
    divider.addEventListener('pointercancel', finish);
    divider.addEventListener('dblclick', () => {
      this.splitPct = SPLIT_DEFAULT_PCT;
      layoutContainer.style.maxHeight = `${SPLIT_DEFAULT_PCT}%`;
      try { localStorage.setItem(SPLIT_STORAGE_KEY, String(this.splitPct)); } catch { /* fine */ }
    });
  }
}
