import { describe, it, expect, beforeEach } from 'vitest';
import { mockChromeStorage } from './chrome-mock';
import { StylePresetStore } from '../style-presets';
import type { NodeStyle } from '../layout/types';

const red: NodeStyle = { headerColorBid: 'C_RED', shadow: true };
const blue: NodeStyle = { headerColorBid: 'C_BLUE' };

describe('StylePresetStore', () => {
  beforeEach(() => { mockChromeStorage(); });

  it('save adds a preset; saving the same name REPLACES in place (keeps id), a new name prepends', () => {
    const s = new StylePresetStore('p1');
    const a = s.save('Brand', red)!;
    expect(s.getAll().map(p => p.name)).toEqual(['Brand']);
    const b = s.save('Muted', blue)!;
    expect(s.getAll().map(p => p.name)).toEqual(['Muted', 'Brand']); // newest first
    const a2 = s.save('brand', blue)!; // case-insensitive same name → replace
    expect(s.getAll()).toHaveLength(2);
    expect(a2.id).toBe(a.id);                                   // id preserved
    expect(s.getAll().find(p => p.id === a.id)!.style).toEqual(blue); // style updated
    void b;
  });

  it('rejects a blank name', () => {
    const s = new StylePresetStore('p1');
    expect(s.save('   ', red)).toBeNull();
    expect(s.getAll()).toHaveLength(0);
  });

  it('remove deletes by id', () => {
    const s = new StylePresetStore('p1');
    const a = s.save('X', red)!;
    s.remove(a.id);
    expect(s.getAll()).toHaveLength(0);
  });

  it('persists per-profile and reloads on switchProfile (namespaced storage key)', async () => {
    const s = new StylePresetStore('alpha');
    s.save('only-alpha', red);
    await s.switchProfile('beta');          // persists alpha, loads beta (empty)
    expect(s.getAll()).toHaveLength(0);
    s.save('only-beta', blue);
    await s.switchProfile('alpha');         // persists beta, loads alpha back from storage
    expect(s.getAll().map(p => p.name)).toEqual(['only-alpha']); // alpha's preset survived
  });
});
