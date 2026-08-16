import { describe, expect, it } from 'vitest';
import { parsePreviewReceipt } from '../preview-receipt';

describe('parsePreviewReceipt', () => {
  it('turns mixed BMP output into one ordered receipt', () => {
    const receipt = parsePreviewReceipt([
      'Message : Would move "5933 Issue Summary" before "5932 Issue Status"',
      'Message : Would move "5932 Issue Status" as child of  "template_demo Demo Objects"',
      'Message : Result :',
      "        t.5923.add(SimpleStatus, id := '5932', name := 'Issue Status')",
      "t.5933.change(id := '5933', name := 'Issue Summary') //DescriptionView",
      'Message : Duration : 8ms',
      '[PREVIEW OK — no changes committed]',
    ].join('\n'));

    expect(receipt.summary).toBe('2 moves · 2 generated scripts');
    expect(receipt.events).toEqual([
      { kind: 'move', object: '5933 Issue Summary', relation: 'before', target: '5932 Issue Status' },
      { kind: 'move', object: '5932 Issue Status', relation: 'into', target: 'template_demo Demo Objects' },
      expect.objectContaining({ kind: 'generated', action: 'create', target: 'Issue Status' }),
      expect.objectContaining({ kind: 'generated', action: 'edit', target: 'Issue Summary' }),
    ]);
    expect(receipt.rawLineCount).toBe(7);
  });

  it('extracts property writes and ignores their redundant result echo', () => {
    const receipt = parsePreviewReceipt([
      'Would write "121j" to property "id" for object 121j Header (Main)',
      'Would write "119j" to property "id" for object 119j Navigation',
      'Result : [119j, [119j Navigation]]',
    ].join('\n'));

    expect(receipt.summary).toBe('2 changes');
    expect(receipt.events).toHaveLength(2);
    expect(receipt.events[0]).toEqual({
      kind: 'write', value: '121j', property: 'id', object: '121j Header (Main)',
    });
  });

  it('keeps unknown output as a generic result', () => {
    const receipt = parsePreviewReceipt('Preview successful');
    expect(receipt.summary).toBe('1 result');
    expect(receipt.events).toEqual([{ kind: 'result', text: 'Preview successful' }]);
  });
});
