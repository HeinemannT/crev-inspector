/**
 * Flow walker — visualizes the execution graph for the flow-bearing types
 * (see FLOW_TYPES): InputView / InputSet, ActionButton / transport groups,
 * Label, and the Add-object pages (EditPage / CreateObjectView).
 *
 * Ledger layout (2026-07-05 sign-off): the chain's single-child spine
 * collapses into quiet full-bleed "container" group rows (InputSet /
 * NotificationTransportGroup); the leaves render as ACCORDION STEPS — a 38px
 * row [stub badge · name · grey mono id · scent · chevron] that unfolds into
 * the field lines. Row grammar rule: the right side never mixes value kinds —
 * the scent is a single grey mark (key glyph = binds an input key, ⚡n =
 * carries n EC slots), never a value. The id sits inline after the name in
 * grey mono (blank-name objects promote the id into the name slot).
 *
 * Interactions: clicking a STEP ROW toggles it; clicking any BADGE copies the
 * business id (green flash; Alt → RID, Shift → template, Ctrl → reference).
 * Group rows keep the whole-row copy+navigate gesture; navigation into a leaf
 * happens via the Structure segment (the mock has no per-step open).
 *
 * Field lines are icon-led — a leading glyph then content, no gutter labels:
 *   • the input *.key binding → a key glyph + the mono identifier
 *   • each code property → a *semantic* glyph encoding the trigger
 *     (expression→lightning, initExpression→arrow-in, afterExpression→arrow-out,
 *     showExpression→eye-slash, enableExpression→subtitles-slash,
 *     defaultExpression→code-block), then the prop name + line count, a
 *     syntax-highlighted first-line preview, the runtime-gate note when the EC
 *     is dormant, and `reads` chips that flash their source row on hover.
 */

import { h, svg, statusFlash } from '../../lib/dom';
import { typeBadge } from '../../lib/type-badge';
import { ecPreviewSpan } from '../../lib/ec-format';
import { resolveCopyText, getModifier, type CopyModifier } from '../../lib/namespace';
import {
  ICON_KEY, ICON_CODE, ICON_LIGHTNING, ICON_ARROW_SQUARE_IN, ICON_ARROW_OUT,
  ICON_EYE_SLASH, ICON_SUBTITLES_SLASH, ICON_CODE_BLOCK, ICON_VARIABLE, ICON_CLOCK,
  ICON_SHIELD, ICON_PENCIL, ICON_REFRESH, ICON_CHEVRON,
} from '../../lib/icons';
import type { FlowChainMsg, FlowStepMsg, FlowCodeFieldMsg, InspectorMessage } from '../../lib/types';

type SendFn = (msg: InspectorMessage) => void;

export interface FlowSectionInput {
  chain: FlowChainMsg | null;
  loading: boolean;
  error?: string | null;
  onRetry?: () => void;
  onNavigate: (rid: string) => void;
  sendMessage: SendFn;
  /** Controls that belong to the inspected root node, before its code fields. */
  rootContent?: HTMLElement | null;
  /** Code properties that are configured but currently inactive, with reason. */
  inactiveCodeFields?: Readonly<Record<string, string>>;
}

/** Trigger-encoding glyph per code property. The prop name is still spelled
 *  out beside it; the icon is a fast secondary cue so two identical previews
 *  on different triggers are distinguishable at a glance. */
const PROP_ICON: Record<string, string> = {
  expression: ICON_LIGHTNING,        // runs on the action (click / submit)
  initExpression: ICON_ARROW_SQUARE_IN, // runs once on load
  afterExpression: ICON_ARROW_OUT,   // re-runs after the value changes
  showExpression: ICON_EYE_SLASH,    // visibility gate
  enableExpression: ICON_SUBTITLES_SLASH, // enabled / clickable gate
  defaultExpression: ICON_CODE_BLOCK, // provides the default value / text
  validateExpression: ICON_SHIELD,   // gates the action on validation
  editExpression: ICON_PENCIL,       // edit-mode expression
  refreshExpression: ICON_REFRESH,   // refresh trigger
  // ChangePropertyTransport action fields (write a property on the target):
  function: ICON_VARIABLE,           // calc function (CorpoCalcExpression)
  dateFunction: ICON_CLOCK,          // date function
  // `value` (CorpoTokenListExpression) falls back to the generic code glyph.
};

