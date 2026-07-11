# AI Coding Assistant — Engineering Plan

Status: approved for implementation (2026-07-10). Scope = P0 + P1 of the design
discussed in the CREV project: settings + provider layer + "Ask" (explain) in the
EC editor, then "Edit" with merge-diff accept/reject extended to the Studio.
P2 (fix-this-error button, live workspace grounding) and P3 (tool use, sidepanel
entry points) are explicitly OUT of scope for this iteration.

## 0. Ground rules

- Repo: `/home/tassilo/CREV/tools/crev-inspector` (Manifest V3 extension, vanilla
  TypeScript + hand-rolled `h()`/`render()` DOM helpers in `src/lib/dom.ts`,
  CodeMirror 6, Vite build, vitest suite ~1454 tests).
- **There is pre-existing uncommitted work on `main`** (service-worker.ts,
  handlers/layout.ts, handlers/profiles.ts, tab-awareness.ts, sw-context.ts,
  version-check.ts, BUGS.md, several tests). Do NOT revert, reformat, or commit
  any of it. Make surgical additions only. **Do not run `git commit` at all** —
  leave everything in the working tree for review.
- Gates that must stay green: `npx tsc --noEmit`, `npm run lint` (if present),
  `npm run build`, `npm test`. Run all four before declaring done.
- UI copy rules (hard requirements): English only, no em dashes, no AI-slop
  filler; plain accurate labels. Design language: light "Carbon bones, Keyline
  accent" — purple `#8a3ffc` is the only action color, amber = attention,
  40px rows, 1px dividers, uppercase 12/600 section labels, tokens from
  `src/styles/tokens.css` (never raw hex in sidepanel CSS; editor/studio CSS is
  token-driven too). Icons: Phosphor bold SVGs added to `src/lib/icons.ts`
  following the existing `ICON_*` pattern (use the Phosphor "sparkle" glyph).
- **Zero-footprint rule:** if no API key is configured, NOTHING of this feature
  renders anywhere — no icon, no menu item, no settings hint beyond the settings
  section itself.

## 1. Provider layer (service worker)

New directory `src/lib/ai/`.

### `src/lib/ai/types.ts`
- `type AiProviderId = 'anthropic' | 'openai' | 'deepseek' | 'grok'`
- `interface AiSettings { provider: AiProviderId; model: string; apiKeyEnc: string; }`
  (stored inside `crev_settings`, see §2)
- `interface AiChatMessage { role: 'user' | 'assistant'; content: string }`
- `interface AiRequestPayload { requestId: string; intent: 'ask' | 'edit';
  lang: 'extended' | 'html' | 'javascript'; code: string;
  selection: { from: number; to: number; text: string } | null;
  instruction: string; context: AiObjectContext }` — `AiObjectContext` carries
  objectType, businessId, name, templateBusinessId, slotName, otherSlots
  (name + truncated code), and for CVO mode a truncated `_data` sample.
- Stream event types for the reply channel: chunk / done / error.

### Provider dialects
- `src/lib/ai/anthropic.ts` — Anthropic Messages API.
  - `POST https://api.anthropic.com/v1/messages`, headers `x-api-key`,
    `anthropic-version: 2023-06-01`, `content-type: application/json`, plus
    `anthropic-dangerous-direct-browser-access: true` (harmless belt-and-braces
    for extension contexts).
  - Body: `{ model, max_tokens: 8192, stream: true, system: [...], messages: [...] }`.
    Do NOT set `temperature`/`top_p`/`thinking` (rejected or unneeded on current
    models). Default model: `claude-opus-4-8`.
  - **Prompt caching:** system is an array of text blocks; put
    `cache_control: {type: "ephemeral"}` on the LAST stable block (persona +
    knowledge pack). Volatile per-request object context goes into the user
    message, after the cached prefix. Note: short prefixes silently do not cache;
    that is fine.
  - SSE parse: `content_block_delta` events with `delta.type === 'text_delta'`
    carry text; `message_stop` ends; `event: error` / non-2xx carry
    `{error: {type, message}}` — surface message verbatim.
- `src/lib/ai/openai-compat.ts` — one dialect, three providers.
  - `POST {baseUrl}/chat/completions`, header `Authorization: Bearer <key>`.
  - Base URLs: openai `https://api.openai.com/v1`, deepseek
    `https://api.deepseek.com/v1`, grok `https://api.x.ai/v1`.
  - Body: `{ model, stream: true, messages: [{role:'system',...}, ...] }`.
  - SSE parse: `data: {json}` lines; text at `choices[0].delta.content`;
    terminates with `data: [DONE]`.
  - Suggested default models (editable, see §2): openai `gpt-5.2`, deepseek
    `deepseek-chat`, grok `grok-4`. Implement `listModels(provider, key)` via
    `GET {baseUrl}/models` to populate a datalist; on failure the text input
    still works. (Anthropic: static suggestion list `claude-opus-4-8`,
    `claude-sonnet-5`, `claude-haiku-4-5`; no listing call needed.)
