/**
 * parseAccessTraceNode — normalises the deserialized AccessTraceDTO tree
 * (boxed java.lang.Boolean, HashMap {$map}/{$entries}, ArrayList {$elements},
 * skipped Duration) into the clean AccessTraceNode the UI renders.
 */
import { describe, it, expect } from 'vitest';
import { parseAccessTraceNode, extractAccessTrace } from '../bmp-client';

describe('parseAccessTraceNode', () => {
  it('coerces boxed Boolean result + HashMap details + ArrayList children', () => {
    const dto = {
      $class: 'com.corporater.bmp.dto.command.access.AccessTraceDTO',
      element: 'Statement',
      result: { $class: 'java.lang.Boolean', value: true },
      duration: { $class: 'java.time.Ser' }, // skipped by deserializer — ignored
      timedOut: false,
      details: { $class: 'java.util.HashMap', $map: { policyRid: '901', statementIndex: '2' } },
      childrenDTOs: {
        $class: 'java.util.ArrayList',
        $elements: [
          { element: 'Subject', result: false, timedOut: false, details: { $map: { subject: 'role:role_auditor' } }, childrenDTOs: { $elements: [] } },
        ],
      },
    };
    const node = parseAccessTraceNode(dto);
    expect(node.element).toBe('Statement');
    expect(node.result).toBe(true);
    expect(node.timedOut).toBe(false);
    expect(node.details).toEqual({ policyRid: '901', statementIndex: '2' });
    expect(node.children).toHaveLength(1);
    expect(node.children[0].element).toBe('Subject');
    expect(node.children[0].result).toBe(false);
    expect(node.children[0].details).toEqual({ subject: 'role:role_auditor' });
  });

  it('handles primitive boolean and $entries-style maps', () => {
    const node = parseAccessTraceNode({
      element: 'HasAccessTo',
      result: false,
      details: { $entries: [['reference', 'Organisation'], ['accessAction', 'Read']] },
      childrenDTOs: [],
    });
    expect(node.result).toBe(false);
    expect(node.details).toEqual({ reference: 'Organisation', accessAction: 'Read' });
    expect(node.children).toEqual([]);
  });

  it('maps a non-boolean (null) result to null, not false', () => {
    const node = parseAccessTraceNode({ element: 'All', result: null, childrenDTOs: { $elements: [] } });
    expect(node.result).toBeNull();
    expect(node.element).toBe('All');
  });

  it('is defensive against missing fields', () => {
    const node = parseAccessTraceNode({});
    expect(node).toEqual({ element: '', result: null, timedOut: false, details: {}, children: [] });
  });
});

describe('extractAccessTrace (response unwrap)', () => {
  // Shape mirrors the deserialized AccessTraceCommand response:
  // ArrayList<IntegrationObjectResponse> → .response (AccessTraceResultDto) → .traces (ArrayList).
  const wellFormed = [{
    $class: 'java.util.ArrayList',
    $elements: [{
      $class: 'com.corporater.bmp.dto.response.IntegrationObjectResponse',
      response: {
        $class: 'com.corporater.bmp.dto.command.access.AccessTraceResultDto',
        traces: { $class: 'java.util.ArrayList', $elements: [
          { element: 'TraceRequest', result: true, timedOut: false, details: {}, childrenDTOs: { $elements: [] } },
        ] },
      },
    }],
  }];

  it('pulls the first trace tree out of the response envelope', () => {
    const node = extractAccessTrace(wellFormed);
    expect(node?.element).toBe('TraceRequest');
    expect(node?.result).toBe(true);
  });

  it('throws on a ServerExceptionResponse', () => {
    expect(() => extractAccessTrace([{ $class: '...ServerExceptionResponse', message: 'no rights' }]))
      .toThrow('no rights');
  });

  it('returns null when no trace is present', () => {
    expect(extractAccessTrace([])).toBeNull();
    expect(extractAccessTrace([{ $class: 'java.util.ArrayList', $elements: [] }])).toBeNull();
  });
});
