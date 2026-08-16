/**
 * Prompt composition for the one-shot code editor embedded in CREV Inspector.
 * Shared language and platform facts come from canonical knowledge packs; this
 * module owns only editor-specific context, selection, and response policy.
 */

import type { AiRequestPayload } from './types';
import { KNOWLEDGE, type KnowledgePackId } from './knowledge';

const SELECTION_START = '«SELECTION_START»';
const SELECTION_END = '«SELECTION_END»';

const GENERIC_EDITOR_PERSONA = `You are the one-shot code editor inside CREV Inspector for the
Corporater BMP platform. Edit Extended Code (EC), CustomVisualization, and
TextElement code using the supplied source and object context.

Use the supplied language reference and source as authoritative. Never invent
missing workspace facts or silently replace a supplied reference. Return only
the requested artifact.`;

export const EC_EDITOR_PERSONA = `You are a one-shot editor for Corporater BMP Extended
Code. EC is a standalone proprietary programming language. Interpret every
token exclusively through the supplied EC specification, without analogy to
another language. Return only the requested code artifact.`;

export interface BuiltEditorPrompt {
  system: string;
  user: string;
  /** Which packs were selected (stable order). Exposed for tests. */
  packs: KnowledgePackId[];
}

/** Choose canonical knowledge packs in a fixed order for prompt-cache reuse. */
export function selectEditorPacks(payload: AiRequestPayload): KnowledgePackId[] {
  const packs: KnowledgePackId[] = ['bmpEditor'];
  if (payload.lang === 'extended') packs.push('ecEditor');
  const type = payload.context.objectType;
  if (type === 'CustomVisualization') packs.push('cvo');
  else if (type === 'TextElement') packs.push('htmlText');
  return packs;
}

function markSelection(payload: AiRequestPayload): string {
  const sel = payload.selection;
  if (!sel || sel.from === sel.to) return payload.code;
  const from = Math.max(0, Math.min(sel.from, payload.code.length));
  const to = Math.max(from, Math.min(sel.to, payload.code.length));
  return payload.code.slice(0, from) + SELECTION_START + payload.code.slice(from, to) + SELECTION_END + payload.code.slice(to);
}

export function buildEditorPrompt(payload: AiRequestPayload): BuiltEditorPrompt {
  const packs = selectEditorPacks(payload);
  const persona = payload.lang === 'extended' ? EC_EDITOR_PERSONA : GENERIC_EDITOR_PERSONA;
  const system = [persona, ...packs.map(p => KNOWLEDGE[p])].join('\n\n---\n\n');

  const ctx = payload.context;
  const lines: string[] = [];
  const identity: string[] = [];
  if (ctx.name) identity.push(ctx.name);
  if (ctx.objectType) identity.push(`(${ctx.objectType})`);
  if (identity.length) lines.push(`Object: ${identity.join(' ')}`);
  if (ctx.businessId && payload.lang !== 'extended') {
    lines.push(`Editor property owner businessId (context only; never substitute into source): ${ctx.businessId}`);
  }
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
    lines.push(`Begin immediately with EXACTLY ONE fenced code block containing only the revised replacement for ${target}; include no analysis or prose before or after it.`);
    lines.push('Do NOT quote, repeat, or show the original code first — output only the single, already-corrected version. Do not include the selection markers in your reply.');
    if (hasSelection) {
      lines.push('If the change requires edits beyond the selected lines, STILL return only the revised selected region — do NOT return the entire script. Assume the rest of the script is unchanged.');
      lines.push('Preserve the selection\'s existing leading indentation unless the task explicitly changes its nesting.');
    }
  }

  return { system, user: lines.join('\n'), packs };
}
