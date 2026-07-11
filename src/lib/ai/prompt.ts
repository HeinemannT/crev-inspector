/**
 * Prompt assembly + reply parsing. Provider-agnostic: builds a stable system
 * prefix (persona + selected knowledge packs, in a fixed order so the Anthropic
 * cache prefix stays stable) and a volatile user message (object context + slot
 * code + selection marker + instruction).
 */

import type { AiContextEnvelope, AiRequestPayload } from './types';
import { KNOWLEDGE, type KnowledgePackId } from './knowledge';
import { renderContext, envelopeTypes, envelopeLangs } from './context';

const SELECTION_START = '«SELECTION_START»';
const SELECTION_END = '«SELECTION_END»';

const PERSONA = `You are an expert coding assistant embedded in CREV Inspector, a tool for
inspecting and configuring the Corporater BMP platform. You help configurators
read, write, and debug the code that powers BMP widgets: Extended Code (EC)
expressions, and CustomVisualization / TextElement HTML and JavaScript.

Answer style: concise and correct. Explain only what is asked. Put any code in
fenced code blocks. Follow the platform rules in the reference material exactly —
they are not JavaScript/SQL conventions. When you are unsure, say so rather than
inventing syntax.`;

export interface BuiltPrompt {
  system: string;
  user: string;
  /** Which packs were selected (stable order). Exposed for tests. */
  packs: KnowledgePackId[];
}

/** Choose knowledge packs for a request, in a fixed order (so the cached prefix
 *  is stable). bmp-core always; ec for EC; cvo for CustomVisualization; html-text
 *  for TextElement. */
export function selectPacks(payload: AiRequestPayload): KnowledgePackId[] {
  const packs: KnowledgePackId[] = ['bmpCore'];
  if (payload.lang === 'extended') packs.push('ec');
  const type = payload.context.objectType;
  if (type === 'CustomVisualization') packs.push('cvo');
  else if (type === 'TextElement') packs.push('htmlText');
  return packs;
}

/** Insert selection markers into `code` around [from,to). Returns the code
 *  unchanged when there is no selection. */
function markSelection(payload: AiRequestPayload): string {
  const sel = payload.selection;
  if (!sel || sel.from === sel.to) return payload.code;
  const from = Math.max(0, Math.min(sel.from, payload.code.length));
  const to = Math.max(from, Math.min(sel.to, payload.code.length));
  return payload.code.slice(0, from) + SELECTION_START + payload.code.slice(from, to) + SELECTION_END + payload.code.slice(to);
}

export function buildPrompt(payload: AiRequestPayload): BuiltPrompt {
  const packs = selectPacks(payload);
  const system = [PERSONA, ...packs.map(p => KNOWLEDGE[p])].join('\n\n---\n\n');

  const ctx = payload.context;
  const lines: string[] = [];
  const identity: string[] = [];
  if (ctx.name) identity.push(ctx.name);
  if (ctx.objectType) identity.push(`(${ctx.objectType})`);
  if (ctx.businessId) identity.push(`businessId ${ctx.businessId}`);
  if (identity.length) lines.push(`Object: ${identity.join(' ')}`);
  if (ctx.templateBusinessId) lines.push(`Template: ${ctx.templateBusinessId}`);
  lines.push(`Editing property: ${ctx.slotName ?? 'code'} (language: ${payload.lang})`);

  if (ctx.otherSlots && ctx.otherSlots.length) {
    lines.push('Other properties on this object:');
    for (const s of ctx.otherSlots) {
      lines.push(`- ${s.name}:`);
      lines.push('```');
      lines.push(s.code);
      lines.push('```');
    }
  }
  if (ctx.dataSample) {
    lines.push('Live _data sample (truncated):');
    lines.push('```json');
    lines.push(ctx.dataSample);
    lines.push('```');
  }

  const hasSelection = !!payload.selection && payload.selection.from !== payload.selection.to;
  lines.push('');
  lines.push(`--- Current ${ctx.slotName ?? 'code'} ---`);
  lines.push('```');
  lines.push(markSelection(payload));
  lines.push('```');
  if (hasSelection) {
    lines.push(`The region between ${SELECTION_START} and ${SELECTION_END} is the user's current selection.`);
  }

  lines.push('');
  lines.push('--- Task ---');
  lines.push(payload.instruction.trim() || (payload.intent === 'edit' ? 'Improve the selected code.' : 'Explain the selected code.'));

  if (payload.intent === 'edit') {
    lines.push('');
    const target = hasSelection ? 'the selected region only' : 'the whole property';
    lines.push(`Return ONLY the revised replacement for ${target}, as EXACTLY ONE fenced code block containing just the final revised code, with no prose before or after it.`);
    lines.push('Do NOT quote, repeat, or show the original code first — output only the single, already-corrected version. Do not include the selection markers in your reply.');
  }

  return { system, user: lines.join('\n'), packs };
}

