import { describe, expect, it } from 'vitest';
import { budgetChatHistory } from '../context-budget';
import type { AiChatTurn } from '../types';

describe('budgetChatHistory', () => {
  it('keeps a recent complete suffix and drops oldest exchanges first', () => {
    const history: AiChatTurn[] = [
      { role: 'user', text: 'old question '.repeat(400) },
      { role: 'assistant', text: 'old answer '.repeat(400) },
      { role: 'user', text: 'recent question' },
      { role: 'assistant', text: 'recent answer' },
    ];
    const result = budgetChatHistory({
      system: 'system',
      user: 'current',
      history,
      maxInputTokens: 4_500,
      maxOutputTokens: 128,
    });

    expect(result.history).toEqual(history.slice(2));
    expect(result.historyTurnsDropped).toBe(2);
  });

  it('never keeps an assistant turn after dropping its user request', () => {
    const result = budgetChatHistory({
      system: 's',
      user: 'current',
      history: [
        { role: 'user', text: 'x'.repeat(700) },
        { role: 'assistant', text: 'short answer' },
      ],
      maxInputTokens: 4_200,
      maxOutputTokens: 64,
    });

    expect(result.history).toEqual([]);
    expect(result.historyTurnsDropped).toBe(2);
  });

  it('does not truncate the system prompt or current user request', () => {
    const result = budgetChatHistory({
      system: 's'.repeat(5_000),
      user: 'u'.repeat(5_000),
      history: [{ role: 'user', text: 'old' }, { role: 'assistant', text: 'answer' }],
      maxInputTokens: 100,
      maxOutputTokens: 50,
    });

    expect(result.history).toEqual([]);
    expect(result.estimatedInputCharacters).toBe(10_000);
    expect(result.inputCharacterBudget).toBe(0);
    expect(result.fixedInputOverBudgetCharacters).toBe(10_000);
  });
});
