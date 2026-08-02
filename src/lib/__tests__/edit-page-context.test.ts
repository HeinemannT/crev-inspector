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

  it('reads an EditPage embedded directly inside a CreateObjectView', () => {
    document.body.innerHTML = `
      <section data-rid="4016615977240292799" data-type="createObjectView">
        <div class="edit-page-main-container">
          <div class="edit-page-content">
            <section class="property-editor"></section>
          </div>
        </div>
      </section>`;
    const editor = document.querySelector('.property-editor')!;
    attachFiber(editor, {
      memoizedProps: {
        field: { key: 0, name: 'risk_code', displayName: 'Risk code' },
      },
      return: {
        memoizedProps: {
          editionContext: {
            editPageRid: '8004671601700515075',
            type: 'CeRiskAssessment',
          },
        },
      },
    });

    expect(extractEditPageContext()).toMatchObject({
      editPageRid: '8004671601700515075',
      objectType: 'CeRiskAssessment',
      fields: [{
        kind: 'field',
        key: 0,
        propertyRef: 'risk_code',
        displayName: 'Risk code',
      }],
    });
  });

  it('does not treat the nested main container as a second standalone host', () => {
    document.body.innerHTML = `
      <main class="edit-page">
        <div class="edit-page-main-container">
          <section class="property-editor"></section>
        </div>
      </main>`;
    attachFiber(document.querySelector('.property-editor')!, {
      memoizedProps: {
        editionContext: { editPageRid: '8004671601700515075' },
      },
    });

    expect(extractEditPageContext()?.editPageRid).toBe('8004671601700515075');
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

  it('captures each rendered property editor stream index for Inspect mode', () => {
    document.body.innerHTML = `
      <main class="edit-page">
        <section class="property-editor"></section>
        <section class="property-editor"></section>
      </main>`;
    const editors = document.querySelectorAll('.property-editor');
    const editionCarrier: Fiber = {
      memoizedProps: { editionContext: { editPageRid: '8004671601700515075' } },
    };
    attachFiber(editors[0], {
      memoizedProps: {
        field: {
          key: 3,
          name: '437340825368211083',
          displayName: 'Identifier',
          pageIndex: 0,
          columnIndex: 1,
        },
      },
      return: editionCarrier,
    });
    attachFiber(editors[1], {
      memoizedProps: {
        field: {
          key: 5,
          name: 'authority_document',
          displayName: 'Authority Document',
          pageIndex: 1,
          columnIndex: 0,
        },
      },
      return: editionCarrier,
    });

    expect(extractEditPageContext()?.fields).toEqual([
      {
        kind: 'field',
        key: 3,
        propertyRef: '437340825368211083',
        displayName: 'Identifier',
        pageIndex: 0,
        columnIndex: 1,
      },
      {
        kind: 'field',
        key: 5,
        propertyRef: 'authority_document',
        displayName: 'Authority Document',
        pageIndex: 1,
        columnIndex: 0,
      },
    ]);
  });

  it('captures reference controls and Info objects without property-editor classes', () => {
    document.body.innerHTML = `
      <main class="edit-page">
        <div class="edit-page-content">
          <div class="column">
            <section id="info">Instructions</section>
            <section id="taxonomy">Risk taxonomy</section>
          </div>
        </div>
      </main>`;
    const editionCarrier: Fiber = {
      memoizedProps: { editionContext: { editPageRid: '8004671601700515075' } },
    };
    attachFiber(document.querySelector('#info')!, {
      memoizedProps: {
        field: {
          key: 0,
          name: '2007587857978999303',
          label: 'Instructions',
        },
      },
      return: editionCarrier,
    });
    attachFiber(document.querySelector('#taxonomy')!, {
      memoizedProps: {
        field: {
          key: 6,
          name: 'risk_taxonomy',
          displayName: 'Risk taxonomy',
          pageIndex: 0,
          columnIndex: 0,
        },
      },
      return: editionCarrier,
    });
    attachFiber(document.querySelector('.edit-page')!, editionCarrier);

    expect(extractEditPageContext()?.fields).toEqual([
      {
        kind: 'info',
        key: 0,
        objectRef: '2007587857978999303',
        displayName: 'Instructions',
        pageIndex: undefined,
        columnIndex: undefined,
      },
      {
        kind: 'field',
        key: 6,
        propertyRef: 'risk_taxonomy',
        displayName: 'Risk taxonomy',
        pageIndex: 0,
        columnIndex: 0,
      },
    ]);
  });
});
