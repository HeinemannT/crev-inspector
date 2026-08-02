// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveEditPageOverlayTargets } from '../content-edit-page-inspect';
import type { EditPageInspectField } from '../content-state';
import type { EditPageContext } from '../lib/types';

const fields: EditPageInspectField[] = [
  {
    rid: '8636632438641212749',
    businessId: 'ef_req_code',
    name: 'Edit field',
    className: 'EditField',
    streamIndex: 0,
    property: 'code',
    propertyObject: {
      rid: '7000000000000000001',
      businessId: 'ceRequirementCode',
      name: 'Code',
      type: 'TextMethodConfig',
    },
  },
  { rid: '1141776988320800210', businessId: 'ef_req_name', name: 'Edit field', className: 'EditField', streamIndex: 2, property: 'name' },
  { rid: '8186816674374881070', businessId: 'ef_req_ident', name: 'Edit field', className: 'EditField', streamIndex: 3, property: 'req_identifier' },
  { rid: '2007587857978999303', businessId: 'ep_req_info', name: 'Instructions', className: 'EditPageInfo', streamIndex: 1 },
];

describe('standalone EditPage Inspect targets', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <main class="edit-page">
        <section id="first" class="property-editor"></section>
        <section id="second" class="property-editor"></section>
      </main>`;
  });

  it('maps rendered controls by property accessor first, then BMP field key', () => {
    const context: EditPageContext = {
      editPageRid: '5304043206318022568',
      fields: [
        { key: 2, propertyRef: 'name', displayName: 'Name' },
        { key: 0, propertyRef: '437340825368211083', displayName: 'Identifier' },
      ],
    };

    const targets = resolveEditPageOverlayTargets(context, fields);
    expect(targets.map(target => ({
      id: (target.element as HTMLElement).id,
      rid: target.rid,
      className: target.labelClassName,
    }))).toEqual([
      { id: 'first', rid: '1141776988320800210', className: 'crev-edit-field-label' },
      { id: 'second', rid: '8636632438641212749', className: 'crev-edit-field-label' },
    ]);
  });

  it('falls back to DOM order when older BMP builds expose no field metadata', () => {
    const context: EditPageContext = { editPageRid: '5304043206318022568' };
    expect(resolveEditPageOverlayTargets(context, fields).map(target => target.rid)).toEqual([
      '8636632438641212749',
      '1141776988320800210',
    ]);
  });

  it('carries the resolved property object into the badge target', () => {
    const context: EditPageContext = { editPageRid: '5304043206318022568' };
    const [target] = resolveEditPageOverlayTargets(context, fields);
    expect(target.propertyTarget).toEqual(fields[0].propertyObject);
  });

  it('uses the complete child-stream index when a break precedes a rendered field', () => {
    const context: EditPageContext = {
      editPageRid: '5304043206318022568',
      fields: [
        { key: 0, propertyRef: 'code' },
        { key: 2, propertyRef: '437340825368211083' },
      ],
    };
    expect(resolveEditPageOverlayTargets(context, fields).map(target => target.rid)).toEqual([
      '8636632438641212749',
      '1141776988320800210',
    ]);
  });

  it('preserves DOM alignment when one rendered editor has no React metadata', () => {
    const context: EditPageContext = {
      editPageRid: '5304043206318022568',
      fields: [
        {},
        { key: 2, propertyRef: '437340825368211083' },
      ],
    };
    expect(resolveEditPageOverlayTargets(context, fields).map(target => target.rid)).toEqual([
      '8636632438641212749',
      '1141776988320800210',
    ]);
  });

  it('ignores nested styled wrappers so one native field receives one badge', () => {
    document.querySelector('#first')!.innerHTML = '<div class="property-editor"></div>';
    const context: EditPageContext = { editPageRid: '5304043206318022568' };
    expect(resolveEditPageOverlayTargets(context, fields)).toHaveLength(2);
  });

  it('keeps a single direct property editor as the field slot before layout settles', () => {
    document.body.innerHTML = `
      <main class="edit-page">
        <div class="edit-page-content">
          <section id="only" class="property-editor"><input></section>
        </div>
      </main>`;
    const context: EditPageContext = { editPageRid: '5304043206318022568' };

    const [target] = resolveEditPageOverlayTargets(context, fields);

    expect((target?.element as HTMLElement | undefined)?.id).toBe('only');
  });

  it('targets a reference field and its Info object without property-editor classes', () => {
    document.body.innerHTML = `
      <main class="edit-page">
        <div class="edit-page-content">
          <div>
            <section id="info">Instructions for this form</section>
            <section id="taxonomy">Risk taxonomy</section>
          </div>
        </div>
      </main>`;
    const context: EditPageContext = {
      editPageRid: '5304043206318022568',
      fields: [
        {
          kind: 'info',
          key: 1,
          objectRef: '2007587857978999303',
          displayName: 'Instructions for this form',
        },
        {
          kind: 'field',
          key: 3,
          propertyRef: 'req_identifier',
          displayName: 'Risk taxonomy',
        },
      ],
    };

    expect(resolveEditPageOverlayTargets(context, fields).map(target => ({
      id: (target.element as HTMLElement).id,
      rid: target.rid,
    }))).toEqual([
      { id: 'info', rid: '2007587857978999303' },
      { id: 'taxonomy', rid: '8186816674374881070' },
    ]);
  });

  it('adds the nested EditPage identity and its fields inside CreateObjectView', () => {
    document.body.innerHTML = `
      <section data-rid="4016615977240292799" data-type="createObjectView">
        <div id="inline-page" class="edit-page-main-container">
          <div class="edit-page-content">
            <section id="inline-code" class="property-editor">Risk code</section>
          </div>
        </div>
      </section>`;
    const context: EditPageContext = {
      editPageRid: '5304043206318022568',
      fields: [{ key: 0, propertyRef: 'code', displayName: 'Risk code' }],
    };

    expect(resolveEditPageOverlayTargets(context, fields).map(target => ({
      id: (target.element as HTMLElement).id,
      rid: target.rid,
      className: target.labelClassName,
    }))).toEqual([
      {
        id: 'inline-page',
        rid: '5304043206318022568',
        className: 'crev-inline-edit-page-label',
      },
      {
        id: 'inline-code',
        rid: '8636632438641212749',
        className: 'crev-edit-field-label',
      },
    ]);
  });
});
