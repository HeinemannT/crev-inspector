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

  it('renders as a plain prop-group (no card/rail/tint) titled LINKS', () => {
    const { el } = render({ outgoing: [tgt()], incoming: [] });
    expect(el!.classList.contains('prop-group')).toBe(true);
    expect(el!.classList.contains('lk-section')).toBe(true);
    expect(el!.querySelector('.prop-group-title-text')!.textContent).toBe('Links');
  });

  it('renders an outgoing link name-first with a → glyph and the field as a caption', () => {
    const { el, onNavigate } = render({ outgoing: [tgt({ name: 'Anna', field: 'owner' })], incoming: [] });
    const row = el!.querySelector<HTMLElement>('.lk-row')!;
    expect(row.querySelector('.lk-name')!.textContent).toBe('Anna');
    expect(row.querySelector('.lk-field')!.textContent).toBe('owner');
    expect(row.querySelector('.lk-dir')!.textContent).toBe('→');
    expect(row.querySelector('.lk-dir')!.classList.contains('lk-dir--out')).toBe(true);
    row.click();
    expect(onNavigate).toHaveBeenCalledWith('111');
  });

  it('marks incoming links with a ↰ glyph and a divider, no sub-headers', () => {
    const { el } = render({
      outgoing: [tgt({ rid: 'o' })],
      incoming: [tgt({ rid: 'i', name: 'Workflow', type: 'CeWorkflow', field: 'mitigates' })],
    });
    expect(el!.querySelector('.lk-sub')).toBeNull();
    expect(el!.querySelector('.lk-divider')).toBeTruthy();
    const dirs = [...el!.querySelectorAll('.lk-dir')].map(d => d.textContent);
    expect(dirs).toEqual(['→', '↰']);
    expect(el!.querySelectorAll('.lk-row').length).toBe(2);
  });

  it('shows an unset curated binding as a dim "(none)" with no navigation', () => {
    const { el, onNavigate } = render({ outgoing: [tgt({ empty: true, rid: '', field: 'data set' })], incoming: [] });
    const empty = el!.querySelector<HTMLElement>('.lk-row--empty')!;
    expect(empty.textContent).toContain('data set');
    expect(empty.textContent).toContain('(none)');
    empty.click();
    expect(onNavigate).not.toHaveBeenCalled();
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

  it('offers a real "Scan all referrers" button when inbound not loaded', () => {
    const onScan = vi.fn();
    const { el } = render({ outgoing: [tgt()], incoming: [], inbound: { loaded: false, targets: [] } }, vi.fn(), onScan);
    const btn = el!.querySelector<HTMLButtonElement>('button.lk-scan-btn')!;
    expect(btn.textContent).toBe('Scan all referrers');
    btn.click();
    expect(onScan).toHaveBeenCalled();
  });

  it('renders scanned referrers as ← rows (distinct from declared reverse ↰) + a cap note', () => {
    const { el } = render({
      outgoing: [],
      incoming: [],
      inbound: { loaded: true, capped: true, targets: [{ rid: 'x', name: 'Issue', type: 'CeIssue', businessId: 'i' }] },
    });
    const dir = el!.querySelector('.lk-dir')!;
    expect(dir.textContent).toBe('←');
    expect(dir.classList.contains('lk-dir--from')).toBe(true);
    expect(el!.querySelector('.lk-name')!.textContent).toBe('Issue');
    expect(el!.querySelector('.lk-note')!.textContent).toContain('first 100');
  });

  it('distinguishes a declared reverse (↰) from a scanned referrer (←) in the same section', () => {
    const { el } = render({
      outgoing: [],
      incoming: [tgt({ rid: 'rev', name: 'Workflow', type: 'CeWorkflow', field: 'mitigates' })],
      inbound: { loaded: true, targets: [{ rid: 'ref', name: 'Issue', type: 'CeIssue', businessId: 'i' }] },
    });
    const dirs = [...el!.querySelectorAll('.lk-dir')].map(d => d.textContent);
    expect(dirs).toEqual(['↰', '←']);
  });

  it('meta reads "out · in" when there are incoming links', () => {
    const { el } = render({ outgoing: [tgt({ rid: 'o' })], incoming: [tgt({ rid: 'i' })] });
    expect(el!.querySelector('.prop-group-title-meta')!.textContent).toBe('1 out · 1 in');
  });

  it('meta reads "N/M set" for curated bindings with unset slots', () => {
    const { el } = render({ outgoing: [tgt({ rid: '1' }), tgt({ empty: true, rid: '', field: 'x' })], incoming: [] });
    expect(el!.querySelector('.prop-group-title-meta')!.textContent).toBe('1/2 set');
  });
});
