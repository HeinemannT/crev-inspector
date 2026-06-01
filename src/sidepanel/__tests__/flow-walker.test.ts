/**
 * Renderer tests for the Flow walker — the chain-of-cards visualization.
 *
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi } from 'vitest';
import { renderFlowSection } from '../sections/flow-walker';
import type { FlowChainMsg, FlowStepMsg } from '../../lib/types';

function inputs(overrides: Partial<Parameters<typeof renderFlowSection>[0]> = {}) {
  return {
    chain: null,
    loading: false,
    error: null,
    onNavigate: vi.fn(),
    sendMessage: vi.fn(),
    ...overrides,
  } as Parameters<typeof renderFlowSection>[0];
}

function step(overrides: Partial<FlowStepMsg> = {}): FlowStepMsg {
  return {
    identity: { rid: '1', businessId: 'b1', name: 'Step', type: 'ButtonInput' },
    ...overrides,
  };
}

describe('renderFlowSection', () => {
  it('renders loading state when loading=true', () => {
    const el = renderFlowSection(inputs({ loading: true }));
    expect(el.querySelector('.flow-loading')).toBeTruthy();
  });

  it('renders error state when error is set', () => {
    const el = renderFlowSection(inputs({ error: 'bridge unreachable' }));
    const err = el.querySelector('.flow-error');
    expect(err).toBeTruthy();
    expect(err!.textContent).toBe('bridge unreachable');
  });

  it('renders "No flow data" when chain has no steps', () => {
    const el = renderFlowSection(inputs({ chain: { steps: [] } as FlowChainMsg }));
    expect(el.querySelector('.flow-empty')).toBeTruthy();
  });

  it('compact header surfaces step count + EC-bearing count', () => {
    // UX pass replaced the prop-group-title with an inline `flow-section-head`
    // (compact label + meta) so the section feels distinct without burning a
    // full title row. The summary text moved with it.
    const chain: FlowChainMsg = {
      steps: [
        step({
          identity: { rid: '1', businessId: 'iv', name: 'IV', type: 'InputView' },
          children: [
            step({ identity: { rid: '2', businessId: 'ti', name: 'TI', type: 'TextInput' } }),
            step({
              identity: { rid: '3', businessId: 'bi', name: 'BI', type: 'ButtonInput' },
              codeFields: [{ prop: 'expression', length: 10, lineCount: 1, firstLine: 'root.foo()' }],
            }),
          ],
        }),
      ],
    };
    const el = renderFlowSection(inputs({ chain }));
    const head = el.querySelector('.flow-section-head')!;
    expect(head).toBeTruthy();
    expect(head.textContent).toContain('Flow');
    expect(head.textContent).toContain('3 steps');
    expect(head.textContent).toContain('1 with EC');
  });

  it('renders one card per step with type chip + name', () => {
    const chain: FlowChainMsg = { steps: [step({
      identity: { rid: '7', businessId: 'ab_demo', name: 'Demo AB', type: 'ActionButton' },
    })] };
    const el = renderFlowSection(inputs({ chain }));
    const card = el.querySelector('.flow-card');
    expect(card).toBeTruthy();
    expect(card!.querySelector('.flow-card-name')!.textContent).toBe('Demo AB');
    expect(card!.querySelector('.flow-card-bid')!.textContent).toBe('ab_demo');
  });

  it('clicking a card calls onNavigate with the step rid', () => {
    const onNavigate = vi.fn();
    const chain: FlowChainMsg = { steps: [step({ identity: { rid: '42', businessId: 'b', name: 'N', type: 'ButtonInput' } })] };
    const el = renderFlowSection(inputs({ chain, onNavigate }));
    const card = el.querySelector<HTMLElement>('.flow-card');
    card!.click();
    expect(onNavigate).toHaveBeenCalledWith('42');
  });

  it('greyed gate state appears when gateValue is not "true"', () => {
    const chain: FlowChainMsg = { steps: [step({
      identity: { rid: '5', businessId: 'bi', name: 'BI', type: 'ButtonInput' },
      codeFields: [{
        prop: 'showExpression', length: 10, lineCount: 1, firstLine: 'this.isAdmin',
        gateProp: 'useShowExpression', gateValue: 'false',
      }],
    })] };
    const el = renderFlowSection(inputs({ chain }));
    const code = el.querySelector('.flow-code--disabled');
    expect(code).toBeTruthy();
    const gate = code!.querySelector('.flow-code-gate');
    expect(gate!.textContent).toContain('Off');
    expect(gate!.textContent).toContain('useShowExpression');
  });

  it('gated state is NOT applied when gateValue is "true"', () => {
    const chain: FlowChainMsg = { steps: [step({
      codeFields: [{
        prop: 'showExpression', length: 1, lineCount: 1, firstLine: 'x',
        gateProp: 'useShowExpression', gateValue: 'true',
      }],
    })] };
    const el = renderFlowSection(inputs({ chain }));
    expect(el.querySelector('.flow-code--disabled')).toBeNull();
  });

  it('Edit button on a code field dispatches OPEN_EDITOR', () => {
    const sendMessage = vi.fn();
    const chain: FlowChainMsg = { steps: [step({
      identity: { rid: '99', businessId: 'b', name: 'N', type: 'ButtonInput' },
      codeFields: [{ prop: 'expression', length: 1, lineCount: 1, firstLine: 'x' }],
    })] };
    const el = renderFlowSection(inputs({ chain, sendMessage }));
    const btn = el.querySelector<HTMLButtonElement>('.flow-code-edit');
    btn!.click();
    const open = sendMessage.mock.calls.map(c => c[0]).find(m => m.type === 'OPEN_EDITOR');
    expect(open).toEqual({ type: 'OPEN_EDITOR', rid: '99', property: 'expression' });
  });

  it('Edit on an indirect EC redirects to the target rid + target prop', () => {
    // Repro for the v0.17.x bug: ActionButton.showExpression is a Reference to
    // an ExtendedExpression. Before the fix, Edit dispatched with the AB's rid
    // + `showExpression` — the editor fetched only expression/html/javascript,
    // fell back to expression, and silently edited the wrong EC. The walker
    // now captures the ExtendedExpression's rid and the renderer must
    // redirect Edit to it.
    const sendMessage = vi.fn();
    const chain: FlowChainMsg = { steps: [step({
      identity: { rid: '7000', businessId: 'ab', name: 'AB', type: 'ActionButton' },
      codeFields: [{
        prop: 'showExpression', length: 5, lineCount: 1, firstLine: 'this.isAdmin',
        targetRid: '8123', targetProp: 'expression',
      }],
    })] };
    const el = renderFlowSection(inputs({ chain, sendMessage }));
    const btn = el.querySelector<HTMLButtonElement>('.flow-code-edit');
    btn!.click();
    const open = sendMessage.mock.calls.map(c => c[0]).find(m => m.type === 'OPEN_EDITOR');
    // Edit must target the ExtendedExpression at 8123 (.expression), NOT the
    // AB at 7000 (.showExpression).
    expect(open).toEqual({ type: 'OPEN_EDITOR', rid: '8123', property: 'expression' });
  });

  it('nests children under the parent without a relationship pill', () => {
    // The edge label/pill was removed — the indentation rail conveys nesting.
    // The child card still renders inside the parent's flow-children block.
    const chain: FlowChainMsg = { steps: [step({
      identity: { rid: '1', businessId: 'iv', name: 'IV', type: 'InputView' },
      children: [step({
        identity: { rid: '2', businessId: 'is', name: 'IS', type: 'InputSet' },
        edgeLabel: 'inputSet',
      })],
    })] };
    const el = renderFlowSection(inputs({ chain }));
    expect(el.querySelector('.flow-edge-label')).toBeNull();
    const childCard = el.querySelector('.flow-children .flow-card');
    expect(childCard).toBeTruthy();
    expect(childCard!.querySelector('.flow-card-name')!.textContent).toBe('IS');
  });

  it('renders the input key chip for *Input children', () => {
    const chain: FlowChainMsg = { steps: [step({
      identity: { rid: '1', businessId: 'ti', name: 'Title', type: 'TextInput' },
      inputKey: 'title',
    })] };
    const el = renderFlowSection(inputs({ chain }));
    const key = el.querySelector('.flow-card-key');
    expect(key!.textContent).toContain('title');
  });
});
