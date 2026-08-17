import { describe, expect, it } from 'vitest';
import { changeTicketTargetRid, parseChangeProposal } from '../change-ticket';

describe('changeTicketTargetRid', () => {
  it.each([
    ['[[object:9223372036854775807]]', '9223372036854775807'],
    ['  [[object:-42]]  ', '-42'],
  ])('preserves the rid from an exact object token', (target, rid) => {
    expect(changeTicketTargetRid(target)).toBe(rid);
  });

  it.each(['[[object:t.qa_page]]', 'prefix [[object:42]]', '[[object:42]] suffix'])('rejects %s', target => {
    expect(changeTicketTargetRid(target)).toBeNull();
  });
});

describe('parseChangeProposal', () => {
  it('keeps every line after the divider as the exact code artifact', () => {
    expect(parseChangeProposal([
      'summary: Add a process owner',
      'target: Process Register',
      'operation: update',
      'language: extended',
      '---',
      't.owner := lookup("admin")',
      '---verify---',
      'output(t.owner.name)',
    ].join('\n'))).toEqual({
      summary: 'Add a process owner',
      target: 'Process Register',
      operation: 'update',
      language: 'extended',
      code: 't.owner := lookup("admin")\n---verify---\noutput(t.owner.name)',
    });
  });

  it('normalizes CRLF and header whitespace, while trimming scripts', () => {
    const proposal = parseChangeProposal('summary:  Change   title  \r\ntarget: Current page\r\nlanguage: EXTENDED\r\noperation: CREATE\r\n---\r\n\r\noutput(1)\r\n');
    expect(proposal).toMatchObject({ summary: 'Change title', operation: 'create', code: 'output(1)' });
    expect(proposal).toHaveProperty('target', 'Current page');
  });

  it.each([
    'language: extended\noperation: update\n---\noutput(1)',
    'summary: Missing language\noperation: update\n---\noutput(1)',
    'summary: Missing target\nlanguage: extended\noperation: update\n---\noutput(1)',
    'summary: Unsupported operation\nlanguage: extended\noperation: execute\n---\noutput(1)',
    'summary: No body\nlanguage: extended\noperation: update\n---\n',
    'summary: Bad header\nlanguage extended\noperation: update\n---\noutput(1)',
  ])('rejects malformed or incomplete ticket metadata', body => {
    expect(parseChangeProposal(body)).toBeNull();
  });

  it('does not mistake a similar marker inside code for the verification divider', () => {
    const proposal = parseChangeProposal('summary: Keep marker\ntarget: Current object\nlanguage: extended\noperation: other\n---\noutput("---verify---")');
    expect(proposal?.code).toBe('output("---verify---")');
  });

  it.each([
    'summary: One\nsummary: Two\ntarget: Current object\nlanguage: extended\noperation: update\n---\noutput(1)',
    'summary: One\nscore: 100\ntarget: Current object\nlanguage: extended\noperation: update\n---\noutput(1)',
  ])('rejects ambiguous executable metadata', body => {
    expect(parseChangeProposal(body)).toBeNull();
  });

  it('rejects malformed object-chip syntax in the target', () => {
    expect(parseChangeProposal([
      'summary: Rename page',
      'target: [[object:t.qa_page]]',
      'operation: update',
      'language: extended',
      '---',
      't.qa_page.change(name := "Review")',
    ].join('\n'))).toBeNull();
  });
});
