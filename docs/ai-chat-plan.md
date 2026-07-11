# AI Chat Tab + Command Strip + Card Restyle — Engineering Plan

Signed off 2026-07-10. Two implementation phases; this doc is the shared contract.
Visual source of truth: `experiments/ai-chat-tab.html` (draft v2, the three panel
states) and `experiments/ai-assistant-drafts.html` (Card A + Popover 1 "command
strip"). Design language: light Carbon-bones/Keyline, purple #8a3ffc = action,
tokens from src/styles/tokens.css, UI copy in plain English, no em dashes.

## Decisions (locked with the user)

- Ask answers go STRAIGHT to the chat tab (the editor's floating answer panel is
  retired for Ask; Edit stays inline with the merge diff).
- Chat conversation is SESSION-LIVED: it lives in the sidepanel page state and
  dies when the panel closes. No persistence.
- Tools from day one, READ-ONLY. All mutation flows through code blocks the user
  applies. No tool ever writes to BMP.
- Context = chips = envelope, 1:1. Pointers not payloads: the envelope carries
  identity + open code; the model dereferences with tools.
- Zero footprint: no API key => no AI tab, no sparkle, nothing.

## Shared contracts

### Context envelope (new module `src/lib/ai/context.ts`)

```ts
interface AiContextEnvelope {
  v: 1;
  server: { id: string; url: string };
  sources: AiContextSource[];            // 0..2, mirrors the chips exactly
}
interface AiContextSource {
  kind: 'editor' | 'selection';
  object: { rid: string; businessId: string; name: string; type: string;
            templateBusinessId?: string };
  slot?: { name: string; lang: 'extended'|'html'|'javascript'; code: string;
           selection?: { from: number; to: number } };   // editor kind only
}
```

- ONE builder module, consumed by both the command strip and the chat tab.
- `renderContext(envelope): string` emits a compact deterministic tagged block
  (stable key order — prompt-cache friendly), e.g.
  `<context><source kind="editor"><object type="CustomVisualization" bid="cvo_x" .../>`
  with the code inside a fenced section. Volatile parts last.
- Per-type inclusion decisions consult `typeAffordances`/TYPE_META
  (src/lib/widget-metadata.ts) — no new `if (type === ...)` ladders.
- The existing `AiRequestPayload` (strip Edit path) gains/embeds this envelope so
  strip and chat share one vocabulary. Migrate the current ad-hoc context field.

### Tools (SW-side, read-only, both dialects)

| Tool | Backs onto | Notes |
|---|---|---|
| `read_object` | existing object-pane fetch in bmp-client / handlers | input: businessId or rid; returns identity, properties (name/type/value), code slot names + sizes (not full code unless small) |
| `read_type` | whatever type introspection the SW already has (pane-schema, widget metadata, or an EC-based probe) | if no cheap live path exists, implement via a small EC snippet or return the static TYPE_META view; document the choice |
| `search_objects` | existing search used by Browse tab | input: query, optional type filter; cap ~25 hits (bid, name, type, rid) |
| `code_search` | existing code-search engine (src/codesearch engine in SW) | input: pattern; cap results (~30 matches: object bid/type/prop/line) |
| `read_layout` | Blueprint layout-service fetch | input: page rid; return a TRIMMED tree (types/names/spans), not style channels |
| `preview_ec` | existing EC preview handler (handlers/ec.ts path used by the editor Preview) | dry-run only; returns result or error text verbatim |

- Every tool result is truncated to a hard byte cap (~8–10KB) with an explicit
  `truncated: true` marker the model can see.
- Loop guard: max 8 tool calls per user turn; on cap, force a final answer.
- Tool JSON schemas defined once in `src/lib/ai/tools.ts`; execution dispatch in
  the SW (`src/lib/handlers/ai.ts` or a sibling `ai-tools.ts`).

### Dialect tool-calling (src/lib/ai/anthropic.ts + openai-compat.ts)

- Anthropic: `tools` param, streamed `tool_use` blocks (accumulate
  `input_json_delta`), reply with `tool_result` user turn, loop until end_turn.
- OpenAI-compat (OpenAI/DeepSeek/Grok): `tools` array (function calling),
  accumulate streamed `delta.tool_calls`, append assistant tool_calls message +
  `role:"tool"` results, loop.
- Both loops live behind one orchestrator API in `client.ts`:
  `streamChat({settings, system, history, envelope, onEvent, signal})` where
  onEvent emits: `text-delta`, `tool-start {name, summary}`, `tool-end {name,
  summary, ok}`, `done`, `error`. The SW forwards these as chat messages.

### Messaging (src/lib/messages.ts)

- `AI_CHAT_SEND { requestId, text, history: AiChatTurn[], envelope }`
- `AI_CHAT_EVENT { requestId, event }` (the onEvent union above)
- `AI_CHAT_CANCEL { requestId }`
- `AI_PREVIEW_CODE { requestId, code }` -> `{ ok, resultText }` (chat block
  Preview + Fix it)
- `AI_APPLY_PROPOSAL { code, target: { rid, slot } }` — routed to the open
  editor/studio which shows the standard merge-diff proposal.
- Handoff: `AI_CHAT_HANDOFF { text, quote?: {code, lines}, envelope }` — sent by
  the strip's Ask; SW opens the sidepanel (chrome.sidePanel.open pattern already
  exists for SELECT_OBJECT openPanel), the panel switches to the AI tab and
  submits it as a turn.
