/**
 * Flow walker — visualizes the execution graph for the flow-bearing types
 * (see FLOW_TYPES): InputView / InputSet, ActionButton / transport groups,
 * Label, and the Add-object pages (EditPage / CreateObjectView).
 *
 * Layout: the chain's single-child spine collapses into a header (the widget,
 * keeping its type pill) plus light "container" context lines (InputSet /
 * NotificationTransportGroup); the leaves render as cards. Every field line is
 * icon-led — a leading glyph then content, no gutter labels:
 *   • the input *.key binding → a white key glyph + the mono identifier
 *   • each code property → a *semantic* glyph encoding the trigger
 *     (expression→lightning, initExpression→arrow-in, afterExpression→arrow-out,
 *     showExpression→eye-slash, enableExpression→subtitles-slash,
 *     defaultExpression→code-block), then the prop name + line count, a
 *     syntax-highlighted first-line preview on the EC surface, the runtime-gate
 *     note when the EC is dormant, and `reads` chips that flash their source
 *     row on hover. The colour + EC background already say "this is code", so
 *     the glyph is free to encode *when* it runs.
 */

import { h, svg } from '../../lib/dom';
import { getTypeColor, getTypeAbbr } from '../../lib/types';
import { ecPreviewSpan } from '../../lib/ec-format';
import {
  ICON_KEY, ICON_CODE, ICON_LIGHTNING, ICON_ARROW_SQUARE_IN, ICON_ARROW_OUT,
  ICON_EYE_SLASH, ICON_SUBTITLES_SLASH, ICON_CODE_BLOCK,
} from '../../lib/icons';
import type { FlowChainMsg, FlowStepMsg, FlowCodeFieldMsg, InspectorMessage } from '../../lib/types';

type SendFn = (msg: InspectorMessage) => void;

export interface FlowSectionInput {
  chain: FlowChainMsg | null;
  loading: boolean;
  error?: string | null;
  onNavigate: (rid: string) => void;
  sendMessage: SendFn;
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
};

function propIcon(prop: string): string {
  return PROP_ICON[prop] ?? ICON_CODE;
}

export function renderFlowSection(input: FlowSectionInput): HTMLElement {
  const body = input.loading
    ? h('div', { class: 'flow-loading' }, 'Loading flow…')
    : input.error
      ? h('div', { class: 'flow-error' }, input.error)
      : input.chain && input.chain.steps.length > 0
        ? renderChain(input.chain, input)
        : h('div', { class: 'flow-empty' },
            'This widget has no Flow chain. ',
            'Flow appears for InputView / InputSet, ActionButton, Label, and Add-object pages ',
            '(EditPage / CreateObjectView) that bind to code. Once any of those exist, their cascade shows here.',
          );

  const summary = input.chain ? summarizeChain(input.chain) : '';
  return h('div', { class: 'flow-section' },
    h('div', { class: 'flow-section-head' },
      h('span', { class: 'flow-section-label' }, 'Flow'),
      summary ? h('span', { class: 'flow-section-meta' }, summary) : null,
    ),
    body,
  );
}

function summarizeChain(chain: FlowChainMsg): string {
  let cards = 0;
  let withEc = 0;
  const walk = (step: FlowStepMsg) => {
    cards++;
    if (step.codeFields && step.codeFields.length > 0) withEc++;
    for (const c of step.children ?? []) walk(c);
  };
  for (const s of chain.steps) walk(s);
  if (cards === 0) return '';
  const parts = [`${cards} step${cards === 1 ? '' : 's'}`];
  if (withEc > 0) parts.push(`${withEc} with EC`);
  return parts.join(' · ');
}