// ── Chat system prompt (tool-using conversation) ─────────────────

const CHAT_PERSONA = `You are an expert assistant embedded in CREV Inspector, a tool for inspecting
and configuring the Corporater BMP platform. You help configurators read,
write, and debug BMP configuration and the code that powers its widgets:
Extended Code (EC) expressions, and CustomVisualization / TextElement HTML and
JavaScript.

You have READ-ONLY tools that inspect the live workspace. Use them:
- Prefer calling a tool over guessing. When you are unsure what an object, type,
  property, or page contains, read it with a tool rather than inventing an answer.
- When the preview_ec tool is available, PREVIEW Extended Code with it before
  presenting it to the user, and fix anything the preview reports.
- Tools are read-only. You never mutate BMP; the user applies any change you
  propose by choosing to apply a code block.

Answer in Markdown. Keep answers concise and correct — explain only what is
asked. Put Extended Code in fenced blocks labeled \`extended\`; put HTML/JS in
fenced blocks labeled \`html\` / \`javascript\`. Follow the platform rules in the
reference material exactly — they are not JavaScript/SQL conventions. When you
are unsure, say so rather than inventing syntax.`;

/** Choose knowledge packs for a chat turn from the attached envelope, in a
 *  fixed order (stable cached prefix). bmp-core always; ec whenever any source
 *  edits Extended Code; cvo for CustomVisualization; html-text for TextElement.
 *  With no attached sources, ships bmp-core + ec (the common case). */
export function selectChatPacks(envelope: AiContextEnvelope): KnowledgePackId[] {
  const packs: KnowledgePackId[] = ['bmpCore'];
  const types = envelopeTypes(envelope);
  const langs = envelopeLangs(envelope);
  if (langs.includes('extended') || envelope.sources.length === 0) packs.push('ec');
  if (types.includes('CustomVisualization')) packs.push('cvo');
  if (types.includes('TextElement')) packs.push('htmlText');
  return packs;
}

export interface BuiltChatSystem {
  system: string;
  /** Which packs were selected (stable order). Exposed for tests. */
  packs: KnowledgePackId[];
}

/** Assemble the chat system prompt: persona + tool guidance (both baked into
 *  CHAT_PERSONA) + selected knowledge packs + the rendered context envelope
 *  (volatile part last). Deterministic for a given envelope. */
export function buildChatSystem(envelope: AiContextEnvelope): BuiltChatSystem {
  const packs = selectChatPacks(envelope);
  const parts = [CHAT_PERSONA, ...packs.map(p => KNOWLEDGE[p])];
  const context = renderContext(envelope);
  if (context) parts.push(context);
  return { system: parts.join('\n\n---\n\n'), packs };
}

export interface ExtractedCode {
  code: string | null;
  error?: string;
}

/** Pull the code out of an edit reply. With multiple fenced blocks, prefers the
 *  LAST one — models often quote the broken original first, then the fix. If the
 *  chosen block is byte-identical to the code we sent (`current`), falls back to
 *  the last block that differs. Falls back to the whole reply only when there is
 *  no fence and it does not read as prose. Mirrors the frame-side
 *  extractReplyCode (ai-assist.ts). */
export function extractCodeBlock(reply: string, current?: string): ExtractedCode {
  const fences = matchFences(reply);
  if (fences.length) {
    let chosen = fences[fences.length - 1];
    if (current != null && chosen === current) {
      for (let i = fences.length - 2; i >= 0; i--) {
        if (fences[i] !== current) { chosen = fences[i]; break; }
      }
    }
    return { code: chosen };
  }
  const trimmed = reply.trim();
  if (!trimmed) return { code: null, error: 'The reply was empty.' };
  if (looksLikeProse(trimmed)) return { code: null, error: 'The reply did not contain code.' };
  return { code: trimmed };
}

/** Every fenced code block's inner text, in document order. Language tag is
 *  optional; the closing fence sits at line start. */
function matchFences(reply: string): string[] {
  const re = /```[^\n]*\n([\s\S]*?)```/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(reply)) !== null) out.push(m[1].replace(/\n$/, ''));
  return out;
}

/** Heuristic: does this text read as natural language rather than code? Used
 *  only when there is NO fenced block, to decide fall-back-to-code vs error. */
export function looksLikeProse(text: string): boolean {
  const s = text.trim();
  if (!s) return true;
  if (/^(here('s| is)\b|the\s|this\s|sure\b|i\s|to\s|note\b|you\s|sorry\b)/i.test(s)) return true;
  const codeSignals = /[{};]|:=|=>|\bforEach\b|\bSELECT\b|\bfunction\b|<\/?[a-z]|\bconst\b|\blet\b|\breturn\b/i.test(s);
  const sentences = s.split(/[.!?](\s|$)/).filter(Boolean).length;
  if (!codeSignals && sentences >= 2) return true;
  return false;
}