- `src/lib/ai/client.ts` — orchestrator used by the SW handler:
  `streamCompletion(settings, payload, onChunk, signal): Promise<{text}>`.
  Builds the prompt (§4), picks the dialect, decrypts the key, streams,
  supports AbortController cancellation. The API key must never leave the SW.

### Manifest
- Add `optional_host_permissions` for `https://api.anthropic.com/*`,
  `https://api.openai.com/*`, `https://api.deepseek.com/*`, `https://api.x.ai/*`.
  (Check how the existing per-site BMP grant flow in `src/lib/site-access.ts`
  requests permissions and reuse the pattern.) Request the specific origin when
  a key is saved for that provider; surface a clear error in settings if denied.
  MV3 SW fetch with a granted host permission bypasses CORS.

## 2. Settings + key storage

- Extend `crev_settings` in `src/lib/settings.ts` with an optional `ai` field
  (shape from §1 types). Bump `schemaVersion` and add a migration exactly the
  way previous migrations are done in that file. Encrypt the key with the
  existing AES-GCM helpers in `src/lib/crypto.ts` (same approach as profile
  passwords). The session snapshot (`crev_settings_snapshot`) must carry an
  `aiConfigured: boolean` + provider + model but NEVER the key, mirroring the
  password-stripping that already happens.
- Connect tab UI (`src/sidepanel/tabs/connect-tab.ts`): new formal section
  "AI ASSISTANT" placed after Settings. Rows in the existing settings grammar:
  - Provider select: Anthropic / OpenAI / DeepSeek / Grok.
  - API key: masked input with Save; on save encrypt + store + request host
    permission for that provider origin. Show "Key saved" state (masked, with
    Replace/Remove), never echo the key back.
  - Model: text input with datalist suggestions (per-provider defaults above);
    for OpenAI-compatible providers add a quiet "Load model list" affordance
    that calls `listModels` through the SW.
  - Test: a quiet "Test connection" link that sends a 1-token-ish request
    ("Reply with OK") through the SW and shows inline green/red status text
    (no banners, per design language).
  - Remove key: clears `ai` config; feature disappears everywhere.
- Export a cheap `aiConfigured()` helper readable from editor/studio contexts
  (via the snapshot or a one-shot message) so surfaces know whether to render
  the entry points.

## 3. Messaging

- Extend the `InspectorMessage` union in `src/lib/types.ts`:
  - `AI_REQUEST` (payload from §1) — sent from editor/studio via the existing
    one-shot `sendRequest` OR a dedicated port if streaming needs it.
  - `AI_CHUNK { requestId, delta }`, `AI_DONE { requestId, usage? }`,
    `AI_ERROR { requestId, message }`, `AI_CANCEL { requestId }`.
- Streaming transport: study how `CODE_SEARCH_PROGRESS` streams today. If the
  editor/studio iframes have no long-lived port, open a dedicated
  `chrome.runtime.connect({name: 'ai'})` port from the iframe for the duration
  of one request; the SW handler writes chunk messages to it and closes on
  done/error. Cancellation: port disconnect or `AI_CANCEL` aborts the
  AbortController.
- New SW handler module `src/lib/handlers/ai.ts`, registered wherever the other
  handlers are (be careful: `service-worker.ts` has uncommitted edits — add the
  minimal wiring only).
- Rate-limit to ONE in-flight request per surface; a new request cancels the
  previous one.

## 4. Prompt assembly + knowledge packs

