/**
 * Flow rendering — the blueprint flow layer's view builders (v6 FINAL visual contract,
 * experiments/blueprint-flow.html):
 *
 *  - `flowPanel`          — a flow-bearing widget's chain inside its result cell: config band
 *                           (createMode / destination / action verb), reference band (badge + name +
 *                           SHARED + fold chevron), children as badge-led rows in the strict grid
 *                           `drag 14 · lead 38 · name 1fr · prop 110 · dots 30`, nested ButtonGroup as
 *                           an indented sub-block, a quiet "Add element" row.
 *  - `compositeFlowRows`  — the same row grammar for a composite PLACED IN THE GRID (InputSet /
 *                           ButtonContainer / ButtonGroup as an LNode with children); adds/reorders
 *                           there ride the EXISTING layout pipeline (ec.ts composite branch).
 *  - `actionTray`         — the page-top action-menu tray: two-line cards (badge + buttonText + scope,
 *                           verb sentence), ACTION cards expand transports inline, "Add action" card.
 *
 * Read-only rows: blue dots carry EC presence (hover names the property); NO code editing here — that
 * belongs to Inspect/sidebar (locked decision). Names render as textContent only (pitfall 8).
 */
import type { LModel, LNode, FlowNode, FlowProjection } from '../lib/layout/types';
import { isTempId } from '../lib/layout/model';
import { effectiveFlowChildren, effectiveRef, findFlowContainer, trayButtons } from '../lib/layout/flow';
import { getTypeAbbr, getTypeColor } from '../lib/types';
import { flowDotTitle } from '../lib/widget-metadata';

/** Readable ink for a HEX badge colour (registry colours are hex; lib/color-util.contrastInk parses
 *  rgb() strings only). Rec. 601 luma, same threshold. */
