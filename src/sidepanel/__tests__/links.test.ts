/**
 * Renderer + adapter tests for the unified Links section.
 *
 * @vitest-environment happy-dom
 */
import { describe, it, expect, vi } from 'vitest';
import {
  renderLinks, connectionsToLinks, referencesToLinks,
  type LinksModel, type LinkTarget,
} from '../sections/links';
import type { ConnGroup } from '../../lib/connections';

const tgt = (o: Partial<LinkTarget> = {}): LinkTarget => ({
  rid: '111', name: 'Monthly patching', type: 'CeControlMeasure', businessId: 'cecme.31', field: 'owner', ...o,
});

function render(links: LinksModel, onNavigate = vi.fn(), onScanInbound?: () => void) {
  const el = renderLinks({ links, onNavigate, onScanInbound });
  return { el, onNavigate, onScanInbound };
}

describe('connectionsToLinks', () => {
  it('splits groups into outgoing/incoming and drops unset edges', () => {
    const groups: ConnGroup[] = [
      { field: 'owner', label: 'owner', direction: 'out', targets: [{ rid: '1', name: 'A', type: 'User', businessId: 'u' }] },
      { field: 'org', label: 'org', direction: 'out', targets: [] }, // unset → dropped
      { field: 'risk_mitigations', label: 'mitigations', direction: 'in', targets: [{ rid: '2', name: 'W', type: 'CeWorkflow', businessId: 'w' }] },
    ];
    const { outgoing, incoming } = connectionsToLinks(groups);
    expect(outgoing.map(t => t.rid)).toEqual(['1']);
    expect(outgoing[0].field).toBe('owner');
    expect(incoming.map(t => t.rid)).toEqual(['2']);
  });

  it('carries the junction via through', () => {
    const groups: ConnGroup[] = [{
      field: 'm', label: 'm', direction: 'in',
      targets: [{ rid: '2', name: 'W', type: 'CeWorkflow', businessId: 'w', via: { rid: '3', name: 'C', type: 'CeControlMeasure', businessId: 'c' } }],
    }];
    expect(connectionsToLinks(groups).incoming[0].via!.rid).toBe('3');
  });
});

describe('referencesToLinks', () => {
  it('maps curated bindings, keeping unset ones as empty', () => {
    const links = referencesToLinks('CreateObjectView', {
      editPage: { rid: '1', businessId: 'ep', type: 'EditPage', name: 'EP' },
      destination: null,
      defaultObject: null,
    });
    expect(links.length).toBe(3);
    expect(links[0]).toMatchObject({ rid: '1', name: 'EP' });
    expect(links[0].empty).toBeUndefined();
    expect(links.filter(l => l.empty).length).toBe(2);
  });

  it('returns [] for a type with no reference metadata', () => {
    expect(referencesToLinks('TextElement', {})).toEqual([]);
  });
});