function propIcon(prop: string): string {
  return PROP_ICON[prop] ?? ICON_CODE;
}

export function renderFlowSection(input: FlowSectionInput): HTMLElement {
  const body = input.loading
    ? h('div', { class: 'flow-loading' }, 'Loading flow…')
    : input.error
      ? h('div', { class: 'flow-error' },
          h('div', {}, input.error),
          input.onRetry
            ? h('button', { class: 'btn btn-small', onClick: input.onRetry }, 'Retry')
            : null,
        )
      : input.chain && input.chain.steps.length > 0
        ? renderChain(input.chain, input)
        : h('div', { class: 'flow-empty' },
            'This widget has no Flow chain. ',
            'Flow appears for InputView / InputSet, ActionButton, Label, and Add-object pages ',
            '(EditPage / CreateObjectView) that bind to code. Once any of those exist, their cascade shows here.',
          );

  // No header — the segment bar carries the label and the quiet facts.
  return h('div', { class: 'flow-section' }, body);
}

function renderChain(chain: FlowChainMsg, input: FlowSectionInput): HTMLElement {
  const container = h('div', { class: 'flow-chain' });
  for (const [index, step] of chain.steps.entries()) {
    container.appendChild(renderTopStep(step, input, index === 0 ? input.rootContent : null));
  }
  // Cross-reference highlight: hovering a `reads` chip flashes the source row.
  container.addEventListener('mouseover', e => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>('.flow-reads-chip');
    if (chip?.dataset.sourceRid) flashSourceRow(container, chip.dataset.sourceRid, true);
  });
  container.addEventListener('mouseout', e => {
    const chip = (e.target as HTMLElement).closest<HTMLElement>('.flow-reads-chip');
    if (chip?.dataset.sourceRid) flashSourceRow(container, chip.dataset.sourceRid, false);
  });
  return container;
}

/** Collapse a single-child spine: the root, the chain of single-child
 *  "container" nodes after it, and the leaves (the first node with ≠1
 *  children supplies them). */
function spine(step: FlowStepMsg): { root: FlowStepMsg; containers: FlowStepMsg[]; leaves: FlowStepMsg[] } {
  const chain: FlowStepMsg[] = [step];
  let c = step;
  while (c.children && c.children.length === 1) {
    c = c.children[0];
    chain.push(c);
  }
  const leaves = c.children && c.children.length > 1 ? c.children : [];
  return { root: chain[0], containers: chain.slice(1), leaves };
}

function renderTopStep(step: FlowStepMsg, input: FlowSectionInput, rootContent?: HTMLElement | null): HTMLElement {
  const { root, containers, leaves } = spine(step);
  const frag = h('div', { class: 'flow-root' });

  // The root usually IS the inspected object — its identity already heads the
  // pane, so a bare repeat row is noise. Render it as a step ONLY when it
  // carries its own fields (ActionButton expression / Label default / …).
  if (rootContent || root.inputKey || (root.codeFields && root.codeFields.length > 0)) {
    frag.appendChild(renderStep(root, input, /* open */ true, rootContent));
  }
  if (root.hint && (!root.codeFields || root.codeFields.length === 0)) {
    frag.appendChild(h('div', { class: 'flow-hint' }, root.hint));
  }

  for (const c of containers) {
    frag.appendChild(renderGroup(c, input));
    if (c.hint) frag.appendChild(h('div', { class: 'flow-hint' }, c.hint));
    const cBody = renderFields(c, input);
    if (cBody) frag.appendChild(cBody);
  }

  // Few steps → unfold everything; a long ledger starts collapsed for scan.
  const openAll = leaves.length <= 2;
  for (const leaf of leaves) frag.appendChild(renderStep(leaf, input, openAll));
  return frag;
}

/** Container group row (InputSet / NotificationTransportGroup): quiet
 *  full-bleed strip — badge (copy) · name · grey id · open ↗. The whole row
 *  keeps the copy+navigate gesture. */
