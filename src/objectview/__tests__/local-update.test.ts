/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';
import { replacePropertyElement, syncOptionalElement } from '../local-update';
import { syncObjectViewInteractionLock } from '../interaction-lock';

describe('expanded object view local updates', () => {
  it('replaces only the edited property and preserves the scroll owner', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <div class="ov-body">
        <div data-property-prop="disableSearch">Off</div>
        <div data-property-prop="shadow">Off</div>
      </div>
    `;
    const body = root.querySelector<HTMLElement>('.ov-body')!;
    body.scrollTop = 280;

    const replaced = replacePropertyElement(root, 'disableSearch', () => {
      const next = document.createElement('div');
      next.dataset.propertyProp = 'disableSearch';
      next.textContent = 'On';
      return next;
    });

    expect(replaced).toBe(true);
    expect(root.querySelector('.ov-body')).toBe(body);
    expect(body.scrollTop).toBe(280);
    expect(root.querySelector('[data-property-prop="disableSearch"]')?.textContent).toBe('On');
    expect(root.querySelector('[data-property-prop="shadow"]')?.textContent).toBe('Off');
  });

  it('adds, replaces, and removes the action bar in place', () => {
    const shell = document.createElement('div');
    const first = document.createElement('div');
    first.className = 'pane-actionbar';
    first.textContent = '1 pending';

    syncOptionalElement(shell, '.pane-actionbar', first);
    expect(shell.querySelector('.pane-actionbar')?.textContent).toBe('1 pending');

    const second = document.createElement('div');
    second.className = 'pane-actionbar';
    second.textContent = 'Saving';
    syncOptionalElement(shell, '.pane-actionbar', second);
    expect(shell.querySelector('.pane-actionbar')?.textContent).toBe('Saving');

    syncOptionalElement(shell, '.pane-actionbar', null);
    expect(shell.querySelector('.pane-actionbar')).toBeNull();
  });

  it('locks editable regions while leaving the action bar readable', () => {
    const root = document.createElement('div');
    root.innerHTML = `
      <div class="ov-shell">
        <header class="ov-header"><button>Edit</button></header>
        <div class="ov-body"><button>Property</button></div>
        <div class="pane-actionbar">Saving</div>
      </div>
    `;

    syncObjectViewInteractionLock(root, true);
    expect(root.querySelector('.ov-shell')?.getAttribute('aria-busy')).toBe('true');
    expect(root.querySelector('.ov-header')?.hasAttribute('inert')).toBe(true);
    expect(root.querySelector('.ov-body')?.hasAttribute('inert')).toBe(true);
    expect(root.querySelector('.pane-actionbar')?.hasAttribute('inert')).toBe(false);

    syncObjectViewInteractionLock(root, false);
    expect(root.querySelector('.ov-shell')?.hasAttribute('aria-busy')).toBe(false);
    expect(root.querySelector('.ov-header')?.hasAttribute('inert')).toBe(false);
    expect(root.querySelector('.ov-body')?.hasAttribute('inert')).toBe(false);
  });
});
