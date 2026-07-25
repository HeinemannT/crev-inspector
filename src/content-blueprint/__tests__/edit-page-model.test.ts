import { describe, expect, it } from 'vitest';
import type { FlowNode } from '../../lib/layout/types';
import { projectEditPage } from '../edit-page-model';
import { editPageFieldLabel } from '../edit-page-result';

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
    expect(result[0].columns.map(c => c.map(n => n.id))).toEqual([['a'], ['col', 'b']]);
    expect(result[1].columns.map(c => c.map(n => n.id))).toEqual([['c']]);
  });

  it('keeps content before the first PageBreak as an implicit first page', () => {
    const result = projectEditPage([node('a'), node('p2', 'EditPageBreak', 'Second'), node('b')]);
    expect(result.map(p => p.key)).toEqual(['implicit', 'p2']);
    expect(result[0].columns[0].map(n => n.id)).toEqual(['a']);
  });

  it('projects a large page in one pass', () => {
    const children = Array.from({ length: 10_000 }, (_, i) => node(`f${i}`));
    const result = projectEditPage(children);
    expect(result).toHaveLength(1);
    expect(result[0].columns[0]).toHaveLength(10_000);
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
});
