/**
 * Tests for the Alt-modifier copy path. Behavior was changed in this session
 * from "Alt copies BID" (silent fallback through plain) to "Alt explicitly
 * copies the raw RID". The change is user-visible (tooltip and overlay
 * label say "Alt: copy RID") so it deserves explicit coverage so a future
 * refactor doesn't quietly revert it.
 */
import { describe, it, expect } from 'vitest';
import { resolveCopyText, getModifier } from '../namespace';

describe('alt-modifier copy semantics', () => {
  describe('getModifier()', () => {
    it("returns 'alt' when altKey is set, even alongside ctrl/shift", () => {
      // Alt wins over everything — the user explicitly asked for the RID;
      // we shouldn't let a sticky shift/ctrl key change the meaning.
      expect(getModifier({ altKey: true } as MouseEvent)).toBe('alt');
      expect(getModifier({ altKey: true, ctrlKey: true } as MouseEvent)).toBe('alt');
      expect(getModifier({ altKey: true, shiftKey: true } as MouseEvent)).toBe('alt');
    });

    it("falls back to ctrl, shift, plain in that order", () => {
      expect(getModifier({ ctrlKey: true } as MouseEvent)).toBe('ctrl');
      expect(getModifier({ metaKey: true } as MouseEvent)).toBe('ctrl');
      expect(getModifier({ shiftKey: true } as MouseEvent)).toBe('shift');
      expect(getModifier({} as MouseEvent)).toBe('plain');
    });
  });

  describe('resolveCopyText with alt modifier', () => {
    it('returns the raw RID, not the businessId', () => {
      const result = resolveCopyText(
        { rid: '6655481628892308703', businessId: '716', type: 'Incident' },
        'alt',
      );
      expect(result.text).toBe('6655481628892308703');
      expect(result.label).toBe('RID');
    });

    it('returns the RID even when businessId is missing', () => {
      const result = resolveCopyText({ rid: '6655481628892308703' }, 'alt');
      expect(result.text).toBe('6655481628892308703');
      expect(result.label).toBe('RID');
    });

    it('falls back to businessId only when RID is truly empty', () => {
      // Should never happen in practice — every BMP object has a RID —
      // but the behavior is deterministic if it does.
      const result = resolveCopyText({ rid: '', businessId: '716' }, 'alt');
      expect(result.text).toBe('716');
    });
  });

  describe('non-alt paths still work', () => {
    it('plain returns businessId (label: ID)', () => {
      const result = resolveCopyText(
        { rid: '6655481628892308703', businessId: '716' },
        'plain',
      );
      expect(result.text).toBe('716');
      expect(result.label).toBe('ID');
    });

    it('ctrl returns namespace reference', () => {
      const result = resolveCopyText(
        { rid: '123', businessId: 'pMyProp', type: 'TextMethodConfig' },
        'ctrl',
      );
      expect(result.text).toBe('k.pMyProp');
      expect(result.label).toBe('ref');
    });
  });
});