function hexInk(hex: string): string {
  const h = hex.replace('#', '');
  const v = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const r = parseInt(v.slice(0, 2), 16), g = parseInt(v.slice(2, 4), 16), b = parseInt(v.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#1c1b16' : '#fff';
}
import { ICON_PLUS, ICON_LIGHTNING, ICON_ARROW_RIGHT, ICON_PENCIL } from '../lib/icons';
import { setIcon } from './geometry';
import { bp } from './state';
import { openFlowPicker, toggleFlowFold, toggleTrayCard, setActionButtonFlag, openPicker, cancelFlowAdd, stageNewRef, openWireExisting, doUnwire, beginRename } from './actions';
import { armFlowRow } from './gestures';

/** A small rename pencil for a flow object (row / reference band / staged-new container). Reuses the
 *  SHARED inline-rename machinery: beginRename flags `bp.renameId`, openPendingRename then makes the
 *  matching `[data-bprename]` span editable — identical Enter-commit / Escape-cancel / outside-commit
 *  behaviour to cells and tabs. mousedown + preventDefault so it doesn't steal focus / start a drag. */
function renamePencil(id: string, title: string): HTMLElement {
  const b = document.createElement('button'); b.className = 'bp-fedit'; setIcon(b, ICON_PENCIL); b.title = title;
  b.addEventListener('mousedown', (e) => { e.stopPropagation(); e.preventDefault(); beginRename(id); });
  return b;
}

/** The 34×17 mono type chip that leads every flow row / band (v6 "badge"). Dashed = staged (NEW). */
function flowBadge(className: string, staged = false, small = false): HTMLElement {
  const b = document.createElement('span');
  b.className = 'bp-fbadge' + (staged ? ' newb' : '') + (small ? ' sm' : '');
  b.textContent = getTypeAbbr(className);
  const c = getTypeColor(className);
  b.style.setProperty('--fb', c);
  // Contrast ink per badge colour — the gold ACT / light-blue field chips need dark ink (v6). Dashed
  // staged badges keep the colour itself as ink (transparent fill), handled in CSS.
  if (!staged) b.style.color = hexInk(c);
  b.title = className;
  return b;
}

/** The drag-dots handle (14px col). Armed for the vertical flow-row drag unless `inert`. */
function dragDots(inert = false): HTMLElement {
  const d = document.createElement('span'); d.className = 'bp-fdrag' + (inert ? ' inert' : '');
  for (let i = 0; i < 3; i++) d.appendChild(document.createElement('i'));
  return d;
}

/** One flow row in the strict grid. `key` = the reorder container (flow key OR grid-composite id);
 *  `grid` = the row is an LNode child of a grid composite (reorder rides the layout pipeline). */
function flowRow(node: FlowNode, key: string, opts: { grid?: boolean; nested?: boolean } = {}): HTMLElement {
  const row = document.createElement('div');
  const staged = isTempId(node.id);
  row.className = 'bp-frow' + (node.isBreak ? ' brk' : '') + (staged ? ' stnew' : '');
  row.dataset.bpflip = `flow:${key}:${node.id}`; // FLIP key — flow rows animate on reorder like cells
  row.dataset.flowkey = key;
  row.dataset.flowid = node.id;
  const drag = dragDots();
  armFlowRow(drag, row, key, node.id, !!opts.grid);
  const lead = document.createElement('span'); lead.className = 'bp-flead';
  lead.appendChild(flowBadge(node.className, staged));
  const nm = document.createElement('span'); nm.className = 'bp-fname'; nm.textContent = node.name; nm.dataset.bprename = node.id;
  const prop = document.createElement('span'); prop.className = 'bp-fprop';
  if (node.prop) { const t = document.createElement('span'); t.textContent = node.prop; prop.appendChild(t); }
  if (node.required) { const r = document.createElement('i'); r.className = 'bp-freq'; r.title = 'required'; prop.appendChild(r); }
  // Rename affordance (not on structural breaks — they carry no meaningful name).
  if (!node.isBreak) prop.appendChild(renamePencil(node.id, `Rename "${node.name}"`));
  if (staged) {
    const tag = document.createElement('button'); tag.className = 'bp-ftag new'; tag.textContent = 'NEW';
    tag.title = 'Staged — created on Apply. Click to cancel this add.';
    tag.addEventListener('mousedown', (e) => { e.stopPropagation(); e.preventDefault(); cancelFlowAdd(key, node.id); });
    prop.appendChild(tag);
  }
  const dots = document.createElement('span'); dots.className = 'bp-fdots';
  for (const d of node.dots ?? []) {
    const i = document.createElement('i'); i.className = d.set ? '' : 'empty'; i.title = flowDotTitle(d.prop, d.set);
    dots.appendChild(i);
  }
  row.append(drag, lead, nm, prop, dots);
  return row;
}

/** The quiet "+ Add …" row at the end of a flow list. */
function addRow(label: string, onOpen: (at: { x: number; y: number }) => void): HTMLElement {
  const r = document.createElement('button'); r.className = 'bp-faddrow';
  const ic = document.createElement('span'); setIcon(ic, ICON_PLUS);
  r.append(ic, document.createTextNode(label));
  r.addEventListener('mousedown', (e) => { e.stopPropagation(); e.preventDefault(); onOpen({ x: e.clientX, y: e.clientY }); });
  return r;
}

/** Rows for a child list, nesting a ButtonGroup's children as an indented sub-block with its own add
 *  row. `keyFor` maps a group child to its reorder container key (its own bid for flow, same for grid). */
function childRows(children: FlowNode[], key: string, grid: boolean, into: HTMLElement): void {
  for (const c of children) {
    into.appendChild(flowRow(c, key, { grid }));
    if (c.className === 'ButtonGroup') {
      const nest = document.createElement('div'); nest.className = 'bp-fnest';
      for (const gc of c.children ?? []) nest.appendChild(flowRow(gc, c.id, { grid, nested: true }));
      nest.appendChild(addRow('Add button', at => grid
        ? openPicker(c.id, { at })
        : openFlowPicker(c.id, 'ButtonGroup', { at })));
      into.appendChild(nest);
    }
  }
}

const CREATE_MODE_LABEL: Record<string, string> = { ADD: 'ADD', EDITORADD: 'EDITOR ADD', EDITOREDIT: 'EDITOR EDIT' };

/** Config band for a CreateObjectView: `EDITOR ADD creates <type> → <destination>`. */
function covBand(p: FlowProjection): HTMLElement {
  const band = document.createElement('div'); band.className = 'bp-fband';
  const mode = document.createElement('span'); mode.className = 'mono strong';
  mode.textContent = CREATE_MODE_LABEL[p.createMode ?? ''] ?? (p.createMode || 'CREATE');
  band.appendChild(mode);
  if (p.objectType) {
    band.appendChild(document.createTextNode(p.createMode === 'EDITOREDIT' ? 'edits' : 'creates'));
    const ty = document.createElement('span'); ty.className = 'mono'; ty.textContent = p.objectType; band.appendChild(ty);
  }
  if (p.destExpr) {
    const arr = document.createElement('span'); arr.className = 'aic'; setIcon(arr, ICON_ARROW_RIGHT); band.appendChild(arr);
    const de = document.createElement('span'); de.className = 'mono'; de.textContent = p.destExpr; band.appendChild(de);
  }
  return band;
}

/** The verb sentence for an ActionButton (shared by the in-grid config band and the tray card line 2). */
function actionSentence(p: FlowProjection): HTMLElement {
  const d = document.createElement('span'); d.className = 'd';
  const strong = (t: string): HTMLElement => { const b = document.createElement('b'); b.textContent = t; return b; };
  const mono = (t: string): HTMLElement => { const m = document.createElement('span'); m.className = 'm'; m.textContent = t; return m; };
  if (p.kind === 'action') {
    d.append('Runs ', strong(p.actionGroup || 'action group'));
    if (p.transports?.length) d.append(` · ${p.transports.length} transport${p.transports.length === 1 ? '' : 's'}`);
  } else if (p.kind === 'add') {
    d.append('Adds ', strong(p.addItem || 'an object'));
    if (p.destExpr) d.append(' to ', mono(p.destExpr));
  } else if (p.kind === 'navigate') {
    d.append('Goes to ', mono(p.navExpr || '(no expression)'));
  } else {
    d.append('Action button');
  }
  return d;
}

/** In-grid ActionButton config band: verb sentence + the Placement control (In grid | Action bar). */
function actionBand(p: FlowProjection, staged: boolean | undefined): HTMLElement {
  const band = document.createElement('div'); band.className = 'bp-fband';
  const ic = document.createElement('span'); ic.className = 'aic'; setIcon(ic, ICON_LIGHTNING);
  band.append(ic, actionSentence(p));
  const end = document.createElement('span'); end.className = 'end';
  end.appendChild(placementControl(p.ownerId, staged ?? p.displayOnActionMenu ?? false));
  band.appendChild(end);
  return band;
}

/** The two-way Placement control: In grid | Action bar — stages `displayOnActionMenu`. */
function placementControl(buttonId: string, onMenu: boolean): HTMLElement {
  const seg = document.createElement('span'); seg.className = 'bp-fseg';
  for (const [label, val] of [['In grid', false], ['Action bar', true]] as const) {
    const b = document.createElement('button');
    b.className = val === onMenu ? 'on' : '';
    b.textContent = label;
    b.title = val ? 'Move this button to the page action menu (stages displayOnActionMenu)' : 'Render this button as a grid widget (stages displayOnActionMenu off)';
    b.addEventListener('mousedown', (e) => {
      e.stopPropagation(); e.preventDefault();
      if (val !== onMenu) setActionButtonFlag(buttonId, 'displayOnActionMenu', val);
    });
    seg.appendChild(b);
  }
  return seg;
}

/** Reference band: INS/EPG badge + name + SHARED tag + fold chevron. */
function refBand(m: LModel, p: FlowProjection, folded: boolean): HTMLElement {
  const band = document.createElement('div'); band.className = 'bp-fband';
  band.appendChild(flowBadge(p.refClass ?? 'InputSet'));
  const staged = p.refId ? m.flowEdits?.[p.refId]?.rename : undefined; // staged rename overrides the label
  const nm = document.createElement('span'); nm.className = 'mono'; nm.textContent = staged ?? p.refName ?? p.refId ?? '';
  if (p.refId) nm.dataset.bprename = p.refId;
  band.appendChild(nm);
  const end = document.createElement('span'); end.className = 'end';
  if (p.refId) end.appendChild(renamePencil(p.refId, `Rename ${p.refClass ?? 'reference'} "${staged ?? p.refName ?? p.refId}"`));
  if (p.shared) {
    const sh = document.createElement('span'); sh.className = 'bp-fshared'; sh.textContent = 'SHARED';
    sh.title = 'Referenced by more than one widget on this page — changes here appear everywhere it is used.';
    end.appendChild(sh);
  }
  const fold = document.createElement('button'); fold.className = 'bp-ffold'; fold.textContent = folded ? '▸' : '▾';
  fold.title = folded ? 'Expand the flow chain' : 'Fold the flow chain';
  fold.addEventListener('mousedown', (e) => { e.stopPropagation(); e.preventDefault(); toggleFlowFold(p.ownerId); });
  end.appendChild(fold);
  band.appendChild(end);
  return band;
}

/** The reference slot (prop) a widget class wires: InputView → inputSet, CreateObjectView → editPage. */
function refPropOf(className: string): 'inputSet' | 'editPage' | null {
  return className === 'InputView' ? 'inputSet' : className === 'CreateObjectView' ? 'editPage' : null;
}

/** Whether a widget's cell renders a flow panel (drives composite-style sizing in result.ts): a fetched
 *  projection, a staged reference wire, or a reference-less (incl. freshly-staged) InputView/COV whose
 *  band offers "wire to existing / + new". */
export function hasFlowPanel(m: LModel, node: LNode): boolean {
  if (m.flows?.[node.id]) return true;
  if (m.flowEdits?.[node.id]?.wireRef) return true;
  return refPropOf(node.className) !== null; // reference-less (or staged-new) InputView/COV → affordance band
}

/** The two affordances of a reference-less InputView/COV: "wire to existing" + "+ new". */
function noRefBand(widgetId: string, prop: 'inputSet' | 'editPage'): HTMLElement {
  const band = document.createElement('div'); band.className = 'bp-fband';
  const what = prop === 'inputSet' ? 'Input set' : 'Edit page';
  const lbl = document.createElement('span'); lbl.textContent = `No ${what.toLowerCase()} linked`; band.appendChild(lbl);
  const end = document.createElement('span'); end.className = 'end';
  const wire = document.createElement('button'); wire.className = 'bp-fwire';
  wire.textContent = 'wire to existing…';
  wire.title = `Link this widget to an existing ${what} from the workspace`;
  wire.addEventListener('mousedown', (e) => { e.stopPropagation(); e.preventDefault(); openWireExisting(widgetId, prop, { x: e.clientX, y: e.clientY }); });
  const mk = document.createElement('button'); mk.className = 'bp-fwire new';
  mk.textContent = `+ new ${what.toLowerCase()}`;
  mk.title = `Stage a new ${what} (created on Apply in the page's support Category); add its elements right away`;
  mk.addEventListener('mousedown', (e) => { e.stopPropagation(); e.preventDefault(); stageNewRef(widgetId, prop); });
  end.append(wire, mk);
  band.appendChild(end);
  return band;
}

/** Reference band for a STAGED reference (wired-to-existing or staged-new): dashed badge for a new
 *  container, WIRED/NEW tag, and a cancel ✕ (drops the wire + the staged-new container behind it). */
function stagedRefBand(m: LModel, widgetId: string, ref: { id: string; className: string; name?: string; isNew: boolean }): HTMLElement {
  const band = document.createElement('div'); band.className = 'bp-fband';
  band.appendChild(flowBadge(ref.className, ref.isNew));
  const staged = m.flowEdits?.[ref.id]?.rename; // a wired-existing ref can carry a staged rename
  const nm = document.createElement('span'); nm.className = 'mono'; nm.textContent = staged ?? ref.name ?? ref.id;
  nm.dataset.bprename = ref.id; band.appendChild(nm);
  const end = document.createElement('span'); end.className = 'end';
  end.appendChild(renamePencil(ref.id, ref.isNew ? 'Rename the new reference' : `Rename ${ref.className} "${staged ?? ref.name ?? ref.id}"`));
  const tag = document.createElement('span'); tag.className = 'bp-ftag ' + (ref.isNew ? 'new' : 'mv');
  tag.textContent = ref.isNew ? 'NEW' : 'WIRED';
  tag.title = ref.isNew
    ? 'Staged: created on Apply in the page\'s support Category, then linked to this widget.'
    : 'Staged: linked to this widget on Apply.';
  end.appendChild(tag);
  const x = document.createElement('button'); x.className = 'bp-fwire';
  x.textContent = '✕';
  x.title = ref.isNew ? 'Cancel the new reference (and its staged elements)' : 'Cancel the staged link';
  x.addEventListener('mousedown', (e) => { e.stopPropagation(); e.preventDefault(); doUnwire(widgetId); });
  end.appendChild(x);
  band.appendChild(end);
  return band;
}

/** The flow chain inside a flow-bearing widget's result cell. Returns null when the widget renders its
 *  normal watermark body (no projection, no wire, not an InputView/COV). */
export function flowPanel(m: LModel, node: LNode): HTMLElement | null {
  const p = m.flows?.[node.id];
  const wrap = document.createElement('div'); wrap.className = 'bp-fpanel';
  if (p?.ownerClass === 'CreateObjectView') wrap.appendChild(covBand(p));
  if (p?.ownerClass === 'ActionButton') {
    const staged = m.flowEdits?.[p.ownerId]?.displayOnActionMenu;
    wrap.appendChild(actionBand(p, staged));
  }
  const ref = effectiveRef(m, node.id);
  const prop = refPropOf(node.className);
  if (ref) {
    const folded = bp.flowFolds.has(node.id);
    if (ref.staged) wrap.appendChild(stagedRefBand(m, node.id, ref));
    else if (p) wrap.appendChild(refBand(m, p, folded)); // live reference — the normal band (SHARED, fold)
    if (!folded || ref.staged) {
      // A staged-new container and a live/on-page reference both resolve children through the ONE
      // effective-children engine. A wired EXISTING off-page set/page gets its real children fetched on
      // demand (FIX 2) → findFlowContainer sees them. While that fetch is in flight, say "loading"; if it
      // failed / hasn't started, say the contents are unknown honestly — staged adds still list + compile.
      const known = findFlowContainer(m, ref.id) !== null;
      if (!known) {
        const note = document.createElement('div'); note.className = 'bp-fnote';
        note.textContent = bp.flowRefChildrenPending.has(ref.id)
          ? 'Loading existing elements…'
          : 'Existing elements are not loaded here; new elements stage below.';
        wrap.appendChild(note);
      }
      childRows(effectiveFlowChildren(m, ref.id), ref.id, false, wrap);
      wrap.appendChild(addRow('Add element', at => openFlowPicker(ref.id, ref.className, { at })));
    }
  } else if (prop && p?.kind !== 'action' && p?.kind !== 'add' && p?.kind !== 'navigate') {
    // Reference-less InputView/COV (typical for a widget freshly staged from the grid picker):
    // offer the two affordances. ActionButtons never take this path (their band is the verb).
    wrap.appendChild(noRefBand(node.id, prop));
  }
  return wrap.children.length ? wrap : null;
}

/** A grid-placed composite's children in the same row grammar (source = LNode.children; staging =
 *  the EXISTING layout pipeline: openPicker → addWidget → diff create/reorder → ec composite branch).
 *  No EC dots — the layout wire doesn't project code presence for grid children (honest omission). */
export function compositeFlowRows(node: LNode): HTMLElement {
  const wrap = document.createElement('div'); wrap.className = 'bp-fpanel';
  const toFlow = (c: LNode): FlowNode => ({ id: c.id, className: c.className, name: c.name, ...(c.rid ? { rid: c.rid } : {}),
    ...(c.children.length ? { children: c.children.map(toFlow) } : {}) });
  childRows(node.children.map(toFlow), node.id, true, wrap);
  wrap.appendChild(addRow('Add element', at => openPicker(node.id, { at })));
  return wrap;
}

// ── action-menu tray ─────────────────────────────────────────────────────────

/** One tray card: badge + buttonText + scope chip; line 2 = the verb sentence (+ inline transports for
 *  ACTION). A staged NEW button renders dashed-green; one staged to LEAVE for the grid renders amber. */
function trayCard(m: LModel, p: FlowProjection, leaving = false): HTMLElement {
  const staged = isTempId(p.ownerId);
  const card = document.createElement('div'); card.className = 'bp-acard' + (staged ? ' stnew' : '') + (leaving ? ' leaving' : '');
  const l1 = document.createElement('div'); l1.className = 'l1';
  l1.appendChild(flowBadge('ActionButton', staged));
  const bt = document.createElement('span'); bt.className = 'bt';
  bt.textContent = nameOfButton(m, p) ?? 'Action button';
  l1.appendChild(bt);
  if (staged) {
    const tag = document.createElement('span'); tag.className = 'bp-ftag new'; tag.textContent = 'NEW'; l1.appendChild(tag);
  } else if (leaving) {
    const tag = document.createElement('span'); tag.className = 'bp-ftag mv'; tag.textContent = 'TO GRID';
    tag.title = 'Staged: on Apply this button renders in the grid instead of the action menu.';
    l1.appendChild(tag);
  } else {
    const allTabs = m.flowEdits?.[p.ownerId]?.displayOnAllTabs ?? p.displayOnAllTabs ?? false;
    const scope = document.createElement('button'); scope.className = 'scope' + (allTabs ? ' on' : '');
    scope.textContent = allTabs ? 'ALL TABS' : 'THIS TAB';
    scope.title = allTabs ? 'Shown on every tab. Click to stage: this tab only (displayOnAllTabs off).' : 'Shown on its own tab. Click to stage: show on all tabs.';
    scope.addEventListener('mousedown', (e) => { e.stopPropagation(); e.preventDefault(); setActionButtonFlag(p.ownerId, 'displayOnAllTabs', !allTabs); });
    l1.appendChild(scope);
  }
  card.appendChild(l1);

  const l2 = document.createElement('div'); l2.className = 'l2';
  const vic = document.createElement('span'); vic.className = 'vic';
  setIcon(vic, p.kind === 'add' ? ICON_PLUS : p.kind === 'navigate' ? ICON_ARROW_RIGHT : ICON_LIGHTNING);
  l2.append(vic, actionSentence(p));
  const open = bp.trayCardsOpen.has(p.ownerId);
  if (p.kind === 'action' && p.transports?.length) {
    const chev = document.createElement('button'); chev.className = 'chev'; chev.textContent = open ? '▴' : '▾';
    chev.title = open ? 'Hide transports' : 'Show transports';
    chev.addEventListener('mousedown', (e) => { e.stopPropagation(); e.preventDefault(); toggleTrayCard(p.ownerId); });
    l2.appendChild(chev);
  }
  card.appendChild(l2);

  if (!staged) {
    // Placement moves both ways: the tray card offers the road back to the grid (and the undo of it).
    const back = document.createElement('button'); back.className = 'bp-agrid';
    back.textContent = leaving ? 'keep in menu' : 'to grid';
    back.title = leaving
      ? 'Cancel the staged move — keep this button in the action menu'
      : 'Render this button as a grid widget instead (stages displayOnActionMenu off)';
    back.addEventListener('mousedown', (e) => { e.stopPropagation(); e.preventDefault(); setActionButtonFlag(p.ownerId, 'displayOnActionMenu', leaving); });
    l1.appendChild(back);
  }

  if (open && p.kind === 'action' && p.transports?.length) {
    const trans = document.createElement('div'); trans.className = 'bp-atrans';
    for (const tr of p.transports) {
      const row = document.createElement('div'); row.className = 'trow';
      row.appendChild(flowBadge(tr.className, false, true));
      const nm = document.createElement('span'); nm.className = 'tn'; nm.textContent = tr.name; row.appendChild(nm);
      if (tr.codeSet) {
        const dots = document.createElement('span'); dots.className = 'bp-fdots';
        const i = document.createElement('i'); i.title = 'expression set'; dots.appendChild(i);
        row.appendChild(dots);
      }
      trans.appendChild(row);
    }
    card.appendChild(trans);
  }
  return card;
}

/** A tray card's title: the projection's ownerName (menu buttons have NO layout node, so the
 *  projection is the only name source), or the staged add's name for a NEW button. */
function nameOfButton(m: LModel, p: FlowProjection): string | undefined {
  for (const e of Object.values(m.flowEdits ?? {})) {
    const add = e.adds?.find(a => a.id === p.ownerId);
    if (add) return add.name;
  }
  return p.ownerName ?? p.refName;
}

/** The action-menu tray for the viewed tab (page-top right). Cards for the tab's menu buttons +
 *  all-tabs ones, an honest count note for the rest, staged NEW buttons, and the "Add action" card. */
export function actionTray(m: LModel, viewedTabId: string | null): HTMLElement {
  const { shown, otherTabs } = trayButtons(m, viewedTabId);
  // staged page-level adds (temp-key flowEdits whose single add is an ActionButton) render as NEW cards
  const stagedCards: FlowProjection[] = [];
  for (const [key, e] of Object.entries(m.flowEdits ?? {})) {
    if (key.includes(':') && e.adds?.length === 1 && e.adds[0].className === 'ActionButton') {
      stagedCards.push({ ownerId: key, ownerClass: 'ActionButton', kind: 'plain', children: [], refName: e.adds[0].name });
    }
  }
  const tray = document.createElement('div'); tray.className = 'bp-amenu';
  const head = document.createElement('div'); head.className = 'bp-amenu-head';
  const t = document.createElement('span'); t.className = 't'; t.textContent = 'ACTION MENU';
  const tabName = m.tabs.find(x => x.id === viewedTabId)?.name ?? 'This page';
  const count = shown.length + stagedCards.length;
  const n = document.createElement('span'); n.className = 'n';
  n.textContent = `${tabName} · ${count} button${count === 1 ? '' : 's'}` + (otherTabs ? ` (${otherTabs} on other tabs)` : '');
  head.append(t, n);
  tray.appendChild(head);
  const cards = document.createElement('div'); cards.className = 'bp-acards';
  for (const e of shown) cards.appendChild(trayCard(m, e.p, e.leaving));
  for (const p of stagedCards) cards.appendChild(trayCard(m, p));
  const add = document.createElement('button'); add.className = 'bp-aadd';
  const ic = document.createElement('span'); setIcon(ic, ICON_PLUS);
  add.append(ic, document.createTextNode('Add action'));
  add.title = 'Stage a new action-menu button (created with displayOnActionMenu on Apply)';
  add.addEventListener('mousedown', (e) => {
    e.stopPropagation(); e.preventDefault();
    // Born bound to the viewed tab — RESULT when the page routes its buttons through the shared
    // Result tab (the fixture convention), else the viewed tab itself.
    openFlowPicker(viewedTabId ?? 'RESULT', 'ActionButton', { at: { x: e.clientX, y: e.clientY }, isAction: true });
  });
  cards.appendChild(add);
  tray.appendChild(cards);
  return tray;
}
