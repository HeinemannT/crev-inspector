// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { extractEditPageContext } from '../edit-page-context';

type Fiber = {
  memoizedProps?: Record<string, unknown>;
  return?: Fiber;
  child?: Fiber;
  sibling?: Fiber;
};

function attachFiber(element: Element, fiber: Fiber): void {
  Object.defineProperty(element, '__reactFiber$test', {
    configurable: true,
    enumerable: true,
    value: fiber,
  });
}

describe('extractEditPageContext', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('reads the exact EditPage identity without confusing it with the parent object', () => {
    document.body.innerHTML = '<main class="edit-page"><section class="property-editor"></section></main>';
    const carrier: Fiber = {
      memoizedProps: {
        editionContext: {
          editPageRid: '8004671601700515075',
          initializerRid: '8382372974634407803',
          webParentRid: '4727657119361219006',
          parentRid: '3917411863909651471',
          objectName: 'Enterprise procedure (default)',
          type: 'CeProcedure',
        },
      },
      return: { memoizedProps: { templateRid: '6643717869089264091' } },
    };
    attachFiber(document.querySelector('.property-editor')!, carrier);

    expect(extractEditPageContext()).toEqual({
      editPageRid: '8004671601700515075',
      initializerRid: '8382372974634407803',
      templateRid: '6643717869089264091',
      webParentRid: '4727657119361219006',
      parentRid: '3917411863909651471',
      objectRid: undefined,
      objectName: 'Enterprise procedure (default)',
      objectType: 'CeProcedure',
    });
  });

  it('keeps its fallback bounded on a large edit page', () => {
    document.body.innerHTML = `<main class="edit-page">${'<div></div>'.repeat(5_000)}</main>`;
    expect(extractEditPageContext()).toBeNull();
  });

  it('finds a zero-field form context in the bounded fiber fallback', () => {
    document.body.innerHTML = '<main class="edit-page"><div class="form-shell"></div></main>';
    const child: Fiber = {
      memoizedProps: { editionContext: { editPageRid: '8004671601700515075' } },
    };
    attachFiber(document.querySelector('.form-shell')!, { child });
    expect(extractEditPageContext()?.editPageRid).toBe('8004671601700515075');
  });
});