function renderChain(chain: FlowChainMsg, input: FlowSectionInput): HTMLElement {
  const container = h('div', { class: 'flow-chain' });
  for (const step of chain.steps) {
    container.appendChild(renderTopStep(step, input));
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

function renderTopStep(step: FlowStepMsg, input: FlowSectionInput): HTMLElement {
  const { root, containers, leaves } = spine(step);
  const frag = h('div', { class: 'flow-root' });

  frag.appendChild(renderNavHead('flow-root-head', root, input));
  if (root.hint) frag.appendChild(h('div', { class: 'flow-hint' }, root.hint));
  const rootBody = renderFields(root, input);
  if (rootBody) frag.appendChild(rootBody);

  for (const c of containers) {
    frag.appendChild(renderGroup(c, input));
    if (c.hint) frag.appendChild(h('div', { class: 'flow-hint' }, c.hint));
    const cBody = renderFields(c, input);
    if (cBody) frag.appendChild(cBody);
  }

  for (const leaf of leaves) frag.appendChild(renderLeaf(leaf, input));
  return frag;
}

/** Light "container" context line (InputSet / NotificationTransportGroup):
 *  an outline pill + name, navigable but visually quiet. */
function renderGroup(node: FlowStepMsg, input: FlowSectionInput): HTMLElement {
  return h('div', { class: 'flow-group', ...navAttrs(node, input) },
    pill(node, 'flow-pill--out'),
    h('span', { class: 'flow-group-name' }, node.identity.name || '(unnamed)'),
  );
}

function renderLeaf(leaf: FlowStepMsg, input: FlowSectionInput): HTMLElement {
  const card = h('div', { class: 'flow-card' });
  card.appendChild(renderNavHead('flow-card-head', leaf, input));
  if (leaf.hint) card.appendChild(h('div', { class: 'flow-hint' }, leaf.hint));
  const body = renderFields(leaf, input);
  if (body) card.appendChild(body);
  // Rare: a leaf that itself branches (nested input sets). Recurse so no node
  // is dropped; the indent makes the extra depth legible.
  if (leaf.children && leaf.children.length > 0) {
    const sub = h('div', { class: 'flow-subcards' });
    for (const child of leaf.children) sub.appendChild(renderLeaf(child, input));
    card.appendChild(sub);
  }
  return card;
}

function navAttrs(node: FlowStepMsg, input: FlowSectionInput) {
  return {
    'data-rid': node.identity.rid,
    role: 'button',
    tabindex: '0',
    title: `${node.identity.type} · ${node.identity.businessId || node.identity.rid}`,
    onClick: () => input.onNavigate(node.identity.rid),
    onKeydown: (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.onNavigate(node.identity.rid); }
    },
  };
}

function renderNavHead(cls: string, node: FlowStepMsg, input: FlowSectionInput): HTMLElement {
  return h('div', { class: `${cls} flow-nav`, ...navAttrs(node, input) },
    pill(node),
    h('span', { class: 'flow-name' }, node.identity.name || '(unnamed)'),
  );
}

function pill(node: FlowStepMsg, extra?: string): HTMLElement {
  return h('span', {
    class: `flow-pill${extra ? ' ' + extra : ''}`,
    style: `--tc:${getTypeColor(node.identity.type)}`,
  }, getTypeAbbr(node.identity.type));
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
    b.appendChild(renderCodeField(cf, node.identity.rid, input.sendMessage));
  }
  return b;
}

function renderCodeField(cf: FlowCodeFieldMsg, rid: string, sendMessage: SendFn): HTMLElement {
  // Gate state: when the EC is gated by a boolean toggle (useShowExpression /
  // useEnableExpression) and that toggle is currently false, the EC won't run.
  // Dim it and spell out which toggle is off — the user still sees the EC and
  // why it's dormant.
  const gated = cf.gateProp != null && cf.gateValue !== 'true';
  const wrap = h('div', { class: `flow-cf${gated ? ' flow-cf--off' : ''}` });

  wrap.appendChild(h('div', { class: 'flow-line flow-cf-head', onClick: (e: Event) => e.stopPropagation() },
    icon(propIcon(cf.prop), 'flow-ic--code'),
    h('span', { class: 'flow-cf-tx mono' },
      h('span', { class: 'flow-cf-prop', title: cf.prop }, cf.prop),
      h('span', { class: 'flow-cf-lines' }, ` · ${cf.lineCount} ${cf.lineCount === 1 ? 'line' : 'lines'}`),
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
    }, 'Edit ↗'),
  ));

  const sub = h('div', { class: 'flow-cf-sub' });
  sub.appendChild(
    cf.firstLine
      ? ecPreviewSpan(cf.firstLine, 'flow-cf-prev mono')
      : h('div', { class: 'flow-cf-prev mono flow-cf-prev--empty' }, '(empty first line)'),
  );
  if (gated) {
    sub.appendChild(h('div', { class: 'flow-cf-gate' }, `Off: ${cf.gateProp} = ${cf.gateValue || 'false'}`));
  }
  if (cf.reads && cf.reads.length > 0) {
    sub.appendChild(h('div', { class: 'flow-cf-reads' },
      h('span', { class: 'flow-cf-reads-label' }, 'reads '),
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
  // A reads-source renders as a leaf card in the dominant shape, but guard the
  // collapsed-container case (a `.flow-group` line also carries data-rid) so we
  // flash that line, not the whole root.
  const target = head?.closest<HTMLElement>('.flow-card, .flow-group') ?? head?.closest<HTMLElement>('.flow-root') ?? head;
  if (target) target.classList.toggle('flow-flash', on);
}

function cssEscape(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, c => `\\${c}`);
}
