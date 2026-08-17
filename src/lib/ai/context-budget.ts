import type { AiChatTurn } from './types';

/** Conservative application ceiling for providers that do not publish a
 * configured input limit. This is intentionally smaller than modern flagship
 * context windows so Companion does not turn a long sidebar session into an
 * unexpectedly slow or expensive request. */
export const DEFAULT_CHAT_MAX_INPUT_TOKENS = 32_768;

/** Code, JSON, and EC tokenize more densely than ordinary English. Three
 * characters per token is a deliberately conservative dependency-free
 * estimate; exact billing remains provider telemetry. */
const ESTIMATED_CHARACTERS_PER_TOKEN = 3;
const TOOL_AND_MESSAGE_RESERVE_TOKENS = 4_096;
const TURN_OVERHEAD_CHARACTERS = 32;

export interface ContextBudgetResult {
  history: AiChatTurn[];
  historyTurnsDropped: number;
  estimatedInputCharacters: number;
  inputCharacterBudget: number;
  fixedInputOverBudgetCharacters: number;
}

/**
 * Keep the newest complete conversation suffix that fits the configured model
 * input budget. The system prompt and current user request are never silently
 * truncated. Tool schemas/results use the fixed reserve above; a future exact
 * tokenizer can replace this implementation without changing callers.
 */
export function budgetChatHistory(options: {
  system: string;
  user: string;
  history: readonly AiChatTurn[];
  maxInputTokens?: number;
  maxOutputTokens: number;
}): ContextBudgetResult {
  const maxInputTokens = Math.max(1, options.maxInputTokens ?? DEFAULT_CHAT_MAX_INPUT_TOKENS);
  const usableTokens = Math.max(
    0,
    maxInputTokens - Math.max(0, options.maxOutputTokens) - TOOL_AND_MESSAGE_RESERVE_TOKENS,
  );
  const inputCharacterBudget = usableTokens * ESTIMATED_CHARACTERS_PER_TOKEN;
  const fixedCharacters = options.system.length + options.user.length;
  let remaining = Math.max(0, inputCharacterBudget - fixedCharacters);
  const kept: AiChatTurn[] = [];

  for (let index = options.history.length - 1; index >= 0; index--) {
    const turn = options.history[index];
    const cost = turn.text.length + TURN_OVERHEAD_CHARACTERS;
    if (cost > remaining) break;
    kept.unshift(turn);
    remaining -= cost;
  }

  // Never send an assistant reply without the user request it answered.
  while (kept[0]?.role === 'assistant') kept.shift();

  return {
    history: kept,
    historyTurnsDropped: options.history.length - kept.length,
    estimatedInputCharacters: fixedCharacters
      + kept.reduce((sum, turn) => sum + turn.text.length + TURN_OVERHEAD_CHARACTERS, 0),
    inputCharacterBudget,
    fixedInputOverBudgetCharacters: Math.max(0, fixedCharacters - inputCharacterBudget),
  };
}
