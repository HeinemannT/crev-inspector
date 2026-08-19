/**
 * Thin conversation-protocol adapters. They own provider message history,
 * function/tool projection, tool-result turns, and assistant-turn persistence.
 * Retry, budgeting, terminal artifacts, Preview, and product policy stay in
 * the shared orchestrator.
 */

import { streamAnthropicTurn, type AnthropicContentBlock, type AnthropicMessage } from './anthropic';
import { streamOpenAiTurn, type OpenAiMessage } from './openai-compat';
import { scrubModelReasoning, ToolMarkupScrubber } from './scrub';
import { toAnthropicTools, toOpenAiTools, type ToolDef } from './tool-contracts';
import { toolResultForModel, type ToolCall, type ToolResult } from './tools';
import type { AiChatTurn, AiProviderTiming, AiTokenUsage } from './types';

export interface ProviderToolSelection {
  tools: ToolDef[];
  forceTool?: string;
  requireTool?: boolean;
}

export interface ProviderConversationTurn {
  text: string;
  toolCalls: ToolCall[];
  usage: AiTokenUsage;
  timing: AiProviderTiming;
  appendAssistant: () => void;
}

export interface ProviderConversation {
  requestTurn: (selection: ProviderToolSelection) => Promise<ProviderConversationTurn>;
  appendToolResults: (results: readonly { call: ToolCall; result: ToolResult }[]) => void;
  appendUserNote: (note: string) => void;
  appendFinalNote: (note: string) => void;
}

interface ConversationBaseOptions {
  baseUrl: string;
  model: string;
  maxTokens?: number;
  apiKey: string;
  system: string;
  history: readonly AiChatTurn[];
  user: string;
  signal?: AbortSignal;
}

export function createAnthropicConversation(options: ConversationBaseOptions): ProviderConversation {
  const messages: AnthropicMessage[] = options.history.map(turn => ({ role: turn.role, content: turn.text }));
  messages.push({ role: 'user', content: options.user });

  return {
    requestTurn: async selection => {
      const scrubber = new ToolMarkupScrubber();
      let text = '';
      const turn = await streamAnthropicTurn({
        baseUrl: options.baseUrl,
        model: options.model,
        maxTokens: options.maxTokens,
        apiKey: options.apiKey,
        system: options.system,
        messages,
        tools: toAnthropicTools(selection.tools),
        ...(selection.forceTool ? { forceTool: selection.forceTool } : {}),
        ...(selection.requireTool ? { requireTool: true } : {}),
        signal: options.signal,
        onText: delta => { text += scrubber.feed(delta); },
      });
      text += scrubber.flush();
      return {
        text: scrubModelReasoning(text),
        toolCalls: turn.toolCalls,
        usage: turn.usage,
        timing: turn.timing,
        appendAssistant: () => {
          if (turn.content.length) messages.push({ role: 'assistant', content: turn.content });
        },
      };
    },
    appendToolResults: results => {
      const content: AnthropicContentBlock[] = results.map(({ call, result }) => ({
        type: 'tool_result',
        tool_use_id: call.id,
        content: toolResultForModel(result),
        ...(result.isError ? { is_error: true } : {}),
      }));
      messages.push({ role: 'user', content });
    },
    appendUserNote: note => { messages.push({ role: 'user', content: note }); },
    appendFinalNote: note => {
      const last = messages[messages.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content)) {
        last.content.push({ type: 'text', text: note });
      } else {
        messages.push({ role: 'user', content: note });
      }
    },
  };
}

interface OpenAiConversationOptions extends ConversationBaseOptions {
  maxTokensParam?: 'max_tokens' | 'max_completion_tokens';
}

export function createOpenAiConversation(options: OpenAiConversationOptions): ProviderConversation {
  const messages: OpenAiMessage[] = [];
  if (options.system) messages.push({ role: 'system', content: options.system });
  for (const turn of options.history) messages.push({ role: turn.role, content: turn.text });
  messages.push({ role: 'user', content: options.user });

  return {
    requestTurn: async selection => {
      const scrubber = new ToolMarkupScrubber();
      let text = '';
      const turn = await streamOpenAiTurn({
        baseUrl: options.baseUrl,
        model: options.model,
        maxTokens: options.maxTokens,
        maxTokensParam: options.maxTokensParam,
        apiKey: options.apiKey,
        messages,
        tools: toOpenAiTools(selection.tools),
        ...(selection.forceTool ? { forceTool: selection.forceTool } : {}),
        ...(selection.requireTool ? { requireTool: true } : {}),
        signal: options.signal,
        onText: delta => { text += scrubber.feed(delta); },
      });
      text += scrubber.flush();
      return {
        text: scrubModelReasoning(text),
        toolCalls: turn.toolCalls,
        usage: turn.usage,
        timing: turn.timing,
        appendAssistant: () => { messages.push(turn.assistantMessage); },
      };
    },
    appendToolResults: results => {
      for (const { call, result } of results) {
        messages.push({ role: 'tool', tool_call_id: call.id, content: toolResultForModel(result) });
      }
    },
    appendUserNote: note => { messages.push({ role: 'user', content: note }); },
    appendFinalNote: note => { messages.push({ role: 'user', content: note }); },
  };
}