function renderGroup(node: FlowStepMsg, input: FlowSectionInput): HTMLElement {
  const name = node.identity.name || '';
  const bid = node.identity.businessId || node.identity.rid;
  return h('div', { class: 'flow-group', ...navAttrs(node, input) },
    badgeFor(node),
    name ? h('span', { class: 'flow-group-name' }, name) : null,
    h('span', { class: `flow-row-id mono${name ? '' : ' flow-row-id--solo'}` }, bid),
    h('span', { class: 'flow-sp' }),
    h('span', { class: 'flow-group-go' }, 'open ↗'),
  );
}

/** Accordion step — the ledger row. Row click toggles; badge click copies;
 *  "Open ↗" inside the body navigates. */
function renderStep(
  node: FlowStepMsg,
  input: FlowSectionInput,
  open: boolean,
  content?: HTMLElement | null,
): HTMLElement {
  // A ButtonGroup is just a layout wrapper — don't give it a step; draw a
  // subtle outline with a small "group · name" label and lay its buttons inside.
  if (node.identity.type === 'ButtonGroup' && node.children && node.children.length > 0) {
    const box = h('div', { class: 'flow-groupbox' });
    box.appendChild(h('div', { class: 'flow-grouplabel' },
      node.identity.name ? `group · ${node.identity.name}` : 'group'));
    for (const child of node.children) box.appendChild(renderStep(child, input, open));
    return box;
  }

  const name = node.identity.name || '';
  const bid = node.identity.businessId || node.identity.rid;
  const codes = node.codeFields ?? [];

  // The scent: ONE grey mark, never a value. Key glyph wins (the binding is
  // the step's role); otherwise the EC slot count.
  const scent = node.inputKey
    ? h('span', { class: 'flow-scent', title: `Binds input key ${node.inputKey}` }, svg(ICON_KEY))
    : codes.length > 0
      ? h('span', { class: 'flow-scent', title: `${codes.length} Extended Code slot${codes.length === 1 ? '' : 's'}` },
          svg(ICON_LIGHTNING), String(codes.length))
      : null;

  const stepEl = h('div', { class: `flow-step${open ? ' flow-step--open' : ''}` });
  const toggle = () => stepEl.classList.toggle('flow-step--open');

  const head = h('div', {
      class: 'flow-step-h',
      // data-rid: the reads-chip hover flash locates its source row by rid.
      'data-rid': node.identity.rid,
      role: 'button',
      tabindex: '0',
      onClick: (e: MouseEvent) => {
        if ((e.target as HTMLElement).closest('.bdg, .flow-cf-edit')) return;
        toggle();
      },
      onKeydown: (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
      },
    },
    badgeFor(node),
    name ? h('span', { class: 'flow-step-nm' }, name) : null,
    h('span', { class: `flow-row-id mono${name ? '' : ' flow-row-id--solo'}` }, bid),
    h('span', { class: 'flow-sp' }),
    scent,
    h('span', { class: 'flow-step-car' }, svg(ICON_CHEVRON)),
  );
  stepEl.appendChild(head);

  const body = h('div', { class: 'flow-step-b' });
  if (node.hint) body.appendChild(h('div', { class: 'flow-hint' }, node.hint));
  if (content) body.appendChild(content);
  const fields = renderFields(node, input);
  if (fields) body.appendChild(fields);
  // Rare: a step that itself branches (nested input sets). Recurse so no node
  // is dropped; the indent makes the extra depth legible.
  if (node.children && node.children.length > 0) {
    const sub = h('div', { class: 'flow-substeps' });
    for (const child of node.children) sub.appendChild(renderStep(child, input, false));
    body.appendChild(sub);
  }
  stepEl.appendChild(body);

  return stepEl;
}

/** The stub badge as the copy affordance: plain click copies the business id
 *  (green tile flash), Alt → RID, Shift → template, Ctrl → reference. */
function badgeFor(node: FlowStepMsg): HTMLElement {
  const { rid, businessId, type } = node.identity;
  const b = typeBadge(type, { size: 'xs' });
  b.classList.add('flow-bdg');
  b.title = `Copy ${businessId || rid} (Alt: RID; Shift: template; Ctrl: reference)`;
  b.setAttribute('role', 'button');
  b.setAttribute('tabindex', '0');
  b.addEventListener('click', (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    copyFromBadge(b, node, getModifier(e));
  });
  b.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      copyFromBadge(b, node, 'plain');
    }
  });
  return b;
}

