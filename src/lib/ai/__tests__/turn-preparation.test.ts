import { describe, expect, it, vi } from 'vitest';
import { CHAT_MAX_OUTPUT_TOKENS, prepareAiTurn } from '../turn-preparation';

describe('AI turn preparation', () => {
  it('loads the full prompt only after the compact path is unavailable', async () => {
    const loadFullPrompt = vi.fn(async () => ({
      system: 'FULL SYSTEM',
      context: '<context>workspace primer</context>',
    }));
    const turn = await prepareAiTurn({
      system: 'BASE SYSTEM',
      context: '<context>base</context>',
      loadFullPrompt,
      history: [],
      text: 'Explain this workspace.',
      prefetchEnabled: true,
      onEvent: () => {},
      executeTool: vi.fn(),
    });

    expect(loadFullPrompt).toHaveBeenCalledOnce();
    expect(turn.system).toBe('FULL SYSTEM');
    expect(turn.user).toBe('Explain this workspace.\n\n<context>workspace primer</context>');
    expect(turn.maxOutputTokens).toBe(CHAT_MAX_OUTPUT_TOKENS);
  });

  it('keeps only the newest complete transcript suffix within the model budget', async () => {
    const turn = await prepareAiTurn({
      system: 'S',
      history: [
        { role: 'user', text: 'old question' },
        { role: 'assistant', text: 'old answer' },
        { role: 'user', text: 'new question' },
        { role: 'assistant', text: 'new answer' },
      ],
      text: 'current',
      prefetchEnabled: false,
      maxInputTokens: 8_230,
      onEvent: () => {},
      executeTool: vi.fn(),
    });

    expect(turn.history).toEqual([
      { role: 'user', text: 'new question' },
      { role: 'assistant', text: 'new answer' },
    ]);
    expect(turn.historyTurnsDropped).toBe(2);
  });
});
