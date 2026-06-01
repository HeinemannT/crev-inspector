import { describe, it, expect } from 'vitest';
import { serializeForDiff } from '../diff-serializer';

describe('serializeForDiff (v0.22 categorised format)', () => {
  it('produces an identity section with type, name, rid, businessId', () => {
    const result = serializeForDiff(
      { rid: '123', name: 'Test', type: 'Scorecard', businessId: 'SC-1' },
      {},
      [],
    );
    expect(result).toContain('─── identity ───');
    expect(result).toContain('type:');
    expect(result).toContain('Scorecard');
    expect(result).toContain('name:');
    expect(result).toContain('Test');
    expect(result).toContain('rid:');
    expect(result).toContain('123');
    expect(result).toContain('businessId:');
    expect(result).toContain('SC-1');
  });

  it('omits the businessId row when absent', () => {
    const result = serializeForDiff(
      { rid: '123', name: 'Test', type: 'Scorecard' },
      {},
      [],
    );
    expect(result).not.toContain('businessId:');
  });

  it('renders name as "unnamed" when missing', () => {
    const result = serializeForDiff({ rid: '123', type: 'Scorecard' }, {}, []);
    expect(result).toContain('name:');
    expect(result).toContain('unnamed');
  });

  it('groups props by category', () => {
    const result = serializeForDiff(
      { rid: '1' },
      {
        // layout
        width: '100', height: '200',
        // display
        columnsLargeScreen: '6', showToolMenu: 'true',
        // visibility
        visible: 'true',
        // unknown → other
        sortIndex: '5',
      },
      [],
    );
    expect(result).toContain('─── layout ───');
    expect(result).toContain('─── display ───');
    expect(result).toContain('─── visibility ───');
    expect(result).toContain('─── other ───');
    // Order: layout before display before visibility before other
    const idx = (s: string) => result.indexOf(s);
    expect(idx('─── layout ───')).toBeLessThan(idx('─── display ───'));
    expect(idx('─── display ───')).toBeLessThan(idx('─── visibility ───'));
    expect(idx('─── visibility ───')).toBeLessThan(idx('─── other ───'));
  });

  it('omits a category section when none of its props are present', () => {
    const result = serializeForDiff(
      { rid: '1' },
      { visible: 'true' },
      [],
    );
    expect(result).toContain('─── visibility ───');
    expect(result).not.toContain('─── layout ───');
    expect(result).not.toContain('─── display ───');
  });

  it('sorts rows alphabetically within a category', () => {
    const result = serializeForDiff(
      { rid: '1' },
      {
        headerColor: 'Blue',
        fontColor: 'Green',
      },
      [],
    );
    const apprIdx = result.indexOf('─── appearance ───');
    const rest = result.slice(apprIdx);
    const fontIdx = rest.indexOf('fontColor:');
    const headerIdx = rest.indexOf('headerColor:');
    // Alphabetical within the category: fontColor before headerColor.
    expect(fontIdx).toBeGreaterThan(0);
    expect(fontIdx).toBeLessThan(headerIdx);
  });

  it('omits empty values', () => {
    const result = serializeForDiff(
      { rid: '1' },
      { headerColor: 'Red', bgColor: '' },
      [],
    );
    expect(result).toContain('headerColor:');
    expect(result).not.toContain('bgColor:');
  });

  it('renders code props as fenced blocks under their own headers', () => {
    const result = serializeForDiff(
      { rid: '1' },
      { expression: 'sum(children().value)\noutput("done")' },
      ['expression'],
    );
    expect(result).toContain('─── code: expression ───');
    expect(result).toContain('sum(children().value)\noutput("done")');
    expect(result).toContain('─── end expression ───');
  });

  it('handles multiple code props', () => {
    const result = serializeForDiff(
      { rid: '1' },
      { html: '<div>hi</div>', javascript: 'alert(1)' },
      ['html', 'javascript'],
    );
    expect(result).toContain('─── code: html ───');
    expect(result).toContain('─── end html ───');
    expect(result).toContain('─── code: javascript ───');
    expect(result).toContain('─── end javascript ───');
  });

  it('handles an object with no properties', () => {
    const result = serializeForDiff({ rid: '1', name: 'Empty' }, {}, []);
    expect(result).toContain('─── identity ───');
    expect(result).toContain('name:');
    expect(result).toContain('Empty');
    expect(result).toContain('rid:');
    expect(result).toContain('1');
    // Only the identity section emits when there are no props
    expect(result).not.toContain('─── layout ───');
    expect(result).not.toContain('─── other ───');
  });

  it('does not duplicate code props as simple rows in the "other" section', () => {
    // expression is code-bearing → only appears in the code block, not as a row
    const result = serializeForDiff(
      { rid: '1' },
      { expression: 'SELECT X', sortIndex: '5' },
      ['expression'],
    );
    const otherIdx = result.indexOf('─── other ───');
    const codeIdx = result.indexOf('─── code: expression ───');
    expect(otherIdx).toBeGreaterThan(-1);
    expect(codeIdx).toBeGreaterThan(-1);
    // sortIndex is in "other"; expression shouldn't appear between "other"
    // section header and "code:" header.
    const slice = result.slice(otherIdx, codeIdx);
    expect(slice).toContain('sortIndex:');
    expect(slice).not.toMatch(/^expression:/m);
  });

  it('aligns colons within a section', () => {
    const result = serializeForDiff(
      { rid: '1' },
      { width: '100', height: '200' },
      [],
    );
    const layoutIdx = result.indexOf('─── layout ───');
    const rest = result.slice(layoutIdx).split('\n');
    // Both rows should have the colon at the same offset → same row length
    // when key is "width" (5) and "height" (6), the value column needs the
    // shorter key padded so "100" and "200" start at the same character.
    const widthLine = rest.find(l => l.startsWith('width:'));
    const heightLine = rest.find(l => l.startsWith('height:'));
    expect(widthLine).toBeDefined();
    expect(heightLine).toBeDefined();
    // value start offset is "key:" then padding spaces. With widest=6:
    //   width:    (6-5+2=3 spaces) 100  → value at index 9
    //   height:   (6-6+2=2 spaces) 200  → value at index 9
    const widthValueAt = widthLine!.indexOf('100');
    const heightValueAt = heightLine!.indexOf('200');
    expect(widthValueAt).toBe(heightValueAt);
  });
});