function copyFromBadge(badge: HTMLElement, node: FlowStepMsg, mod: CopyModifier): void {
  const { rid, businessId, type } = node.identity;
  const { text } = mod === 'plain'
    ? { text: businessId || rid }
    : resolveCopyText({ rid, businessId, type }, mod);
  if (!text) return;
  copyToClipboard(text);
  statusFlash(`Copied ${text} \u2713`);
  // Green confirmation: tile + chip flip to success, chip shows a check.
  const lbl = badge.querySelector<HTMLElement>('.lbl');
  const original = lbl?.textContent ?? '';
  if (lbl) lbl.textContent = '✓';
  badge.classList.add('bdg-copied');
  setTimeout(() => {
    if (lbl) lbl.textContent = original;
    badge.classList.remove('bdg-copied');
  }, 700);
}

const FLOW_COPY_HINT =
  'Click: copy ID and open (Alt: RID; Shift: template; Ctrl: reference)';

function navAttrs(node: FlowStepMsg, input: FlowSectionInput) {
  const { rid, businessId, type } = node.identity;
  return {
    'data-rid': rid,
    role: 'button',
    tabindex: '0',
    title: `${type} · ${businessId || rid}\n${FLOW_COPY_HINT}`,
    onClick: (e: MouseEvent) => {
      if ((e.target as HTMLElement).closest('.bdg')) return; // badge owns its copy click
      activateNode(e.currentTarget as HTMLElement, node, input, getModifier(e));
    },
    onKeydown: (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activateNode(e.currentTarget as HTMLElement, node, input, 'plain');
      }
    },
  };
}

/** Click/activate a group row. Mirrors the in-page overlay's gesture so the
 *  sidebar's explore behaviour is consistent: a plain click is the
 *  configurator's "I want this object" — copy its business id AND drill in;
 *  a modifier-click copies a variant (Alt → RID, Shift → template, Ctrl → ref)
 *  without navigating. See src/lib/namespace.ts (resolveCopyText). */
function activateNode(head: HTMLElement, node: FlowStepMsg, input: FlowSectionInput, mod: CopyModifier): void {
  const { rid, businessId, type } = node.identity;
  if (mod === 'plain') {
    if (businessId) { copyToClipboard(businessId); flashCopied(head, 'Copied ID'); }
    input.onNavigate(rid);
    return;
  }
  const { text, label } = resolveCopyText({ rid, businessId, type }, mod);
  if (text) { copyToClipboard(text); flashCopied(head, `Copied ${label}`); }
  else flashCopied(head, label); // e.g. "No template"
}

/** Optional-chained so it's a no-op when the clipboard is unavailable (the
 *  visible flash is best-effort feedback, never a hard dependency). */
function copyToClipboard(text: string): void {
  navigator.clipboard?.writeText(text).catch(() => { /* blocked — silent */ });
}

/** Briefly swap the node's name to a confirmation so the copy is visible. */
function flashCopied(head: HTMLElement, message: string): void {
  const nameEl = head.querySelector<HTMLElement>('.flow-group-name, .flow-row-id');
  if (!nameEl) return;
  const original = nameEl.textContent;
  nameEl.textContent = message;
  head.classList.add('flow-flash-ok');
  setTimeout(() => {
    nameEl.textContent = original;
    head.classList.remove('flow-flash-ok');
  }, 700);
}

function icon(svgStr: string, cls: string): HTMLElement {
  return h('span', { class: `flow-ic ${cls}` }, svg(svgStr));
}

