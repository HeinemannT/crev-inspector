import { describe, expect, it } from 'vitest';
import { extractValidChangeTicket, isolateValidChangeTicket } from '../change-ticket';

describe('isolateValidChangeTicket', () => {
  const ticket = [
    '```crev-change', 'summary: Fix filter', 'target: Current table', 'operation: update', 'language: extended', '---',
    't.table.change(name := "Open")', '```',
  ].join('\n');

  it('removes provider narration around one valid ticket', () => {
    expect(isolateValidChangeTicket(`I will preview this first.\n\n\`\`\`extended\noutput(1)\n\`\`\`\n\n${ticket}`)).toBe(ticket);
  });

  it('does not repair or choose between unsafe ambiguous responses', () => {
    expect(isolateValidChangeTicket(`Before\n${ticket}\n${ticket}`)).toBe(`Before\n${ticket}\n${ticket}`);
    expect(isolateValidChangeTicket('No ticket here')).toBe('No ticket here');
  });
});

describe('extractValidChangeTicket', () => {
  it('returns null for malformed change output instead of treating visible gibberish as success', () => {
    expect(extractValidChangeTicket('thinking only')).toBeNull();
    expect(extractValidChangeTicket('```crev-change\nsummary: incomplete\n```')).toBeNull();
  });
});
