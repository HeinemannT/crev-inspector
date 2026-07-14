// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import type { LModel, LNode } from '../../lib/layout/types';
import { trayPanel } from '../view-panels';

const node = (p: Partial<LNode> & Pick<LNode, 'id' | 'kind' | 'className'>): LNode => ({
  name: p.id, cols: { L: 6 }, children: [], ...p,
});

describe('Blueprint pending tray', () => {
  it('shows flow-only changes instead of claiming there are no staged changes', () => {
    const base: LModel = {
      pageId: 'page', pageClass: 'Scorecard', tabsetId: 'tabs', target: 'template', hasTemplate: false,
      tabs: [node({ id: 'tab', kind: 'tab', className: 'Tab', children: [
        node({ id: 'input', kind: 'widget', className: 'InputView' }),
      ] })],
      flows: {
        input: {
          ownerId: 'input', ownerClass: 'InputView', kind: 'inputset', refId: 'set', refClass: 'InputSet',
          children: [],
        },
      },
    };
    const desired: LModel = {
      ...base,
      flowEdits: { set: { adds: [{ id: 'new:field', className: 'TextInput', name: 'New field' }] } },
    };

    const tray = trayPanel(base, desired);

    expect(tray.textContent).toContain('New field');
    expect(tray.textContent).not.toContain('No staged changes');
  });
});