describe('renderLinks', () => {
  it('returns null with no links and no scan affordance', () => {
    expect(render({ outgoing: [], incoming: [] }).el).toBeNull();
  });

  it('renders as a plain prop-group (no card/rail/tint) with a "References" head', () => {
    const { el } = render({ outgoing: [tgt()], incoming: [] });
    expect(el!.classList.contains('prop-group')).toBe(true);
    expect(el!.classList.contains('lk-section')).toBe(true);
    expect(el!.querySelector('.lk-head .lk-head-label')!.textContent).toBe('References');
  });

  it('renders an outgoing link name-first with a direction icon and the field as a caption', () => {
    const { el, onNavigate } = render({ outgoing: [tgt({ name: 'Anna', field: 'owner' })], incoming: [] });
    const row = el!.querySelector<HTMLElement>('.lk-row')!;
    expect(row.querySelector('.lk-name')!.textContent).toBe('Anna');
    expect(row.querySelector('.lk-field')!.textContent).toBe('owner');
    const dir = row.querySelector('.lk-dir')!;
    expect(dir.classList.contains('lk-dir--out')).toBe(true);
    expect(dir.querySelector('svg')).toBeTruthy();
    expect(row.querySelector('.lk-dir')!.classList.contains('lk-dir--out')).toBe(true);
    row.click();
    expect(onNavigate).toHaveBeenCalledWith('111');
  });

  it('marks incoming links with the in-direction icon and a divider, no sub-headers', () => {
    const { el } = render({
      outgoing: [tgt({ rid: 'o' })],
      incoming: [tgt({ rid: 'i', name: 'Workflow', type: 'CeWorkflow', field: 'mitigates' })],
    });
    expect(el!.querySelector('.lk-sub')).toBeNull();
    expect(el!.querySelector('.lk-divider')).toBeTruthy();
    const dirs = [...el!.querySelectorAll('.lk-dir')];
    expect(dirs.map(d => d.className)).toEqual(['lk-dir lk-dir--out', 'lk-dir lk-dir--in']);
    expect(dirs.every(d => d.querySelector('svg'))).toBe(true);
    expect(el!.querySelectorAll('.lk-row').length).toBe(2);
  });

  it('filters unset curated bindings out entirely — no "(none)" rows, null when nothing else', () => {
    // Only an unset binding → nothing to show, section is omitted.
    expect(render({ outgoing: [tgt({ empty: true, rid: '', field: 'data set' })], incoming: [] }).el).toBeNull();
    // Mixed with a real link → only the real link renders.
    const { el } = render({ outgoing: [tgt(), tgt({ empty: true, rid: '', field: 'data set' })], incoming: [] });
    expect(el!.querySelectorAll('.lk-row').length).toBe(1);
    expect(el!.textContent).not.toContain('(none)');
    expect(el!.textContent).not.toContain('data set');
  });

  it('a broken target shows a warning icon and is not a navigation button', () => {
    const { el, onNavigate } = render({ outgoing: [tgt({ broken: true, rid: '999' })], incoming: [] });
    const broken = el!.querySelector<HTMLElement>('.lk-row--broken')!;
    expect(broken.querySelector('.lk-broken svg')).not.toBeNull();
    expect(broken.textContent).toContain('999');
    broken.click();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it('inlines a junction far side as an indented clickable sub-row', () => {
    const onNavigate = vi.fn();
    const { el } = render({
      outgoing: [],
      incoming: [tgt({ rid: 'wf1', name: 'Patch SMB', type: 'CeWorkflow', field: 'mitigates', via: { rid: 'ctl1', name: 'Monthly patching', type: 'CeControlMeasure', businessId: 'c' } })],
    }, onNavigate);
    const via = el!.querySelector<HTMLElement>('.lk-row--via')!;
    expect(via.querySelector('.lk-via-arrow')!.textContent).toBe('↳');
    expect(via.querySelector('.lk-name')!.textContent).toBe('Monthly patching');
    via.click();
    expect(onNavigate).toHaveBeenCalledWith('ctl1');
    expect(onNavigate).not.toHaveBeenCalledWith('wf1');
  });

  it('offers a scan icon button in the head when inbound is provided with a handler', () => {
    const onScan = vi.fn();
    const { el } = render({ outgoing: [tgt()], incoming: [], inbound: { loaded: false, targets: [] } }, vi.fn(), onScan);
    const btn = el!.querySelector<HTMLButtonElement>('.lk-head button.lk-scan-ic')!;
    expect(btn.title).toBe('Scan for referrers (rref)');
    btn.click();
    expect(onScan).toHaveBeenCalled();
    // The old bottom "Scan all referrers" button is gone.
    expect(el!.querySelector('.lk-scan-btn')).toBeNull();
  });

  it('scan icon is busy (no re-trigger) while scanning, and a "scanning…" note shows', () => {
    const onScan = vi.fn();
    const { el } = render({ outgoing: [tgt()], incoming: [], inbound: { loaded: false, scanning: true, targets: [] } }, vi.fn(), onScan);
    const btn = el!.querySelector<HTMLButtonElement>('button.lk-scan-ic')!;
    expect(btn.classList.contains('lk-scan-ic--busy')).toBe(true);
    btn.click();
    expect(onScan).not.toHaveBeenCalled();
    expect(el!.querySelector('.lk-note')!.textContent).toBe('scanning…');
  });

  it('renders scanned referrers as from-rows (distinct from declared reverse) + a cap note', () => {
    const { el } = render({
      outgoing: [],
      incoming: [],
      inbound: { loaded: true, capped: true, targets: [{ rid: 'x', name: 'Issue', type: 'CeIssue', businessId: 'i' }] },
    });
    const dir = el!.querySelector('.lk-dir')!;
    expect(dir.classList.contains('lk-dir--from')).toBe(true);
    expect(dir.querySelector('svg')).toBeTruthy();
    expect(dir.classList.contains('lk-dir--from')).toBe(true);
    expect(el!.querySelector('.lk-name')!.textContent).toBe('Issue');
    expect(el!.querySelector('.lk-note')!.textContent).toContain('first 100');
  });

  it('distinguishes a declared reverse (in) from a scanned referrer (from) in the same section', () => {
    const { el } = render({
      outgoing: [],
      incoming: [tgt({ rid: 'rev', name: 'Workflow', type: 'CeWorkflow', field: 'mitigates' })],
      inbound: { loaded: true, targets: [{ rid: 'ref', name: 'Issue', type: 'CeIssue', businessId: 'i' }] },
    });
    const dirs = [...el!.querySelectorAll('.lk-dir')];
    expect(dirs.map(d => d.className)).toEqual(['lk-dir lk-dir--in', 'lk-dir lk-dir--from']);
  });

  it('meta reads "out · in" when there are incoming links', () => {
    const { el } = render({ outgoing: [tgt({ rid: 'o' })], incoming: [tgt({ rid: 'i' })] });
    expect(el!.querySelector('.lk-head-meta')!.textContent).toBe('1 out · 1 in');
  });

  it('meta counts only real outgoing links ("N link(s)"), ignoring unset bindings', () => {
    const one = render({ outgoing: [tgt({ rid: '1' }), tgt({ empty: true, rid: '', field: 'x' })], incoming: [] });
    expect(one.el!.querySelector('.lk-head-meta')!.textContent).toBe('1 link');
    const two = render({ outgoing: [tgt({ rid: '1' }), tgt({ rid: '2' })], incoming: [] });
    expect(two.el!.querySelector('.lk-head-meta')!.textContent).toBe('2 links');
  });
});
