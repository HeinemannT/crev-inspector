/**
 * Renderer tests for the Flow walker — the icon-led card visualization.
 *
 * The single-child spine collapses: a lone top step renders as a `.flow-root`
 * header (`.flow-root-head`), a single-child container (InputSet / NTG) renders
 * as a quiet `.flow-group` line, and the leaves render as `.flow-card`s.
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
    // The header counts the RAW tree (not the collapsed spine): all 3 nodes,
    // 1 of them with EC.
    const chain: FlowChainMsg = {
      steps: [
        step({
          identity: { rid: '1', businessId: 'iv', name: 'IV', type: 'InputView' },
          children: [
            step({ identity: { rid: '2', businessId: 'ti', name: 'TI', type: 'TextInput' } }),
            step({
              identity: { rid: '3', businessId: 'bi', name: 'BI', type: 'ButtonInput' },
              codeFields: [{ prop: 'expression', lineCount: 1, firstLine: 'root.foo()' }],
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

  it('renders a lone top step as the root header with type pill + name', () => {
    const chain: FlowChainMsg = { steps: [step({
      identity: { rid: '7', businessId: 'ab_demo', name: 'Demo AB', type: 'ActionButton' },
    })] };
    const el = renderFlowSection(inputs({ chain }));
    const head = el.querySelector('.flow-root-head');
    expect(head).toBeTruthy();
    expect(head!.querySelector('.flow-pill')).toBeTruthy();
    expect(head!.querySelector('.flow-name')!.textContent).toBe('Demo AB');
    // businessId now lives in the title tooltip, not a visible chip.
    expect(head!.getAttribute('title')).toContain('ab_demo');
  });

  it('plain-clicking the root head copies the business id AND navigates', () => {
    const onNavigate = vi.fn();
    const writes: string[] = [];
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText: (t: string) => { writes.push(t); return Promise.resolve(); } },
      configurable: true,
    });
    const chain: FlowChainMsg = { steps: [step({ identity: { rid: '42', businessId: 'bizId42', name: 'N', type: 'ButtonInput' } })] };
    const el = renderFlowSection(inputs({ chain, onNavigate }));
    const head = el.querySelector<HTMLElement>('.flow-root-head');
    head!.click();
    expect(onNavigate).toHaveBeenCalledWith('42');
    expect(writes).toContain('bizId42'); // plain click = copy ID + open
  });

  it('alt-clicking copies the RID instead and does NOT navigate', () => {
    const onNavigate = vi.fn();
    const writes: string[] = [];
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText: (t: string) => { writes.push(t); return Promise.resolve(); } },
      configurable: true,
    });
    const chain: FlowChainMsg = { steps: [step({ identity: { rid: '42', businessId: 'bizId42', name: 'N', type: 'ButtonInput' } })] };
    const el = renderFlowSection(inputs({ chain, onNavigate }));
    const head = el.querySelector<HTMLElement>('.flow-root-head')!;
    head.dispatchEvent(new MouseEvent('click', { altKey: true, bubbles: true }));
    expect(writes).toContain('42');       // Alt → RID
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('collapses a single-child InputSet into a quiet container line', () => {
    // InputView → InputSet (no inputs of its own): the spine collapses, so the
    // InputView is the root header and the InputSet is a `.flow-group` line —
    // not a nested card.
    const chain: FlowChainMsg = { steps: [step({
      identity: { rid: '1', businessId: 'iv', name: 'IV', type: 'InputView' },
      children: [step({
        identity: { rid: '2', businessId: 'is', name: 'IS', type: 'InputSet' },
        edgeLabel: 'inputSet',
      })],
    })] };
    const el = renderFlowSection(inputs({ chain }));
    expect(el.querySelector('.flow-root-head .flow-name')!.textContent).toBe('IV');
    const group = el.querySelector('.flow-group');
    expect(group).toBeTruthy();
    expect(group!.querySelector('.flow-group-name')!.textContent).toBe('IS');
    // No leaf cards in this degenerate chain.
    expect(el.querySelector('.flow-card')).toBeNull();
  });

  it('renders InputSet leaves as cards under the collapsed spine', () => {
    const chain: FlowChainMsg = { steps: [step({
      identity: { rid: '1', businessId: 'iv', name: 'IV', type: 'InputView' },
      children: [step({
        identity: { rid: '2', businessId: 'is', name: 'IS', type: 'InputSet' },
        children: [
          step({ identity: { rid: '3', businessId: 'ti', name: 'TI', type: 'TextInput' }, inputKey: 'title' }),
          step({
            identity: { rid: '4', businessId: 'bi', name: 'BI', type: 'ButtonInput' },
            codeFields: [{ prop: 'expression', lineCount: 1, firstLine: 'root.foo()' }],
          }),
        ],
      })],
    })] };
    const el = renderFlowSection(inputs({ chain }));
    // Root + container line.
    expect(el.querySelector('.flow-root-head .flow-name')!.textContent).toBe('IV');
    expect(el.querySelector('.flow-group-name')!.textContent).toBe('IS');
    // Two leaf cards.
    const cards = el.querySelectorAll('.flow-card');
    expect(cards.length).toBe(2);
    const names = [...cards].map(c => c.querySelector('.flow-name')!.textContent);
    expect(names).toEqual(['TI', 'BI']);
  });

  it('greyed gate state appears when gateValue is not "true"', () => {
    const chain: FlowChainMsg = { steps: [step({
      identity: { rid: '5', businessId: 'bi', name: 'BI', type: 'ButtonInput' },
      codeFields: [{
        prop: 'showExpression', lineCount: 1, firstLine: 'this.isAdmin',
        gateProp: 'useShowExpression', gateValue: 'false',
      }],
    })] };
    const el = renderFlowSection(inputs({ chain }));
    const code = el.querySelector('.flow-cf--off');
    expect(code).toBeTruthy();
    const gate = code!.querySelector('.flow-cf-gate');
    expect(gate!.textContent).toContain('Off');
    expect(gate!.textContent).toContain('useShowExpression');
  });

  it('gated state is NOT applied when gateValue is "true"', () => {
    const chain: FlowChainMsg = { steps: [step({
      codeFields: [{
        prop: 'showExpression', lineCount: 1, firstLine: 'x',
        gateProp: 'useShowExpression', gateValue: 'true',
      }],
    })] };
    const el = renderFlowSection(inputs({ chain }));
    expect(el.querySelector('.flow-cf--off')).toBeNull();
  });

  it('Edit button on a code field dispatches OPEN_EDITOR', () => {
    const sendMessage = vi.fn();
    const chain: FlowChainMsg = { steps: [step({
      identity: { rid: '99', businessId: 'b', name: 'N', type: 'ButtonInput' },
      codeFields: [{ prop: 'expression', lineCount: 1, firstLine: 'x' }],
    })] };
    const el = renderFlowSection(inputs({ chain, sendMessage }));
    const btn = el.querySelector<HTMLButtonElement>('.flow-cf-edit');
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
        prop: 'showExpression', lineCount: 1, firstLine: 'this.isAdmin',
        targetRid: '8123', targetProp: 'expression',
      }],
    })] };
    const el = renderFlowSection(inputs({ chain, sendMessage }));
    const btn = el.querySelector<HTMLButtonElement>('.flow-cf-edit');
    btn!.click();
    const open = sendMessage.mock.calls.map(c => c[0]).find(m => m.type === 'OPEN_EDITOR');
    // Edit must target the ExtendedExpression at 8123 (.expression), NOT the
    // AB at 7000 (.showExpression).
    expect(open).toEqual({ type: 'OPEN_EDITOR', rid: '8123', property: 'expression' });
  });

  it('renders the input key binding line for *Input nodes', () => {
    const chain: FlowChainMsg = { steps: [step({
      identity: { rid: '1', businessId: 'ti', name: 'Title', type: 'TextInput' },
      inputKey: 'title',
    })] };
    const el = renderFlowSection(inputs({ chain }));
    const key = el.querySelector('.flow-key-val');
    expect(key!.textContent).toContain('title');
  });

  it('renders a ButtonGroup leaf as a subtle group box with its buttons inside', () => {
    // InputSet has 2 children so the spine stops at it and the ButtonGroup
    // renders as a leaf (a lone ButtonGroup would collapse into the spine).
    const chain: FlowChainMsg = { steps: [step({
      identity: { rid: '1', businessId: 'iv', name: 'IV', type: 'InputView' },
      children: [step({
        identity: { rid: '2', businessId: 'is', name: 'IS', type: 'InputSet' },
        children: [
          step({
            identity: { rid: '3', businessId: 'grp', name: 'Button group', type: 'ButtonGroup' },
            children: [
              step({ identity: { rid: '4', businessId: 'b1', name: 'Btn1', type: 'ButtonInput' } }),
              step({ identity: { rid: '5', businessId: 'b2', name: 'Btn2', type: 'ButtonInput' } }),
            ],
          }),
          step({ identity: { rid: '6', businessId: 'x', name: 'Other', type: 'TextInput' } }),
        ],
      })],
    })] };
    const el = renderFlowSection(inputs({ chain }));
    const box = el.querySelector('.flow-groupbox')!;
    expect(box).toBeTruthy();
    expect(box.querySelector('.flow-grouplabel')!.textContent).toContain('Button group');
    expect(box.querySelectorAll('.flow-card').length).toBe(2); // the 2 buttons
  });

  it('renders a leaf with children as nested subcards (action graph)', () => {
    const chain: FlowChainMsg = { steps: [step({
      identity: { rid: '1', businessId: 'iv', name: 'IV', type: 'InputView' },
      children: [step({
        identity: { rid: '2', businessId: 'is', name: 'IS', type: 'InputSet' },
        children: [
          step({
            identity: { rid: '3', businessId: 'btn', name: 'Submit', type: 'ButtonInput' },
            children: [step({
              identity: { rid: '4', businessId: 'ntg', name: 'Action group', type: 'NotificationTransportGroup' },
              children: [step({
                identity: { rid: '5', businessId: 'xtr', name: 'Email', type: 'ExtendedTransport' },
                codeFields: [{ prop: 'expression', lineCount: 1, firstLine: 't.x()' }],
              })],
            })],
          }),
          step({ identity: { rid: '6', businessId: 'x', name: 'Other', type: 'TextInput' } }),
        ],
      })],
    })] };
    const el = renderFlowSection(inputs({ chain }));
    const subcards = el.querySelector('.flow-subcards')!;
    expect(subcards).toBeTruthy();
    // the NTG nests, and the transport nests under it (two levels of subcards)
    expect(el.querySelectorAll('.flow-subcards').length).toBe(2);
    expect(el.textContent).toContain('Action group');
    expect(el.textContent).toContain('Email');
  });

  it('renders reads chips carrying the source rid for hover-flash', () => {
    const chain: FlowChainMsg = { steps: [step({
      identity: { rid: '1', businessId: 'bi', name: 'BI', type: 'ButtonInput' },
      codeFields: [{
        prop: 'afterExpression', lineCount: 2, firstLine: 'root.score := l * i',
        reads: [{ key: 'likelihood', sourceRid: '55' }],
      }],
    })] };
    const el = renderFlowSection(inputs({ chain }));
    const chip = el.querySelector('.flow-reads-chip');
    expect(chip).toBeTruthy();
    expect(chip!.textContent).toContain('likelihood');
    expect(chip!.getAttribute('data-source-rid')).toBe('55');
  });
});