- `src/ai/knowledge/` (or `src/lib/ai/knowledge/`) with four markdown packs,
  bundled via Vite `?raw` imports. Size budget: <= ~6 KB each. AUTHOR THEM by
  distilling (do not copy wholesale):
  - `bmp-core.md` — ~10 lines: what Corporater BMP is, objects/templates/
    instances, businessId vs RID, that widgets render in a web portal.
  - `ec.md` — from `/home/tassilo/CREV/skills/extended-code/reference.md`:
    the non-negotiables (`:=` assignment, `forEach(item:` colon syntax,
    `t.{businessId}` never `o.{rid}`, `r.{id}` for resources, `MISSING` for
    null, `IF/THEN/ELSE/ENDIF` with mandatory ELSE, last expression is the
    output, `output(x.expression)` vs bare `.expression`, properties without
    parens vs methods with parens, `root` keyword) plus ~10 short canonical
    examples and the top Common Mistakes.
  - `cvo.md` — from `/home/tassilo/CREV/skills/bmp-platform/reference/cvo-design-strategy.md`:
    inherit fonts/colors from the widget container (LatoLatinWeb 12px #343536),
    BMP tokens (#f7f7f8 zebra, #f2faff hover, #e2e2e2 borders), Theme1 palette,
    `window.Highcharts` is global, no CDN/external fonts/dark themes, and the
    CVO `_data` contract as documented in the skill/studio code.
  - `html-text.md` — TextElement `text`/`longText` HTML bodies; BMP sanitizes
    on save (strips style properties like radius/gradients/shadows); keep
    markup simple; preview in the extension is raw.
- `src/lib/ai/prompt.ts` — builds: system = [persona block ("expert assistant
  embedded in a Corporater BMP inspection tool", answer style: concise, code
  in fenced blocks) + selected packs (bmp-core always; ec for lang 'extended';
  cvo for CVO studio; html-text for text mode)], then the user message =
  object context + full slot code + selection marker + instruction.
  - For `intent: 'edit'`: instruct the model to return ONLY the revised
    replacement for the selection (or whole slot when no selection), wrapped in
    a single fenced code block, no prose before or after. Parse defensively:
    take the first fenced block; if none, treat the whole reply as code only if
    it does not look like prose, else surface an error.
  - Pack selection order is stable so the Anthropic cache prefix stays stable.

## 5. UI — EC editor and Studio

Shared implementation where possible; both editors are `CodeSurface`
(`src/editor-core/code-surface.ts`) consumers, so put shared logic in a new
`src/editor-core/ai-assist.ts` if that fits the existing structure.

### Entry point
- One sparkle icon button in the action bar of `src/editor/editor.ts` and
  `src/studio/studio.ts`, rendered only when `aiConfigured()`. Keyboard
  shortcut `Mod-k` registered in the CodeMirror keymap (verify it does not
  collide with existing bindings; if it does, pick `Mod-i` and note it).
- Invoking opens a compact anchored popover (`src/lib/popover-anchor.ts`,
  same pattern as the editor "book" popover): a single-line text input +
  a small Ask | Edit segmented control (remember last choice per session) +
  Esc closes. Anchor near the selection when there is one, else near the icon.

### Ask flow
- Streams the answer into the existing output/console panel region:
  - Editor: render an "AI" block in the output panel area (follow the
    `ec-output.ts` rendering grammar): header row with "AI" label + model name
    + a close X, body = streamed text. Render markdown minimally: fenced code
    blocks as `<pre>` with mono font, inline code as `<code>`; no full md
    renderer, no new dependency.
  - Studio: same block inside the Console panel.
- While streaming: show a stop (cancel) affordance; Esc cancels too.

### Edit flow
- Send intent 'edit'; on completion parse the code block and show an inline
  diff against the selection using `@codemirror/merge` (already a dependency;
  see how `src/diff/` uses it — use `unifiedMergeView` or the simplest API that
  overlays the proposed change in the live editor). Provide Accept / Reject
  buttons (purple Accept, quiet Reject) in a small bar; Accept dispatches the
  replacement as a normal CodeMirror transaction (enters the existing dirty/
  undo/save pipeline untouched), Reject discards. Only one pending proposal at
  a time.
- If the model reply cannot be parsed as code, show the inline red status text
  in the popover/output ("The reply did not contain code") — no banner.

### Status/errors
- Errors (network, 401, refusal, permission denied) render as a single inline
  red status line carrying the provider's error message. Latency/model shown
  quietly in the AI block header.

## 6. Tests

Add vitest coverage in the existing style (`src/lib/__tests__/` etc.):
- Settings migration adds `ai` field; snapshot never contains the key.
- Anthropic + OpenAI-compat request shaping (mock `fetch`): correct URL,
  headers, body, model; SSE parsing of both dialects including error frames
  and `[DONE]`.
- Prompt builder: pack selection per lang/mode; edit-intent instruction; code
  fence extraction (fenced reply, bare-code reply, prose reply -> error).
- Message kinds compile into the union and the handler routes AI_CANCEL to
  abort.
- Do not attempt to test live APIs.

## 7. Verification checklist (agent must run)

1. `npx tsc --noEmit`
2. `npm run lint` (if the script exists)
3. `npm run build`
4. `npm test`
5. `git status` — confirm only intended files added/modified, nothing committed.

## Deliverable

A working-tree change set implementing all of the above, plus a short summary:
files added/changed, how to try it manually (load unpacked dist, configure key,
Ctrl+K in the EC editor), any deviations from this plan with reasons, and the
test/build results.
