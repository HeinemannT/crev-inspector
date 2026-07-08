/**
 * Renderer tests for the Flow walker — the accordion "ledger" visualization.
 *
 * The single-child spine collapses: the root renders as a step ONLY when it
 * carries its own fields (its identity already heads the pane), single-child
 * containers (InputSet / NTG) render as quiet `.flow-group` rows that keep the
 * whole-row copy+navigate gesture, and the leaves render as `.flow-step`
 * accordion rows (header toggles open; the stub badge copies).
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

  it('renders no section header — the segment bar carries the label', () => {
    const chain: FlowChainMsg = { steps: [step({
      identity: { rid: '1', businessId: 'bi', name: 'BI', type: 'ButtonInput' },
      codeFields: [{ prop: 'expression', lineCount: 1, firstLine: 'root.foo()' }],
    })] };
    const el = renderFlowSection(inputs({ chain }));
    expect(el.classList.contains('flow-section')).toBe(true);
    expect(el.querySelector('.flow-section-head')).toBeNull();
    expect(el.querySelector('.flow-chain')).toBeTruthy();
  });

  it('omits a bare root step — the identity already heads the pane', () => {
    const chain: FlowChainMsg = { steps: [step({
      identity: { rid: '7', businessId: 'ab_demo', name: 'Demo AB', type: 'ActionButton' },
    })] };
    const el = renderFlowSection(inputs({ chain }));
    expect(el.querySelector('.flow-root')).toBeTruthy();
    expect(el.querySelector('.flow-step')).toBeNull();
    expect(el.querySelector('.flow-group')).toBeNull();
  });

  it('renders a root WITH own fields as an open accordion step (badge · name · grey id)', () => {
    const chain: FlowChainMsg = { steps: [step({
      identity: { rid: '7', businessId: 'ab_demo', name: 'Demo AB', type: 'ActionButton' },
      codeFields: [{ prop: 'expression', lineCount: 1, firstLine: 'root.foo()' }],
    })] };
    const el = renderFlowSection(inputs({ chain }));
    const stepEl = el.querySelector('.flow-step')!;
    expect(stepEl).toBeTruthy();
    expect(stepEl.classList.contains('flow-step--open')).toBe(true); // root always unfolds
    const head = stepEl.querySelector('.flow-step-h')!;
    expect(head.querySelector('.bdg')).toBeTruthy(); // shared stub badge, not a pill
    expect(head.querySelector('.flow-step-nm')!.textContent).toBe('Demo AB');
    expect(head.querySelector('.flow-row-id')!.textContent).toBe('ab_demo'); // inline grey mono id
    expect(head.querySelector('.flow-step-car')).toBeTruthy(); // chevron
  });

  it('clicking a step header toggles it open/closed without navigating', () => {
    const onNavigate = vi.fn();
    const chain: FlowChainMsg = { steps: [step({
      identity: { rid: '7', businessId: 'ab', name: 'AB', type: 'ActionButton' },
      codeFields: [{ prop: 'expression', lineCount: 1, firstLine: 'x' }],
    })] };
    const el = renderFlowSection(inputs({ chain, onNavigate }));
    const stepEl = el.querySelector<HTMLElement>('.flow-step')!;
    const head = stepEl.querySelector<HTMLElement>('.flow-step-h')!;
    expect(stepEl.classList.contains('flow-step--open')).toBe(true);
    head.click();
    expect(stepEl.classList.contains('flow-step--open')).toBe(false);
    head.click();
    expect(stepEl.classList.contains('flow-step--open')).toBe(true);
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('clicking the stub badge copies the business id without navigating or toggling', () => {
    const onNavigate = vi.fn();
    const writes: string[] = [];
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText: (t: string) => { writes.push(t); return Promise.resolve(); } },
      configurable: true,
    });
    const chain: FlowChainMsg = { steps: [step({
      identity: { rid: '42', businessId: 'bizId42', name: 'N', type: 'ButtonInput' },
      codeFields: [{ prop: 'expression', lineCount: 1, firstLine: 'x' }],
    })] };
    const el = renderFlowSection(inputs({ chain, onNavigate }));
    const stepEl = el.querySelector<HTMLElement>('.flow-step')!;
    const badge = stepEl.querySelector<HTMLElement>('.flow-step-h .bdg')!;
    badge.click();
    expect(writes).toContain('bizId42'); // plain click = copy business id
    expect(onNavigate).not.toHaveBeenCalled();
    expect(stepEl.classList.contains('flow-step--open')).toBe(true); // no toggle
  });

  it('alt-clicking the stub badge copies the RID instead and does NOT navigate', () => {
    const onNavigate = vi.fn();
    const writes: string[] = [];
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText: (t: string) => { writes.push(t); return Promise.resolve(); } },
      configurable: true,
    });
    const chain: FlowChainMsg = { steps: [step({
      identity: { rid: '42', businessId: 'bizId42', name: 'N', type: 'ButtonInput' },
      codeFields: [{ prop: 'expression', lineCount: 1, firstLine: 'x' }],
    })] };
    const el = renderFlowSection(inputs({ chain, onNavigate }));
    const badge = el.querySelector<HTMLElement>('.flow-step-h .bdg')!;
    badge.dispatchEvent(new MouseEvent('click', { altKey: true, bubbles: true }));
    expect(writes).toContain('42');       // Alt → RID
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('plain-clicking a container group row copies the business id AND navigates', () => {
    const onNavigate = vi.fn();
    const writes: string[] = [];
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText: (t: string) => { writes.push(t); return Promise.resolve(); } },
      configurable: true,
    });
    const chain: FlowChainMsg = { steps: [step({
      identity: { rid: '1', businessId: 'iv', name: 'IV', type: 'InputView' },
      children: [step({ identity: { rid: '42', businessId: 'bizId42', name: 'IS', type: 'InputSet' } })],
    })] };
    const el = renderFlowSection(inputs({ chain, onNavigate }));
    const group = el.querySelector<HTMLElement>('.flow-group')!;
    group.click();
    expect(onNavigate).toHaveBeenCalledWith('42');
    expect(writes).toContain('bizId42'); // plain click = copy ID + open
  });

  it('alt-clicking a container group row copies the RID instead and does NOT navigate', () => {
    const onNavigate = vi.fn();
    const writes: string[] = [];
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      value: { writeText: (t: string) => { writes.push(t); return Promise.resolve(); } },
      configurable: true,
    });
    const chain: FlowChainMsg = { steps: [step({
      identity: { rid: '1', businessId: 'iv', name: 'IV', type: 'InputView' },
      children: [step({ identity: { rid: '42', businessId: 'bizId42', name: 'IS', type: 'InputSet' } })],
    })] };
    const el = renderFlowSection(inputs({ chain, onNavigate }));
    const group = el.querySelector<HTMLElement>('.flow-group')!;
    group.dispatchEvent(new MouseEvent('click', { altKey: true, bubbles: true }));
    expect(writes).toContain('42');       // Alt → RID
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('collapses a single-child InputSet into a quiet container group row', () => {
    // InputView → InputSet (no inputs of its own): the spine collapses. The
    // fieldless root is omitted (its identity heads the pane) and the InputSet
    // is a `.flow-group` row — badge · name · grey id · open ↗.
    const chain: FlowChainMsg = { steps: [step({
      identity: { rid: '1', businessId: 'iv', name: 'IV', type: 'InputView' },
      children: [step({
        identity: { rid: '2', businessId: 'is', name: 'IS', type: 'InputSet' },
        edgeLabel: 'inputSet',
      })],
    })] };
    const el = renderFlowSection(inputs({ chain }));
    const group = el.querySelector('.flow-group');
    expect(group).toBeTruthy();
    expect(group!.querySelector('.bdg')).toBeTruthy();
    expect(group!.querySelector('.flow-group-name')!.textContent).toBe('IS');
    expect(group!.querySelector('.flow-row-id')!.textContent).toBe('is');
    // No accordion steps in this degenerate chain.
    expect(el.querySelector('.flow-step')).toBeNull();
  });

  it('renders InputSet leaves as accordion steps under the collapsed spine (≤2 auto-open)', () => {
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
    // Container group row (the fieldless root is omitted).
    expect(el.querySelector('.flow-group-name')!.textContent).toBe('IS');
    // Two leaf steps, auto-open because there are ≤2 of them.
    const steps = el.querySelectorAll('.flow-step');
    expect(steps.length).toBe(2);
    const names = [...steps].map(c => c.querySelector('.flow-step-nm')!.textContent);
    expect(names).toEqual(['TI', 'BI']);
    expect([...steps].every(s => s.classList.contains('flow-step--open'))).toBe(true);
  });

  it('starts leaves collapsed when the ledger is long (>2 leaves)', () => {
    const chain: FlowChainMsg = { steps: [step({
      identity: { rid: '1', businessId: 'iv', name: 'IV', type: 'InputView' },
      children: [step({
        identity: { rid: '2', businessId: 'is', name: 'IS', type: 'InputSet' },
        children: [
          step({ identity: { rid: '3', businessId: 'a', name: 'A', type: 'TextInput' }, inputKey: 'a' }),
          step({ identity: { rid: '4', businessId: 'b', name: 'B', type: 'TextInput' }, inputKey: 'b' }),
          step({ identity: { rid: '5', businessId: 'c', name: 'C', type: 'TextInput' }, inputKey: 'c' }),
        ],
      })],
    })] };
    const el = renderFlowSection(inputs({ chain }));
    const steps = el.querySelectorAll('.flow-step');
    expect(steps.length).toBe(3);
    expect(el.querySelector('.flow-step--open')).toBeNull();
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
    expect(box.querySelectorAll('.flow-step').length).toBe(2); // the 2 buttons
  });

  it('renders a leaf with children as nested substeps (action graph)', () => {
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
    const substeps = el.querySelector('.flow-substeps')!;
    expect(substeps).toBeTruthy();
    // the NTG nests, and the transport nests under it (two levels of substeps)
    expect(el.querySelectorAll('.flow-substeps').length).toBe(2);
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
