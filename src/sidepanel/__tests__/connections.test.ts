/**
 * Renderer tests for the Connections "map card".
 *
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi } from 'vitest';
import { renderConnections, type Connections, type ConnTarget } from '../sections/connections';

const tgt = (o: Partial<ConnTarget> = {}): ConnTarget => ({
  rid: '111', name: 'Monthly patching', type: 'CeControlMeasure', businessId: 'cecme.31', ...o,
});

function render(conn: Connections, onNavigate = vi.fn(), onScanInbound?: () => void) {
  const el = renderConnections({ connections: conn, onNavigate, onScanInbound });
  return { el, onNavigate, onScanInbound };
}

describe('renderConnections', () => {
  it('returns null when there are no groups and no inbound affordance', () => {
    const { el } = render({ groups: [] });
    expect(el).toBeNull();
  });

  it('renders the card with a "Relationships" heading', () => {
    const { el } = render({
      groups: [{ field: 'owner', label: 'owner', direction: 'out', targets: [tgt()] }],
    });
    expect(el!.classList.contains('conn-card')).toBe(true);
    expect(el!.querySelector('.conn-card-title')!.textContent).toBe('Relationships');
  });

  it('renders a forward (out) edge as a clickable target that navigates', () => {
    const { el, onNavigate } = render({
      groups: [{ field: 'mitigating_control', label: 'mitigating control', direction: 'out', targets: [tgt()] }],
    });
    const edge = el!.querySelector<HTMLElement>('.conn-edge')!;
    expect(edge.querySelector('.conn-edge-name')!.textContent).toBe('Monthly patching');
    expect(edge.querySelector('.conn-edge-label')!.textContent).toBe('mitigating control');
    expect(edge.querySelector('.conn-edge-dir')!.textContent).toBe('→');
    edge.click();
    expect(onNavigate).toHaveBeenCalledWith('111');
  });

  it('reverse (in) edges show a ← arrow', () => {
    const { el } = render({
      groups: [{ field: 'risk_mitigations', label: 'risk mitigations', direction: 'in', targets: [tgt({ type: 'CeWorkflow' })] }],
    });
    expect(el!.querySelector('.conn-edge-dir')!.textContent).toBe('←');
  });

  it('multi-value edges show one row per target, label only on the first', () => {
    const { el } = render({
      groups: [{ field: 'risk_mitigations', label: 'risk mitigations', direction: 'in', targets: [tgt({ rid: '1' }), tgt({ rid: '2' })] }],
    });
    const edges = el!.querySelectorAll('.conn-edge');
    expect(edges.length).toBe(2);
    expect(edges[0].querySelector('.conn-edge-label')!.textContent).toBe('risk mitigations');
    expect(edges[1].querySelector('.conn-edge-label')!.textContent).toBe('');
  });

  it('unset edges are hidden and summarised as "N unset"', () => {
    const { el, onNavigate } = render({
      groups: [
        { field: 'owner', label: 'owner', direction: 'out', targets: [tgt()] },
        { field: 'org', label: 'org', direction: 'out', targets: [] },
        { field: 'master', label: 'master', direction: 'out', targets: [] },
      ],
    });
    // only the one SET edge is rendered
    expect(el!.querySelectorAll('.conn-edge').length).toBe(1);
    expect(el!.querySelector('.conn-card-foot')!.textContent).toContain('2 unset');
    // nothing in the footer is a navigation target
    onNavigate.mockClear();
    el!.querySelector('.conn-card-foot')!.dispatchEvent(new Event('click'));
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('separates outgoing from incoming with a hairline rule', () => {
    const { el } = render({
      groups: [
        { field: 'owner', label: 'owner', direction: 'out', targets: [tgt({ rid: 'o1' })] },
        { field: 'risk_mitigations', label: 'risk mitigations', direction: 'in', targets: [tgt({ rid: 'i1', type: 'CeWorkflow' })] },
      ],
    });
    expect(el!.querySelector('.conn-card-rule')).toBeTruthy();
  });

  it('a broken target shows ⚠ and is not a navigation button', () => {
    const { el, onNavigate } = render({
      groups: [{ field: 'owner', label: 'owner', direction: 'out', targets: [tgt({ broken: true, rid: '999' })] }],
    });
    const broken = el!.querySelector<HTMLElement>('.conn-edge--broken')!;
    expect(broken.textContent).toContain('⚠');
    expect(broken.textContent).toContain('999');
    broken.click();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('inlines a junction far-side (via) as a separate clickable sub-row', () => {
    const onNavigate = vi.fn();
    const { el } = render({
      groups: [{ field: 'risk_mitigations', label: 'risk mitigations', direction: 'in', targets: [
        tgt({ rid: 'wf1', name: 'Patch SMB', type: 'CeWorkflow', via: tgt({ rid: 'ctl1', name: 'Monthly patching' }) }),
      ] }],
    }, onNavigate);
    const via = el!.querySelector<HTMLElement>('.conn-edge--via')!;
    expect(via.querySelector('.conn-via-arrow')!.textContent).toBe('→');
    expect(via.querySelector('.conn-edge-name')!.textContent).toBe('Monthly patching');
    // Clicking the via navigates to the far side, NOT the junction.
    via.click();
    expect(onNavigate).toHaveBeenCalledWith('ctl1');
    expect(onNavigate).not.toHaveBeenCalledWith('wf1');
  });

  it('inbound: offers a scan button in the footer when not loaded', () => {
    const onScan = vi.fn();
    const { el } = render({ groups: [], inbound: { loaded: false, targets: [] } }, vi.fn(), onScan);
    const btn = el!.querySelector<HTMLElement>('.conn-foot-scan')!;
    expect(btn.textContent).toContain('referenced by');
    btn.click();
    expect(onScan).toHaveBeenCalled();
  });

  it('inbound: shows results once loaded as incoming edges with a cap marker', () => {
    const { el } = render({
      groups: [],
      inbound: { loaded: true, capped: true, targets: [tgt({ rid: 'x' })] },
    });
    expect(el!.textContent).toContain('Monthly patching');
    expect(el!.querySelectorAll('.conn-edge').length).toBe(1);
    expect(el!.querySelector('.conn-card-foot')!.textContent).toContain('first 100 shown');
  });

  it('inbound: shows the scan affordance even with no outgoing edges', () => {
    const onScan = vi.fn();
    const { el } = render({ groups: [], inbound: { loaded: false, targets: [] } }, vi.fn(), onScan);
    expect(el!.querySelector('.conn-foot-scan')).toBeTruthy();
  });
});
