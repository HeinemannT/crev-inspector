import { describe, expect, it } from 'vitest';
import { AiContextSession } from '../ai-context-session';

const page = { rid: '100', tabRid: '101', tabName: 'Reports' };
const server = { id: 'demo', url: 'https://bmp.example/' };

describe('AI context session', () => {
  it('restores the best-known webpage after an explicit object is detached', () => {
    const session = new AiContextSession();
    session.syncSelection({
      page,
      selection: { rid: '100', businessId: 'webpage', name: 'Current webpage', type: 'Scorecard' },
    });
    const selected = { rid: '200', businessId: 'risks', name: 'Risks', type: 'ExtendedTable' };
    session.syncSelection({ page, selection: selected });
    session.detach(session.selection({ page, selection: selected })!);

    expect(session.selection({ page, selection: selected })?.object).toMatchObject({
      rid: '100',
      businessId: 'webpage',
      type: 'Scorecard',
    });
  });

  it('pins the object choice while accepting later identity enrichment', () => {
    const session = new AiContextSession();
    const sparse = { rid: '200' };
    session.toggleSelectionPin({ page, selection: sparse });
    session.syncSelection({
      page,
      selection: { rid: '200', businessId: 'risk_table', name: 'Risks', type: 'ExtendedTable' },
    });

    expect(session.selection({ page, selection: { rid: '300', businessId: 'other' } })?.object)
      .toMatchObject({ rid: '200', businessId: 'risk_table', type: 'ExtendedTable' });
  });

  it('treats the viewed page as an invariant fallback rather than a pinnable override', () => {
    const session = new AiContextSession();
    const selection = { rid: '100', businessId: 'webpage', name: 'Current webpage', type: 'Scorecard' };
    session.toggleSelectionPin({ page, selection });

    expect(session.selectionPinned).toBe(false);
    const source = session.selection({ page, selection })!;
    session.detach(source);
    expect(session.selection({ page, selection })).toEqual(source);
  });

  it('assembles editor-first envelopes and resets all detach state for a profile change', () => {
    const session = new AiContextSession();
    const editor = {
      kind: 'editor' as const,
      object: { rid: '300', businessId: 'expression', name: 'Expression', type: 'InputView' },
      slot: { name: 'expression', lang: 'extended' as const, code: 'output(1)' },
    };
    session.setEditor(editor);
    session.detach(editor);
    expect(session.envelope({ page, selection: null, server }).sources).toHaveLength(1);

    session.reset();
    expect(session.editor()).toBeNull();
    session.setEditor(editor);
    const envelope = session.envelope({
      page,
      selection: { rid: '200', businessId: 'risk_table', name: 'Risks', type: 'ExtendedTable' },
      server,
    });
    expect(envelope).toMatchObject({ v: 1, page, server });
    expect(envelope.sources.map(source => source.kind)).toEqual(['editor', 'selection']);
  });
});
