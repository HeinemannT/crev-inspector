// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest';
import type { InspectorMessage } from '../../lib/types';
import { WorkshopLayoutPane } from '../tabs/workshop-layout-pane';

function mountedPane() {
  const sent: InspectorMessage[] = [];
  const pane = new WorkshopLayoutPane(msg => sent.push(msg), vi.fn());
  const state = pane as unknown as {
    contextRid: string;
    contextObj: { rid: string; type: string; name: string };
    layoutLoadingFor: string | null;
  };
  state.contextRid = '123';
  state.contextObj = { rid: '123', type: 'TabSet', name: 'Layout' };
  state.layoutLoadingFor = '123';
  const root = document.createElement('div');
  document.body.appendChild(root);
  return { pane, root, sent };
}

describe('Workshop layout fetch states', () => {
  it('batches missing widget and page identities into one request', () => {
    const sent: InspectorMessage[] = [];
    const pane = new WorkshopLayoutPane(msg => sent.push(msg), vi.fn());

    pane.handleMessage({
      type: 'PAGE_INFO',
      url: 'https://bmp.test/Steadfast/?rid=500&tabrid=600',
      rid: '500',
      tabRid: '600',
      widgets: [
        { rid: '700', name: '', type: '' },
        { rid: '800', name: '', type: '' },
      ],
      detection: { isBmp: true, confidence: 1, signals: [] },
    });

    const batches = sent.filter(message => message.type === 'SERVER_LOOKUP_BATCH');
    expect(batches).toEqual([{
      type: 'SERVER_LOOKUP_BATCH',
      rids: ['700', '800', '500', '600'],
    }]);
    expect(sent.some(message => message.type === 'SERVER_LOOKUP')).toBe(false);
  });

  it('surfaces a failed tree fetch and Retry starts a fresh request', () => {
    const { pane, root, sent } = mountedPane();
    expect(pane.handleMessage({
      type: 'LAYOUT_TREE_RESULT',
      rid: '123',
      nodes: [],
      error: 'Layout-tree fetch timed out',
    })).toBe(true);
    pane.render(root);

    expect(root.querySelector('.pane-error')?.textContent).toContain('timed out');
    const retry = root.querySelector<HTMLButtonElement>('.pane-error [data-action="refresh-layout"]');
    expect(retry?.textContent).toBe('Retry');
    retry?.click();
    expect(sent.at(-1)).toEqual({ type: 'FETCH_LAYOUT_TREE', rid: '123' });
  });

  it('keeps partial structural data visible and labels the source cutoff', () => {
    const { pane, root } = mountedPane();
    expect(pane.handleMessage({
      type: 'LAYOUT_TREE_RESULT',
      rid: '123',
      nodes: [{
        rid: '123',
        businessId: 'tabs',
        type: 'TabSet',
        name: 'Layout',
      }],
      truncated: true,
    })).toBe(true);
    pane.render(root);

    expect(root.textContent).toContain('Layout');
    expect(root.textContent).toContain('first 600 structural nodes');
  });

  it('disables the Blueprint launcher when the connected BMP is too old', () => {
    const { pane, root, sent } = mountedPane();
    pane.handleMessage({
      type: 'CONNECTION_STATE',
      state: { blueprintSupported: false },
    } as InspectorMessage);
    pane.render(root);

    const button = root.querySelector<HTMLButtonElement>('[data-action="edit-in-blueprint"]');
    expect(button?.disabled).toBe(true);
    expect(button?.title).toContain('5.6.3');
    button?.click();
    expect(sent).not.toContainEqual({ type: 'BLUEPRINT_TOGGLE' });
  });
});
