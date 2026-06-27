import { describe, it, expect } from 'vitest';
import { ecResolveTemplate } from '../template-link';

describe('ecResolveTemplate', () => {
  it('emits linkedTo first, then the .template fallback', () => {
    expect(ecResolveTemplate('_o', '_t')).toEqual([
      '_t := _o.linkedTo',
      'IF _t = MISSING THEN _t := _o.template ENDIF',
    ]);
  });

  it('parameterises both var names', () => {
    expect(ecResolveTemplate('_inst', '_tmpl')).toEqual([
      '_tmpl := _inst.linkedTo',
      'IF _tmpl = MISSING THEN _tmpl := _inst.template ENDIF',
    ]);
  });

  it('prepends the indent to every line (for nesting inside a block)', () => {
    expect(ecResolveTemplate('_o', '_t', '  ')).toEqual([
      '  _t := _o.linkedTo',
      '  IF _t = MISSING THEN _t := _o.template ENDIF',
    ]);
  });

  it('carries the substrings every consuming site asserts via toContain', () => {
    const ec = ecResolveTemplate('_o', '_t').join('\n');
    expect(ec).toContain('_o.linkedTo');
    expect(ec).toContain('IF _t = MISSING THEN');
    expect(ec).toContain('_o.template');
  });
});
