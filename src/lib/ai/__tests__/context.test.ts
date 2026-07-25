import { describe, it, expect } from 'vitest';
import { renderContext, envelopeTypes, envelopeLangs } from '../context';
import type { AiContextEnvelope } from '../types';

function env(over: Partial<AiContextEnvelope> = {}): AiContextEnvelope {
  return {
    v: 1,
    server: { id: 'hetzner-prod', url: 'https://bmp.example' },
    sources: [],
    ...over,
  };
}

describe('renderContext', () => {
  it('returns empty string for an envelope with no sources', () => {
    expect(renderContext(env())).toBe('');
  });

  it('is deterministic — identical envelopes render byte-identically', () => {
    const e = env({
      sources: [{
        kind: 'editor',
        object: { rid: '900', businessId: 'cvo_x', name: 'Chart', type: 'CustomVisualization' },
        slot: { name: 'html', lang: 'html', code: '<div>hi</div>' },
      }],
    });
    expect(renderContext(e)).toBe(renderContext(structuredClone(e)));
  });

  it('emits a stable attribute order and consults TYPE_META affordances/slots', () => {
    const out = renderContext(env({
      sources: [{
        kind: 'selection',
        object: { rid: '5', businessId: 'btn_1', name: 'Go', type: 'ButtonInput', templateBusinessId: 'tmpl_1' },
      }],
    }));
    // Fixed order: type, bid, name, rid, template, affordances, slots.
    expect(out).toContain('<object type="ButtonInput" bid="btn_1" name="Go" rid="5" uiRef="[[object:5]]" template="tmpl_1" affordances="code" slots="expression,afterExpression,initExpression,showExpression,enableExpression"/>');
    expect(out.startsWith('<context server="hetzner-prod">')).toBe(true);
  });

  it('inlines the editor slot code last (volatile part) in a fenced block', () => {
    const out = renderContext(env({
      sources: [{
        kind: 'editor',
        object: { rid: '900', businessId: 'calc', name: 'Calc', type: 'ExtendedCode' },
        slot: { name: 'expression', lang: 'extended', code: 'output(t.calc.name)', selection: { from: 0, to: 6 } },
      }],
    }));
    expect(out).toContain('<slot name="expression" lang="extended" selection="0-6">');
    expect(out).toContain('```extended\noutput(t.calc.name)\n```');
    // Code (volatile) comes after the identity line.
    expect(out.indexOf('output(t.calc.name)')).toBeGreaterThan(out.indexOf('<object'));
  });

  it('marks an oversized slot body truncated', () => {
    const big = 'x'.repeat(7000);
    const out = renderContext(env({
      sources: [{
        kind: 'editor',
        object: { rid: '1', businessId: 'b', name: 'n', type: 'ExtendedCode' },
        slot: { name: 'expression', lang: 'extended', code: big },
      }],
    }));
    expect(out).toContain('truncated="true"');
    expect(out).toContain('(slot truncated — use read_object for the full body)');
  });

  it('escapes attribute-hostile characters in identity strings', () => {
    const out = renderContext(env({
      sources: [{ kind: 'selection', object: { rid: '1', businessId: 'b', name: 'A & "B" <x>', type: 'ExtendedCode' } }],
    }));
    expect(out).toContain('name="A &amp; &quot;B&quot; &lt;x&gt;"');
  });
});

describe('envelopeTypes / envelopeLangs', () => {
  it('returns distinct types and langs in first-seen order', () => {
    const e = env({
      sources: [
        { kind: 'editor', object: { rid: '1', businessId: 'a', name: 'A', type: 'CustomVisualization' }, slot: { name: 'html', lang: 'html', code: '' } },
        { kind: 'selection', object: { rid: '2', businessId: 'b', name: 'B', type: 'CustomVisualization' } },
      ],
    });
    expect(envelopeTypes(e)).toEqual(['CustomVisualization']);
    expect(envelopeLangs(e)).toEqual(['html']);
  });
});
