import { describe, it, expect } from 'vitest';
import { ecResolveEnterpriseTemplate, ecResolveTemplate } from '../template-link';

describe('ecResolveTemplate', () => {
  it('emits linkedTo first, then BMP\'s simple/advanced enterprise-template resolution', () => {
    expect(ecResolveTemplate('_o', '_t')).toEqual([
      '_t := _o.linkedTo',
      'IF _t = MISSING THEN',
      '     IF _o.advancedMode.whenMissing(false) = true THEN',
      '          _tExpression := _o.templateExpression',
      '          IF _tExpression = MISSING THEN _t := MISSING ELSE _t := _tExpression.expression ENDIF',
      '          IF _t.className.whenMissing("") = "EnterpriseTemplate" THEN _t := _t ELSE _t := MISSING ENDIF',
      '     ELSE',
      '          _t := _o.template',
      '     ENDIF',
      'ENDIF',
    ]);
  });

  it('parameterises both var names', () => {
    expect(ecResolveTemplate('_inst', '_tmpl')).toEqual([
      '_tmpl := _inst.linkedTo',
      'IF _tmpl = MISSING THEN',
      '     IF _inst.advancedMode.whenMissing(false) = true THEN',
      '          _tmplExpression := _inst.templateExpression',
      '          IF _tmplExpression = MISSING THEN _tmpl := MISSING ELSE _tmpl := _tmplExpression.expression ENDIF',
      '          IF _tmpl.className.whenMissing("") = "EnterpriseTemplate" THEN _tmpl := _tmpl ELSE _tmpl := MISSING ENDIF',
      '     ELSE',
      '          _tmpl := _inst.template',
      '     ENDIF',
      'ENDIF',
    ]);
  });

  it('prepends the indent to every line (for nesting inside a block)', () => {
    expect(ecResolveTemplate('_o', '_t', '  ')).toEqual([
      '  _t := _o.linkedTo',
      '  IF _t = MISSING THEN',
      '       IF _o.advancedMode.whenMissing(false) = true THEN',
      '            _tExpression := _o.templateExpression',
      '            IF _tExpression = MISSING THEN _t := MISSING ELSE _t := _tExpression.expression ENDIF',
      '            IF _t.className.whenMissing("") = "EnterpriseTemplate" THEN _t := _t ELSE _t := MISSING ENDIF',
      '       ELSE',
      '            _t := _o.template',
      '       ENDIF',
      '  ENDIF',
    ]);
  });

  it('carries the substrings every consuming site asserts via toContain', () => {
    const ec = ecResolveTemplate('_o', '_t').join('\n');
    expect(ec).toContain('_o.linkedTo');
    expect(ec).toContain('IF _t = MISSING THEN');
    expect(ec).toContain('_o.advancedMode.whenMissing(false)');
    expect(ec).toContain('_o.templateExpression');
    expect(ec).toContain('_tExpression.expression');
    expect(ec).toContain('_o.template');
  });
});

describe('ecResolveEnterpriseTemplate', () => {
  it('resolves simple and advanced enterprise templates without consulting linkedTo', () => {
    const ec = ecResolveEnterpriseTemplate('_probe', '_tmpl').join('\n');
    expect(ec).toContain('_probe.advancedMode.whenMissing(false)');
    expect(ec).toContain('_tmplExpression := _probe.templateExpression');
    expect(ec).toContain('_tmpl := _tmplExpression.expression');
    expect(ec).toContain('_tmpl := _probe.template');
    expect(ec).not.toContain('.linkedTo');
  });
});