- History format `AiChatTurn = { role: 'user'|'assistant', text: string,
  via?: 'strip', quote?: ..., toolTrace?: {name, summary}[] }`. The panel owns
  the transcript and sends it fully on each AI_CHAT_SEND; the SW reconstructs
  provider messages (tool call details are NOT persisted across user turns —
  traces are display summaries only).

## Phase 1 (backend agent): foundation

Scope: everything under "Shared contracts" — context.ts, tools.ts + dispatch,
dialect tool-calling loops, client.ts orchestrator, messages, SW handlers
(AI_CHAT_SEND/EVENT/CANCEL, AI_PREVIEW_CODE, AI_APPLY_PROPOSAL routing,
AI_CHAT_HANDOFF plumbing SW-side), system prompt for chat (persona + knowledge
packs + tool guidance: "prefer tools over guessing; preview EC before presenting
it when a preview tool is available"), unit tests (envelope render determinism,
tool schema shapes, both dialects' tool-call accumulation against mocked SSE,
loop cap, truncation). Do NOT touch sidepanel UI, editor UI, or connect-tab.

## Phase 2 (UI agent): the three surfaces

1. **AI chat tab** (new `src/sidepanel/tabs/ai-tab.ts` + CSS): per draft v2 —
   right-aligned user bubbles (no "You"), full-width AI replies, quiet mono tool
   trace on a keyline, markdown rendering (reuse/extend the renderProse from
   ai-assist: headings, bold, inline code, fenced blocks, plus simple tables),
   code blocks with Apply / Preview / Copy + result strip + "Fix it" on error,
   composer with context chips bottom-left (dashed = following selection, pin
   toggle, detach x, amber "2 contexts" note on divergence), empty state with
   context-derived suggestions, streaming Stop button, Esc cancels. Tab is
   registered ONLY when AI is configured (listen to AI_CONFIG_CHANGED for live
   add/remove). Session state in the tab instance. Context chips: follow the
   Inspect selection via existing selection state; editor chip appears when an
   editor/studio is open (SW knows; expose a query or broadcast).
   AI reply divergence tag ("using editor · <bid>") when 2 sources attached.
2. **Command strip** (rework popover UI in `src/editor-core/ai-assist.ts`):
   single row [sparkle][mode chip, Tab toggles Ask/Edit][input][enter kbd],
   scope footer "selection · lines a–b · <model>" or "whole script · <model>".
   Anchor near the selection head with the nub; use the (already clamped)
   popover-anchor; verify alignment at all four viewport edges and with the
   editor scrolled. Ask => AI_CHAT_HANDOFF (strip closes; sidepanel opens on the
   AI tab with the question + quoted selection). Edit => unchanged inline merge
   flow. Remove the floating Ask answer panel; keep the edit status bar.
3. **Card A restyle** (`connect-tab.ts` + CSS): server-row-twin card, sparkle
   icon ~20px rendered directly (NO tile/box behind it), READY / UNTESTED pill,
   green inset keyline + last-test latency when verified (persist last test
   result {ok, ms} in the ai settings), row click / Edit expands the existing
   form. Keep all existing behavior (drafts, replace/remove, test).

## Constraints (both phases)

- Pre-existing uncommitted work on main — never revert/reformat; surgical edits.
- NO git write operations.
- src/lib/ai/knowledge/** is finished content — do not edit.
- Gates green before finishing: `npx tsc --noEmit`, `npm run lint`,
  `npm run build`, `npm test`.
- Match existing conventions (h()/render(), token CSS, Tab interface in
  sidepanel/tabs/tab-types.ts, existing streaming patterns).
