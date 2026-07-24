// @vitest-environment happy-dom

import { beforeEach, describe, expect, it } from 'vitest';
import { detectPageHeader } from '../page-header-detection';

function visible(element: HTMLElement, top = 80, width = 320, height = 36): HTMLElement {
  element.getBoundingClientRect = () => ({
    x: 24,
    y: top,
    top,
    right: 24 + width,
    bottom: top + height,
    left: 24,
    width,
    height,
    toJSON: () => ({}),
  });
  return element;
}

function heading(text: string, top = 80): HTMLHeadingElement {
  const element = visible(document.createElement('h1'), top) as HTMLHeadingElement;
  element.textContent = text;
  return element;
}

describe('detectPageHeader', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('selects the single visible level-one heading in the BMP app', () => {
    const root = document.createElement('div');
    root.id = 'epmapp';
    const title = heading('Process Register');
    root.appendChild(title);
    document.body.appendChild(root);

    const result = detectPageHeader();

    expect(result?.element).toBe(title);
    expect(result?.signals).toContain('semantic-h1');
    expect(result?.signals).toContain('inside-app-root');
  });

  it('ignores headings inside dialogs and RID-bearing widgets', () => {
    const root = document.createElement('div');
    root.id = 'epmapp';
    const pageTitle = heading('Process Register', 60);
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.appendChild(heading('Edit process', 90));
    const widget = document.createElement('section');
    widget.dataset.rid = '123';
    widget.appendChild(heading('Widget title', 140));
    root.append(pageTitle, dialog, widget);
    document.body.appendChild(root);

    expect(detectPageHeader()?.element).toBe(pageTitle);
  });

  it('fails closed when two headings are equally plausible', () => {
    const root = document.createElement('div');
    root.id = 'epmapp';
    root.append(heading('First', 60), heading('Second', 80));
    document.body.appendChild(root);

    expect(detectPageHeader()).toBeNull();
  });

  it('uses the resolved page name to disambiguate candidates', () => {
    const root = document.createElement('div');
    root.id = 'epmapp';
    const first = heading('Overview', 60);
    const wanted = heading('Process Register', 80);
    root.append(first, wanted);
    document.body.appendChild(root);

    const result = detectPageHeader({ expectedName: 'Process Register' });

    expect(result?.element).toBe(wanted);
    expect(result?.signals).toContain('exact-page-name');
  });

  it('rejects headings outside BMP when a BMP root exists', () => {
    const shellTitle = heading('Host application', 20);
    const root = document.createElement('div');
    root.id = 'epmapp';
    document.body.append(shellTitle, root);

    expect(detectPageHeader()).toBeNull();
  });
});
