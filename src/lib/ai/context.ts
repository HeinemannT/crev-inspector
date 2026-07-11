/**
 * Context envelope — the ONE builder module shared by the command strip and
 * the chat tab. Chips map 1:1 to `envelope.sources`. Pointers, not payloads:
 * the envelope carries identity + the open code slot; the model dereferences
 * everything else (siblings, referenced objects, types, layout) with the
 * read-only tools.
 *
 * `renderContext` emits a compact, DETERMINISTIC tagged block: fixed attribute
 * order, sources in array order, volatile parts (the code bodies) last — so the
 * Anthropic prompt-cache prefix stays stable across turns. Per-type inclusion
 * decisions consult the `typeAffordances` / TYPE_META seam (widget-metadata.ts)
 * rather than a fresh `if (type === …)` ladder.
 */

import type { AiContextEnvelope, AiContextSource, AiLang } from './types';
import { typeAffordances, codeFieldsFor } from '../widget-metadata';

/** How many characters of a single slot body to inline before pointing the
 *  model at the read_object tool instead. Keeps the cached prefix bounded. */
const SLOT_INLINE_CAP = 6000;

/** Escape a value for an XML-ish attribute. Deterministic and lossless enough
 *  for identity strings (names can carry quotes / angle brackets). */
function attr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** The affordance hint for a type, as a stable comma list (code,references,flow).
 *  Empty string when the type carries none — driven purely by TYPE_META. */
function affordanceHint(type: string): string {
  const a = typeAffordances(type);
  const parts: string[] = [];
  if (a.code) parts.push('code');
  if (a.references) parts.push('references');
  if (a.flow) parts.push('flow');
  return parts.join(',');
}

/** Fenced-block language tag for a slot lang. `extended` is the EC label the
 *  rest of the tool uses for Extended Code fences. */
function fenceLang(lang: AiLang): string {
  return lang;
}

/** Serialize one source deterministically. Object identity first (stable
 *  attribute order), then — for an editor source — the slot meta and its code
 *  body (the only volatile part) last. */
function renderSource(src: AiContextSource): string {
  const o = src.object;
  const lines: string[] = [];
  // Fixed attribute order; omit-if-absent but never reorder.
  const objAttrs: string[] = [
    `type="${attr(o.type)}"`,
    `bid="${attr(o.businessId)}"`,
    `name="${attr(o.name)}"`,
    `rid="${attr(o.rid)}"`,
  ];
  if (o.templateBusinessId) objAttrs.push(`template="${attr(o.templateBusinessId)}"`);
  const affordances = affordanceHint(o.type);
  if (affordances) objAttrs.push(`affordances="${affordances}"`);
  // Known code slots for this type — a per-type inclusion decision straight
  // from the metadata seam, so the model knows what else it can read_object.
  const slots = codeFieldsFor(o.type).map(f => f.prop);
  if (slots.length) objAttrs.push(`slots="${slots.join(',')}"`);

  lines.push(`  <source kind="${src.kind}">`);
  lines.push(`    <object ${objAttrs.join(' ')}/>`);

  if (src.slot) {
    const s = src.slot;
    const slotAttrs: string[] = [`name="${attr(s.name)}"`, `lang="${attr(s.lang)}"`];
    if (s.selection && s.selection.from !== s.selection.to) {
      slotAttrs.push(`selection="${s.selection.from}-${s.selection.to}"`);
    }
    const truncated = s.code.length > SLOT_INLINE_CAP;
    const body = truncated ? s.code.slice(0, SLOT_INLINE_CAP) : s.code;
    if (truncated) slotAttrs.push('truncated="true"');
    lines.push(`    <slot ${slotAttrs.join(' ')}>`);
    lines.push('```' + fenceLang(s.lang));
    lines.push(body);
    lines.push('```');
    if (truncated) lines.push('(slot truncated — use read_object for the full body)');
    lines.push('    </slot>');
  }

  lines.push('  </source>');
  return lines.join('\n');
}

/** Render an envelope as a compact deterministic tagged block. Two calls with
 *  the same envelope produce byte-identical output. Returns '' for an envelope
 *  with no sources (the chat can still run tool-first with no attached context). */
export function renderContext(envelope: AiContextEnvelope): string {
  if (!envelope.sources.length) return '';
  const head = `<context server="${attr(envelope.server.id)}">`;
  const body = envelope.sources.map(renderSource).join('\n');
  return `${head}\n${body}\n</context>`;
}

/** Distinct object types across the envelope's sources, in first-seen order.
 *  Drives knowledge-pack selection for the chat system prompt. */
export function envelopeTypes(envelope: AiContextEnvelope): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of envelope.sources) {
    if (s.object.type && !seen.has(s.object.type)) { seen.add(s.object.type); out.push(s.object.type); }
  }
  return out;
}

/** Distinct slot languages across the envelope's sources, in first-seen order. */
export function envelopeLangs(envelope: AiContextEnvelope): AiLang[] {
  const seen = new Set<AiLang>();
  const out: AiLang[] = [];
  for (const s of envelope.sources) {
    if (s.slot && !seen.has(s.slot.lang)) { seen.add(s.slot.lang); out.push(s.slot.lang); }
  }
  return out;
}
