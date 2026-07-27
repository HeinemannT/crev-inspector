import { describe, expect, it } from 'vitest';
import { extractFiberObjects, type ObjectFiber } from '../fiber-objects';

function fiber(rid: string): ObjectFiber {
  return { memoizedProps: { object: { rid, name: `Object ${rid}`, id: `id_${rid}` } } };
}

describe('extractFiberObjects', () => {
  it('walks a wide sibling list without consuming the JavaScript call stack', () => {
    const root = fiber('0');
    let current = root;
    for (let i = 1; i <= 10_000; i++) {
      current.sibling = fiber(String(i));
      current = current.sibling;
    }

    const objects = extractFiberObjects(root, 123);

    expect(objects).toHaveLength(10_001);
    expect(objects.at(-1)?.rid).toBe('10000');
  });

  it('keeps the existing depth limit without recursive calls', () => {
    const root = fiber('0');
    let current = root;
    for (let i = 1; i <= 10_000; i++) {
      current.child = fiber(String(i));
      current = current.child;
    }

    const objects = extractFiberObjects(root);

    expect(objects).toHaveLength(81);
    expect(objects.at(-1)?.rid).toBe('80');
  });

  it('skips cyclic fibers and duplicate objects', () => {
    const root = fiber('1');
    const child = fiber('1');
    root.child = child;
    child.sibling = root;

    expect(extractFiberObjects(root).map(object => object.rid)).toEqual(['1']);
  });

  it('skips malformed page-owned fiber links', () => {
    const root = fiber('1');
    root.child = 'not-a-fiber' as unknown as ObjectFiber;

    expect(extractFiberObjects(root).map(object => object.rid)).toEqual(['1']);
  });
});
