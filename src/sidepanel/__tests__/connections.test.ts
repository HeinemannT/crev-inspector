/**
 * Renderer tests for the Connections section.
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
  it('returns null when there are no groups and no inbound', () => {
    const { el } = render({ groups: [] });
    expect(el).toBeNull();
  });

  it('renders a forward (out) edge as a clickable target that navigates', () => {
    const { el, onNavigate } = render({
      groups: [{ field: 'mitigating_control', label: 'mitigating control', direction: 'out', targets: [tgt()] }],
    });
    const t = el!.querySelector<HTMLElement>('.conn-target')!;
    expect(t.textContent).toContain('Monthly patching');
    expect(t.textContent).toContain('cecme.31');
    expect(el!.querySelector('.conn-dir')!.textContent).toBe('→');
    t.click();
    expect(onNavigate).toHaveBeenCalledWith('111');
  });

  it('reverse (in) edges show a ← arrow', () => {
    const { el } = render({
      groups: [{ field: 'risk_mitigations', label: 'risk mitigations', direction: 'in', targets: [tgt({ type: 'CeWorkflow' })] }],
    });
    expect(el!.querySelector('.conn-dir')!.textContent).toBe('←');
  });

  it('multi-value edges show a count and one row per target', () => {
    const { el } = render({
      groups: [{ field: 'risk_mitigations', label: 'risk mitigations', direction: 'in', targets: [tgt({ rid: '1' }), tgt({ rid: '2' })] }],
    });
    expect(el!.querySelector('.conn-count')!.textContent).toBe('2');
    expect(el!.querySelectorAll('.conn-target').length).toBe(2);
  });

  it('an unset forward ref shows (none) and does not navigate', () => {
    const { el, onNavigate } = render({
      groups: [{ field: 'owner', label: 'owner', direction: 'out', targets: [] }],
    });
    const empty = el!.querySelector<HTMLElement>('.conn-row--empty')!;
    expect(empty.textContent).toContain('(none)');
    empty.click();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('an unset REQUIRED forward ref is flagged as a defect', () => {
    const { el } = render({
      groups: [{ field: 'mitigating_control', label: 'mitigating control', direction: 'out', required: true, targets: [] }],
    });
    const row = el!.querySelector('.conn-row--empty')!;
    expect(row.classList.contains('conn-row--flag')).toBe(true);
    expect(row.textContent).toContain('required, empty');
  });

  it('an empty reverse edge reads "(nothing)" not "(none)"', () => {
    const { el } = render({
      groups: [{ field: 'control_mitigations', label: 'control mitigations', direction: 'in', targets: [] }],
    });
    expect(el!.querySelector('.conn-row--empty')!.textContent).toContain('(nothing)');
  });

  it('a broken target shows ⚠ and is not a navigation button', () => {
    const { el, onNavigate } = render({
      groups: [{ field: 'owner', label: 'owner', direction: 'out', targets: [tgt({ broken: true, rid: '999' })] }],
    });
    const broken = el!.querySelector<HTMLElement>('.conn-target--broken')!;
    expect(broken.textContent).toContain('⚠');
    expect(broken.textContent).toContain('999');
    broken.click();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('renders navigability pips (·page / ⌀)', () => {
    const { el } = render({
      groups: [{ field: 'a', label: 'a', direction: 'out', targets: [
        tgt({ rid: '1', navigable: true }),
        tgt({ rid: '2', navigable: false }),
      ] }],
    });
    expect(el!.querySelector('.conn-nav--page')).toBeTruthy();
    expect(el!.querySelector('.conn-nav--nopage')).toBeTruthy();
  });

  it('inlines a junction far-side (via) as a separate clickable hop', () => {
    const onNavigate = vi.fn();
    const { el } = render({
      groups: [{ field: 'risk_mitigations', label: 'risk mitigations', direction: 'in', targets: [
        tgt({ rid: 'wf1', name: 'Patch SMB', type: 'CeWorkflow', via: tgt({ rid: 'ctl1', name: 'Monthly patching' }) }),
      ] }],
    }, onNavigate);
    const via = el!.querySelector<HTMLElement>('.conn-via')!;
    expect(via.textContent).toContain('Monthly patching');
    // Clicking the via navigates to the far side, NOT the junction.
    via.click();
    expect(onNavigate).toHaveBeenCalledWith('ctl1');
    expect(onNavigate).not.toHaveBeenCalledWith('wf1');
  });

  it('inbound: offers a scan button when not loaded', () => {
    const onScan = vi.fn();
    const { el } = render({ groups: [], inbound: { loaded: false, targets: [] } }, vi.fn(), onScan);
    const btn = el!.querySelector<HTMLElement>('.conn-scan')!;
    expect(btn.textContent).toContain('scan');
    btn.click();
    expect(onScan).toHaveBeenCalled();
  });

  it('inbound: shows results once loaded, with a cap marker', () => {
    const { el } = render({
      groups: [],
      inbound: { loaded: true, capped: true, targets: [tgt({ rid: 'x' })] },
    });
    expect(el!.querySelector('.conn-inbound, .conn-group')).toBeTruthy();
    expect(el!.textContent).toContain('referenced by');
    expect(el!.querySelector('.conn-count')!.textContent).toContain('+');
  });

  it('summary counts connected vs total groups', () => {
    const { el } = render({
      groups: [
        { field: 'a', label: 'a', direction: 'out', targets: [tgt()] },
        { field: 'b', label: 'b', direction: 'out', targets: [] },
      ],
    });
    expect(el!.querySelector('.prop-group-title-meta')!.textContent).toContain('1/2 connected');
  });
});
