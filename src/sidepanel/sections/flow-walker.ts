/**
 * Flow walker — visualizes the execution graph for InputView / ActionButton /
 * Label. Each step is a card; arrows + edge labels connect them. Code-bearing
 * steps show a 1-line preview + [Edit] button. *Input.key values render as
 * small chips. Cross-reference matches (ButtonInput.afterExpression reading
 * sibling input keys) surface as `reads: key, key` chips that highlight the
 * source rows on hover.
 */

import { h } from '../../lib/dom';
import { getTypeColor, getTypeAbbr } from '../../lib/types';
import { ecPreviewSpan } from '../../lib/ec-format';
import type { FlowChainMsg, FlowStepMsg, FlowCodeFieldMsg, InspectorMessage } from '../../lib/types';

type SendFn = (msg: InspectorMessage) => void;

export interface FlowSectionInput {
  chain: FlowChainMsg | null;
  loading: boolean;
  error?: string | null;
  onNavigate: (rid: string) => void;
  sendMessage: SendFn;
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
            'Flow appears for InputView / InputSet / ActionButton / Label / Workflow objects ',
            'that bind to code. Once any of those exist, their cascade shows here.',
          );

  // Compact title — tiny pill at the top-left of the band, not a full row.
  // Frees vertical space; the band's left-border + tinted background carry
  // the "this is the Flow zone" affordance.
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
    container.appendChild(renderStep(step, input, /* depth */ 0));
  }
  // Wire cross-reference highlight delegation
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

function renderStep(step: FlowStepMsg, input: FlowSectionInput, depth: number): HTMLElement {
  const wrap = h('div', { class: `flow-step flow-step--depth-${Math.min(depth, 3)}` });

  // No relationship label/pill — the indentation rail already conveys
  // "flows into". (step.edgeLabel is still used for the chain summary.)

  // The step card itself
  const card = h('div', {
    class: 'flow-card',
    'data-rid': step.identity.rid,
    role: 'button',
    tabindex: '0',
    title: `${step.identity.type} · ${step.identity.businessId || step.identity.rid}`,
    onClick: () => input.onNavigate(step.identity.rid),
    onKeydown: (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.onNavigate(step.identity.rid); }
    },
  },
    h('div', { class: 'flow-card-head' },
      h('span', {
        class: 'flow-card-chip',
        style: `--type-color:${getTypeColor(step.identity.type)}`,
      }, getTypeAbbr(step.identity.type)),
      h('span', { class: 'flow-card-name' }, step.identity.name || '(unnamed)'),
      step.inputKey
        ? h('span', { class: 'flow-card-key', title: `key := '${step.inputKey}'` }, `key=${step.inputKey}`)
        : null,
      step.identity.businessId
        ? h('span', { class: 'flow-card-bid' }, step.identity.businessId)
        : null,
    ),
  );

  // Hint (e.g., "No action set")
  if (step.hint) {
    card.appendChild(h('div', { class: 'flow-card-hint' }, step.hint));
  }

  // Code fields with previews + Edit
  if (step.codeFields && step.codeFields.length > 0) {
    for (const cf of step.codeFields) {
      card.appendChild(renderCodeField(cf, step.identity.rid, input.sendMessage));
    }
  }

  wrap.appendChild(card);

  // Children (e.g., InputSet contents, Workflow EC leaves)
  if (step.children && step.children.length > 0) {
    const list = h('div', { class: 'flow-children' });
    for (const child of step.children) {
      list.appendChild(renderStep(child, input, depth + 1));
    }
    wrap.appendChild(list);
  }

  return wrap;
}

function renderCodeField(cf: FlowCodeFieldMsg, rid: string, sendMessage: SendFn): HTMLElement {
  // Gate state: when the EC is gated by a boolean toggle (useShowExpression /
  // useEnableExpression) and that toggle is currently false, the EC won't run.
  // Show the text dimmed with a one-line hint so the user sees both the EC
  // AND why it's inactive.
  const gated = cf.gateProp != null && cf.gateValue !== 'true';
  const classes = `flow-code${gated ? ' flow-code--disabled' : ''}`;
  return h('div', { class: classes, onClick: (e: Event) => e.stopPropagation() },
    h('div', { class: 'flow-code-head' },
      h('span', { class: 'flow-code-prop' }, cf.prop),
      h('span', { class: 'flow-code-meta' }, `${cf.lineCount} ${cf.lineCount === 1 ? 'line' : 'lines'}`),
      h('button', {
        class: 'btn btn-small btn-ghost flow-code-edit',
        onClick: (e: Event) => {
          e.stopPropagation();
          // Indirect EC fields (ActionButton.showExpression → ExtendedExpression
          // .expression) redirect Edit to the target object. Without this the
          // editor opens the source's same-named Reference handle, falls back
          // to that object's `expression`, and silently edits the wrong field.
          const editRid = cf.targetRid ?? rid;
          const editProp = cf.targetProp ?? cf.prop;
          sendMessage({ type: 'OPEN_EDITOR', rid: editRid, property: editProp });
        },
      }, 'Edit ↗'),
    ),
    cf.firstLine
      ? ecPreviewSpan(cf.firstLine, 'flow-code-preview mono')
      : h('div', { class: 'flow-code-preview mono flow-code-preview--empty' }, '(empty first line)'),
    gated
      ? h('div', { class: 'flow-code-gate' }, `Off: ${cf.gateProp} = ${cf.gateValue || 'false'}`)
      : null,
    cf.reads && cf.reads.length > 0
      ? h('div', { class: 'flow-reads' },
          h('span', { class: 'flow-reads-label' }, 'reads:'),
          ...cf.reads.map(r =>
            // No `title` here: the row-highlight that fires on hover
            // IS the visible response. A native title would paint
            // a redundant "Hover to highlight…" tooltip the moment
            // the cursor enters the chip — extra noise that doesn't
            // tell the reader anything the flash isn't already saying.
            h('span', {
              class: 'flow-reads-chip',
              'data-source-rid': r.sourceRid,
            }, r.key),
          ),
        )
      : null,
  );
}

function flashSourceRow(container: HTMLElement, sourceRid: string, on: boolean): void {
  const card = container.querySelector<HTMLElement>(`.flow-card[data-rid="${cssEscape(sourceRid)}"]`);
  if (card) card.classList.toggle('flow-card--highlight', on);
}

function cssEscape(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, c => `\\${c}`);
}
