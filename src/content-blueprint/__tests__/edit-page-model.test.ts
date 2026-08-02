import { describe, expect, it } from 'vitest';
import type { FlowNode } from '../../lib/layout/types';
import { projectEditPage } from '../edit-page-model';
import { editPageFieldLabel } from '../edit-page-result';
import type { LModel } from '../../lib/layout/types';
import { deleteFlowChild, effectiveFlowChildren } from '../../lib/layout/flow';

const node = (id: string, className = 'EditField', name = id): FlowNode => ({
  id, className, name, isBreak: className.includes('Break'),
});

describe('projectEditPage', () => {
  it('turns the flat BMP stream into rendered steps and columns without losing order', () => {
    const result = projectEditPage([
      node('p1', 'EditPageBreak', 'Details'),
      node('a'),
      node('col', 'EditPageColumnBreak'),
      node('b'),
      node('p2', 'EditPageBreak', 'Assessment'),
      node('c'),
    ]);
    expect(result.map(p => p.title)).toEqual(['Details', 'Assessment']);
    expect(result[0].columns.map(c => ({
      breakId: c.breakNode?.id,
      nodes: c.nodes.map(n => n.id),
    }))).toEqual([
      { breakId: undefined, nodes: ['a'] },
      { breakId: 'col', nodes: ['b'] },
    ]);
    expect(result[1].columns.map(c => c.nodes.map(n => n.id))).toEqual([['c']]);
  });

  it('keeps content before the first PageBreak as an implicit first page', () => {
    const result = projectEditPage([node('a'), node('p2', 'EditPageBreak', 'Second'), node('b')]);
    expect(result.map(p => p.key)).toEqual(['implicit', 'p2']);
    expect(result[0].columns[0].nodes.map(n => n.id)).toEqual(['a']);
  });

  it('projects a large page in one pass', () => {
    const children = Array.from({ length: 10_000 }, (_, i) => node(`f${i}`));
    const result = projectEditPage(children);
    expect(result).toHaveLength(1);
    expect(result[0].columns[0].nodes).toHaveLength(10_000);
  });

  it('merges the right column into the left when its real ColumnBreak is staged for deletion', () => {
    const children = [
      node('p1', 'EditPageBreak', 'Details'),
      node('a'),
      node('col', 'EditPageColumnBreak', 'Classification'),
      node('b'),
    ];
    const model: LModel = {
      pageId: 'edit_page',
      pageClass: 'EditPage',
      tabsetId: '',
      tabs: [],
      target: 'instance',
      hasTemplate: false,
      flows: {
        edit_page: {
          ownerId: 'edit_page',
          ownerClass: 'EditPage',
          kind: 'editpage',
          refId: 'edit_page',
          refClass: 'EditPage',
          children,
        },
      },
      flowEdits: {},
    };

    const desired = deleteFlowChild(model, 'edit_page', 'col');
    expect(projectEditPage(effectiveFlowChildren(desired, 'edit_page'))[0].columns)
      .toMatchObject([{ nodes: [{ id: 'a' }, { id: 'b' }] }]);
  });
});

describe('editPageFieldLabel', () => {
  it('uses the property mapping when BMP supplies only the generic stock name', () => {
    expect(editPageFieldLabel({ id: 'a', className: 'EditField', name: 'Edit field', prop: 'rpo_hours' }))
      .toBe('RPO HOURS');
  });

  it('keeps a configured field name', () => {
    expect(editPageFieldLabel({ id: 'a', className: 'EditField', name: 'Risk title', prop: 'name' }))
      .toBe('Risk title');
  });

  it('uses an authoritative property label for a generic stock name', () => {
    expect(editPageFieldLabel(
      { id: 'a', className: 'EditField', name: 'Edit field', prop: 'rpo_hours' },
      { accessor: 'rpo_hours', label: 'Recovery time objective', configClass: 'TextMethodConfig', systemobject: false },
    )).toBe('Recovery time objective');
  });
});