/** Key binding + code fields for a node, or null when it has neither. */
function renderFields(node: FlowStepMsg, input: FlowSectionInput): HTMLElement | null {
  const codes = node.codeFields ?? [];
  if (!node.inputKey && codes.length === 0) return null;

  const b = h('div', { class: 'flow-fields' });
  if (node.inputKey) {
    b.appendChild(h('div', { class: 'flow-line flow-keyline' },
      icon(ICON_KEY, 'flow-ic--key'),
      h('span', { class: 'flow-key-val mono', title: node.inputKey }, node.inputKey),
    ));
  }
  for (const cf of codes) {
    b.appendChild(renderCodeField(
      cf,
      node.identity.rid,
      input.sendMessage,
      input.inactiveCodeFields?.[cf.prop],
    ));
  }
  return b;
}

function renderCodeField(
  cf: FlowCodeFieldMsg,
  rid: string,
  sendMessage: SendFn,
  inactiveReason?: string,
): HTMLElement {
  // Gate state: when the EC is gated by a boolean toggle (useShowExpression /
  // useEnableExpression) and that toggle is currently false, the EC won't run.
  // Dim it and spell out which toggle is off — the user still sees the EC and
  // why it's dormant.
  const gated = cf.gateProp != null && cf.gateValue !== 'true';
  const empty = cf.firstLine === '';
  const inactive = gated || inactiveReason != null;
  const wrap = h('div', { class: `flow-cf${inactive ? ' flow-cf--off' : ''}` });

  wrap.appendChild(h('div', { class: 'flow-line flow-cf-head', onClick: (e: Event) => e.stopPropagation() },
    icon(propIcon(cf.prop), 'flow-ic--code'),
    h('span', { class: 'flow-cf-tx mono' },
      h('span', { class: 'flow-cf-prop', title: cf.prop }, cf.prop),
      h('span', { class: 'flow-cf-lines' }, empty ? ' · not set' : ` · ${cf.lineCount} ${cf.lineCount === 1 ? 'line' : 'lines'}`),
    ),
    h('button', {
      class: 'btn btn-small btn-ghost flow-cf-edit',
      onClick: (e: Event) => {
        e.stopPropagation();
        // Indirect EC fields (ActionButton.showExpression → ExtendedExpression
        // .expression) redirect Edit to the target object. Without this the
        // editor opens the source's same-named Reference handle, falls back to
        // that object's `expression`, and silently edits the wrong field.
        const editRid = cf.targetRid ?? rid;
        const editProp = cf.targetProp ?? cf.prop;
        sendMessage({ type: 'OPEN_EDITOR', rid: editRid, property: editProp });
      },
    }, empty ? 'Create ↗' : 'Edit ↗'),
  ));

  const sub = h('div', { class: 'flow-cf-sub' });
  sub.appendChild(
    cf.firstLine
      ? ecPreviewSpan(cf.firstLine, 'flow-cf-prev mono')
      : h('div', { class: 'flow-cf-prev mono flow-cf-prev--empty' }, '(empty first line)'),
  );
  if (gated) {
    sub.appendChild(h('div', { class: 'flow-cf-gate' }, `Off: ${cf.gateProp} = ${cf.gateValue || 'false'}`));
  } else if (inactiveReason) {
    sub.appendChild(h('div', { class: 'flow-cf-gate' }, inactiveReason));
  }
  if (cf.reads && cf.reads.length > 0) {
    sub.appendChild(h('div', { class: 'flow-cf-reads' },
      h('span', { class: 'flow-cf-reads-label' }, 'reads · '),
      // No `title`: the source-row flash on hover IS the visible response; a
      // native tooltip would just add redundant noise.
      ...cf.reads.map(r => h('span', { class: 'flow-reads-chip', 'data-source-rid': r.sourceRid }, r.key)),
    ));
  }
  wrap.appendChild(sub);
  return wrap;
}

function flashSourceRow(container: HTMLElement, sourceRid: string, on: boolean): void {
  const head = container.querySelector<HTMLElement>(`[data-rid="${cssEscape(sourceRid)}"]`);
  // A reads-source renders as a ledger step in the dominant shape, but guard
  // the collapsed-container case (a `.flow-group` row also carries data-rid)
  // so we flash that row, not the whole root.
  const target = head?.closest<HTMLElement>('.flow-step, .flow-group') ?? head?.closest<HTMLElement>('.flow-root') ?? head;
  if (target) target.classList.toggle('flow-flash', on);
}

function cssEscape(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, c => `\\${c}`);
}
